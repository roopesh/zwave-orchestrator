// Reconcile engine for device parameter policies: diff each policy's desired settings against the
// live per-device values, emit set-actions + diagnostics, apply with re-read verification.
// Settings address whole parameters or bitmask sub-parameters via (param, key). Policies may
// target explicit devices and/or gangs (resolved from the topology at plan time by role).

import type { ConfigParam } from "../types.ts";
import type { AssociationTransport } from "../zwave/adapter.ts";
import type { PolicyDoc, Policy } from "./policies.ts";
import type { Topology } from "./gangs.ts";

export interface ParamAction {
  policy: string;
  node: number;
  param: number;
  key?: number;
  label: string;
  current: number | null;
  currentLabel: string;
  desired: number;
  desiredLabel: string;
}

export interface ParamIssue {
  severity: "warning";
  policy: string;
  node: number;
  param: number;
  key?: number;
  code: "NO_PARAM" | "READ_ONLY" | "NO_GANG";
  message: string;
}

/** A (node, param, key) that ≥2 policies set to DIFFERENT values. The highest-priority policy
 *  (lowest list index) wins; the rest are recorded here so the overlap is never silent. */
export interface ParamOverride {
  node: number;
  param: number;
  key?: number;
  label: string;
  winner: string; // policy name that wins
  winnerValue: number;
  winnerValueLabel: string;
  losers: { policy: string; value: number; valueLabel: string }[];
}

export interface ParamPlan {
  actions: ParamAction[];
  issues: ParamIssue[];
  satisfied: number;
  overrides: ParamOverride[];
}

const optLabel = (p: ConfigParam | undefined, v: number | null): string => {
  if (v == null) return "?";
  const o = p?.options?.find((x) => x.value === v);
  return o ? o.label : String(v);
};

const sameSetting = (p: ConfigParam, param: number, key?: number) => p.param === param && p.key === key;
export const settingName = (param: number, key?: number) => `p${param}${key !== undefined ? `[${key}]` : ""}`;

/** Resolve a policy's effective node targets: explicit ids + gang references (by role). */
export function resolveTargets(policy: Policy, topo: Topology | undefined, issues?: ParamIssue[]): number[] {
  const out = new Set<number>(policy.targets);
  for (const gt of policy.gangTargets ?? []) {
    const gang = topo?.gangs.find((g) => g.name === gt.gang);
    if (!gang) {
      issues?.push({ severity: "warning", policy: policy.name, node: 0, param: 0, code: "NO_GANG", message: `gang "${gt.gang}" no longer exists — its devices were skipped.` });
      continue;
    }
    if (gt.role !== "companions") out.add(gang.load);
    if (gt.role !== "load") for (const c of gang.companions) out.add(c.node);
  }
  return [...out].sort((a, b) => a - b);
}

export interface ParamPlanOptions {
  /** Re-issue every declared setting even where the current read already matches — for "redeploy". */
  force?: boolean;
}

export async function computeParamPlan(
  adapter: AssociationTransport,
  doc: PolicyDoc,
  topo?: Topology,
  paramsByNode?: Record<number, ConfigParam[]>,
  opts: ParamPlanOptions = {},
): Promise<ParamPlan> {
  const { force = false } = opts;
  const params = paramsByNode ?? (await adapter.getConfigParams());
  const actions: ParamAction[] = [];
  const issues: ParamIssue[] = [];
  const overrides: ParamOverride[] = [];
  let satisfied = 0;

  // Collect every (node, param, key) each policy wants to set, in priority order (list index 0 =
  // highest priority). When policies overlap on the same setting, the highest-priority one wins —
  // so the outcome is deterministic instead of "whichever policy happened to sync last".
  type Claim = { node: number; param: number; key?: number; entries: { policy: string; pri: number; value: number }[] };
  const claims = new Map<string, Claim>();
  doc.policies.forEach((pol, pri) => {
    for (const node of resolveTargets(pol, topo, issues)) {
      for (const s of pol.settings) {
        const k = `${node}|${s.param}|${s.key ?? ""}`;
        let c = claims.get(k);
        if (!c) claims.set(k, (c = { node, param: s.param, key: s.key, entries: [] }));
        c.entries.push({ policy: pol.name, pri, value: s.value });
      }
    }
  });

  for (const c of claims.values()) {
    const def = (params[c.node] ?? []).find((p) => sameSetting(p, c.param, c.key));
    if (!def) {
      for (const e of c.entries) issues.push({ severity: "warning", policy: e.policy, node: c.node, param: c.param, key: c.key, code: "NO_PARAM", message: `#${c.node} has no setting ${settingName(c.param, c.key)} — not applicable to this device.` });
      continue;
    }
    if (!def.writeable) {
      for (const e of c.entries) issues.push({ severity: "warning", policy: e.policy, node: c.node, param: c.param, key: c.key, code: "READ_ONLY", message: `"${def.label}" on #${c.node} is read-only.` });
      continue;
    }
    const winner = c.entries.reduce((a, b) => (b.pri < a.pri ? b : a)); // lowest index wins; first listed breaks ties
    const losers = c.entries.filter((e) => e !== winner && e.value !== winner.value);
    if (losers.length) {
      overrides.push({
        node: c.node, param: c.param, key: c.key, label: def.label,
        winner: winner.policy, winnerValue: winner.value, winnerValueLabel: optLabel(def, winner.value),
        losers: losers.map((l) => ({ policy: l.policy, value: l.value, valueLabel: optLabel(def, l.value) })),
      });
    }
    const already = def.value === winner.value;
    if (already) satisfied++;
    if (already && !force) continue;
    actions.push({ policy: winner.policy, node: c.node, param: c.param, key: c.key, label: def.label, current: def.value, currentLabel: optLabel(def, def.value), desired: winner.value, desiredLabel: optLabel(def, winner.value) });
  }
  return { actions, issues, satisfied, overrides };
}

export interface ParamResult {
  action: ParamAction;
  ok: boolean;
  status?: number;
  error?: string;
}

export async function applyParamActions(adapter: AssociationTransport, actions: ParamAction[]): Promise<ParamResult[]> {
  const results: ParamResult[] = [];
  for (const a of actions) {
    try {
      const status = await adapter.setConfigValue(a.node, a.param, a.desired, a.key);
      results.push({ action: a, ok: status === 255 || status === 254, status });
    } catch (e: any) {
      results.push({ action: a, ok: false, error: e?.message ?? String(e) });
    }
  }
  // Verify by re-reading — a successful status OR a matching read-back both count as applied.
  const after = await adapter.getConfigParams();
  for (const r of results) {
    const def = (after[r.action.node] ?? []).find((p) => sameSetting(p, r.action.param, r.action.key));
    const matches = def ? def.value === r.action.desired : false;
    r.ok = r.ok || matches;
    if (!r.ok && !r.error) r.error = `not applied (status ${r.status}, read-back ${def?.value})`;
  }
  return results;
}
