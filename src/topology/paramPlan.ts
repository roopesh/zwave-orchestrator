// Reconcile engine for device parameter policies: diff each policy's desired settings against the
// live per-device values, emit set-actions + diagnostics, apply with re-read verification.

import type { ConfigParam } from "../types.ts";
import type { ZWaveAdapter } from "../zwave/adapter.ts";
import type { PolicyDoc } from "./policies.ts";

export interface ParamAction {
  policy: string;
  node: number;
  param: number;
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
  code: "NO_PARAM" | "READ_ONLY";
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

export async function computeParamPlan(
  adapter: ZWaveAdapter,
  doc: PolicyDoc,
  paramsByNode?: Record<number, ConfigParam[]>,
): Promise<ParamPlan> {
  const params = paramsByNode ?? (await adapter.getConfigParams());
  const actions: ParamAction[] = [];
  const issues: ParamIssue[] = [];
  let satisfied = 0;

  for (const pol of doc.policies) {
    for (const node of pol.targets) {
      const byNum = new Map((params[node] ?? []).map((p) => [p.param, p]));
      for (const s of pol.settings) {
        const def = byNum.get(s.param);
        if (!def) {
          issues.push({ severity: "warning", policy: pol.name, node, param: s.param, code: "NO_PARAM", message: `#${node} has no parameter ${s.param} — not applicable to this device.` });
          continue;
        }
        if (!def.writeable) {
          issues.push({ severity: "warning", policy: pol.name, node, param: s.param, code: "READ_ONLY", message: `parameter ${s.param} "${def.label}" on #${node} is read-only.` });
          continue;
        }
        if (def.value === s.value) {
          satisfied++;
          continue;
        }
        actions.push({ policy: pol.name, node, param: s.param, label: def.label, current: def.value, currentLabel: optLabel(def, def.value), desired: s.value, desiredLabel: optLabel(def, s.value) });
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

export async function applyParamActions(adapter: ZWaveAdapter, actions: ParamAction[]): Promise<ParamResult[]> {
  const results: ParamResult[] = [];
  for (const a of actions) {
    try {
      const status = await adapter.setConfigValue(a.node, a.param, a.desired);
      results.push({ action: a, ok: status === 255 || status === 254, status });
    } catch (e: any) {
      results.push({ action: a, ok: false, error: e?.message ?? String(e) });
    }
  }
  // Verify by re-reading — the device confirms via a Configuration Report; a successful status
  // OR a matching read-back both count as applied.
  const after = await adapter.getConfigParams();
  for (const r of results) {
    const def = (after[r.action.node] ?? []).find((p) => p.param === r.action.param);
    const matches = def ? def.value === r.action.desired : false;
    r.ok = r.ok || matches;
    if (!r.ok && !r.error) r.error = `not applied (status ${r.status}, read-back ${def?.value})`;
  }
  return results;
}
