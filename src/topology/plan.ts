// Reconcile engine: compute the desired association mesh from the topology and diff it against
// the controller's live state. `computePlan` -> what to ADD (with diagnostics). `computeTeardown`
// -> what to REMOVE for the managed links (used for teardown / remove-then-recreate). Read-only.

import type { ZNode } from "../types.ts";
import type { AssociationTransport } from "../zwave/adapter.ts";
import type { Topology } from "./gangs.ts";
import { controlGroupsFor } from "./gangs.ts";

export interface PlanAction {
  kind: "add" | "remove";
  gang: string;
  source: number; // companion node
  group: number;
  groupLabel: string;
  target: number; // load node
  /** For removes: the endpoint of the stored association, so we match its exact type
   *  (node association vs endpoint association). Undefined = node association. */
  targetEndpoint?: number;
}

export interface PlanIssue {
  severity: "error" | "warning";
  gang: string;
  node: number;
  code: "MISSING_NODE" | "LONG_RANGE" | "SECURITY_MISMATCH" | "NO_GROUP" | "GROUP_FULL";
  message: string;
  remediation?: string;
}

export interface Plan {
  actions: PlanAction[];
  issues: PlanIssue[];
  satisfied: number; // desired links already in place (add-mode only)
}

function label(n: ZNode): string {
  return n.name || n.product || `node ${n.id}`;
}

/** Per-source read cache so repeated companions across gangs don't re-query the controller. */
function makeReader(adapter: AssociationTransport) {
  const groupCache = new Map<number, Awaited<ReturnType<AssociationTransport["getAssociationGroups"]>>>();
  const assocCache = new Map<number, Awaited<ReturnType<AssociationTransport["getAssociations"]>>>();
  return {
    async groupsOf(id: number) {
      if (!groupCache.has(id)) groupCache.set(id, await adapter.getAssociationGroups({ nodeId: id }));
      return groupCache.get(id)!;
    },
    async assocOf(id: number) {
      if (!assocCache.has(id)) assocCache.set(id, await adapter.getAssociations({ nodeId: id }));
      return assocCache.get(id)!;
    },
  };
}

const isLinkedTo = (list: { nodeId: number; endpoint?: number }[] | undefined, target: number) =>
  (list ?? []).some((t) => t.nodeId === target && (t.endpoint ?? 0) === 0);

export async function computePlan(adapter: AssociationTransport, topo: Topology): Promise<Plan> {
  const nodes = await adapter.getNodes();
  const byId = new Map<number, ZNode>(nodes.map((n) => [n.id, n]));
  const read = makeReader(adapter);

  const actions: PlanAction[] = [];
  const issues: PlanIssue[] = [];
  let satisfied = 0;

  for (const gang of topo.gangs) {
    const load = byId.get(gang.load);
    if (!load) {
      issues.push({ severity: "error", gang: gang.name, node: gang.load, code: "MISSING_NODE", message: `load node ${gang.load} not found on the mesh` });
      continue;
    }

    for (const comp of gang.companions) {
      const src = byId.get(comp.node);
      if (!src) {
        issues.push({ severity: "error", gang: gang.name, node: comp.node, code: "MISSING_NODE", message: `companion node ${comp.node} not found on the mesh` });
        continue;
      }
      if (src.isLongRange) {
        issues.push({
          severity: "error",
          gang: gang.name,
          node: comp.node,
          code: "LONG_RANGE",
          message: `#${comp.node} "${label(src)}" is on Z-Wave Long Range and cannot do direct associations.`,
          remediation: `Exclude and re-include #${comp.node} as a regular (mesh) Z-Wave device, then re-run. Until then, drive it via a Home Assistant automation.`,
        });
        continue;
      }
      if (src.securityClass != null && load.securityClass != null && src.securityClass !== load.securityClass) {
        issues.push({
          severity: "warning",
          gang: gang.name,
          node: comp.node,
          code: "SECURITY_MISMATCH",
          message: `#${comp.node} and load #${gang.load} report different security classes (${src.securityClass} vs ${load.securityClass}); the association may be silently unavailable.`,
          remediation: `Re-include both switches at the same security level, or verify direct association still works after applying.`,
        });
      }

      const groupsById = new Map((await read.groupsOf(comp.node)).map((g) => [g.id, g]));
      const current = await read.assocOf(comp.node);
      for (const gid of controlGroupsFor(topo, gang, comp)) {
        const g = groupsById.get(gid);
        if (!g) {
          issues.push({ severity: "error", gang: gang.name, node: comp.node, code: "NO_GROUP", message: `#${comp.node} does not advertise association group ${gid}` });
          continue;
        }
        if (isLinkedTo(current[gid], gang.load)) {
          satisfied++;
          continue;
        }
        if ((current[gid] ?? []).length >= g.maxNodes) {
          issues.push({ severity: "warning", gang: gang.name, node: comp.node, code: "GROUP_FULL", message: `group ${gid} "${g.label}" on #${comp.node} is full (max ${g.maxNodes})` });
          continue;
        }
        actions.push({ kind: "add", gang: gang.name, source: comp.node, group: gid, groupLabel: g.label, target: gang.load });
      }
    }
  }
  return { actions, issues, satisfied };
}

/** Remove actions for the managed links (companion->load on control groups) that currently exist. */
export async function computeTeardown(adapter: AssociationTransport, topo: Topology): Promise<Plan> {
  const nodes = await adapter.getNodes();
  const byId = new Map<number, ZNode>(nodes.map((n) => [n.id, n]));
  const read = makeReader(adapter);

  const actions: PlanAction[] = [];
  const issues: PlanIssue[] = [];

  for (const gang of topo.gangs) {
    if (!byId.has(gang.load)) continue;
    for (const comp of gang.companions) {
      const src = byId.get(comp.node);
      if (!src || src.isLongRange) continue; // LR can't hold these anyway
      const groupsById = new Map((await read.groupsOf(comp.node)).map((g) => [g.id, g]));
      const current = await read.assocOf(comp.node);
      for (const gid of controlGroupsFor(topo, gang, comp)) {
        const g = groupsById.get(gid);
        if (!g) continue;
        const stored = (current[gid] ?? []).find((t) => t.nodeId === gang.load && (t.endpoint ?? 0) === 0);
        if (stored) {
          actions.push({ kind: "remove", gang: gang.name, source: comp.node, group: gid, groupLabel: g.label, target: gang.load, targetEndpoint: stored.endpoint });
        }
      }
    }
  }
  return { actions, issues, satisfied: 0 };
}
