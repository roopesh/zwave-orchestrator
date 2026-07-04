// Write path: apply PlanActions (add or remove) to the controller, then verify each by re-reading.
// Idempotent by construction — actions only exist for links whose state was wrong at plan time.

import type { AssociationTransport } from "../zwave/adapter.ts";
import type { PlanAction } from "./plan.ts";

export interface ApplyResult {
  action: PlanAction;
  ok: boolean;
  error?: string;
}

export async function applyActions(adapter: AssociationTransport, actions: PlanAction[]): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const a of actions) {
    try {
      const addr = { nodeId: a.source };
      if (a.kind === "add") {
        await adapter.addAssociations(addr, a.group, [{ nodeId: a.target }]);
      } else {
        // Match the stored association's exact shape (node vs endpoint association).
        const target = a.targetEndpoint != null ? { nodeId: a.target, endpoint: a.targetEndpoint } : { nodeId: a.target };
        await adapter.removeAssociations(addr, a.group, [target]);
      }

      const now = await adapter.getAssociations(addr);
      const present = (now[a.group] ?? []).some((t) => t.nodeId === a.target && (t.endpoint ?? 0) === 0);
      const ok = a.kind === "add" ? present : !present;
      results.push({ action: a, ok, error: ok ? undefined : `verify failed: target ${present ? "present" : "absent"} after ${a.kind}` });
    } catch (e: any) {
      results.push({ action: a, ok: false, error: e?.message ?? String(e) });
    }
  }
  return results;
}
