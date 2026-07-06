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

export interface ParamPlan {
  actions: ParamAction[];
  issues: ParamIssue[];
  satisfied: number;
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

export async function computeParamPlan(
  adapter: AssociationTransport,
  doc: PolicyDoc,
  topo?: Topology,
  paramsByNode?: Record<number, ConfigParam[]>,
): Promise<ParamPlan> {
  const params = paramsByNode ?? (await adapter.getConfigParams());
  const actions: ParamAction[] = [];
  const issues: ParamIssue[] = [];
  let satisfied = 0;

  for (const pol of doc.policies) {
    for (const node of resolveTargets(pol, topo, issues)) {
      const list = params[node] ?? [];
      for (const s of pol.settings) {
        const def = list.find((p) => sameSetting(p, s.param, s.key));
        if (!def) {
          issues.push({ severity: "warning", policy: pol.name, node, param: s.param, key: s.key, code: "NO_PARAM", message: `#${node} has no setting ${settingName(s.param, s.key)} — not applicable to this device.` });
          continue;
        }
        if (!def.writeable) {
          issues.push({ severity: "warning", policy: pol.name, node, param: s.param, key: s.key, code: "READ_ONLY", message: `"${def.label}" on #${node} is read-only.` });
          continue;
        }
        if (def.value === s.value) {
          satisfied++;
          continue;
        }
        actions.push({ policy: pol.name, node, param: s.param, key: s.key, label: def.label, current: def.value, currentLabel: optLabel(def, def.value), desired: s.value, desiredLabel: optLabel(def, s.value) });
      }
    }
  }
  return { actions, issues, satisfied };
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
