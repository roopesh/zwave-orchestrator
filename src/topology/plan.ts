// Reconcile engine. `computePlan` -> what to ADD (with diagnostics). `computeTeardown` -> what
// to REMOVE for the managed links. Concrete groups are resolved PER DEVICE from the requested
// capabilities (or an explicit group override). Read-only.

import type { ZNode } from "../types.ts";
import type { AssociationTransport } from "../zwave/adapter.ts";
import type { GangSpec, Topology } from "./gangs.ts";
import { rawGroupsFor, wantedCapabilitiesFor } from "./gangs.ts";
import { CAPABILITIES, groupCapabilities, resolveGroups, type CapabilityId } from "./capabilities.ts";
import type { AssociationGroup } from "../types.ts";

export interface PlanAction {
  kind: "add" | "remove";
  gang: string;
  source: number;
  group: number;
  groupLabel: string;
  target: number;
  targetEndpoint?: number;
  /** Plain-language behavior this group provides — for describing stale links without group numbers. */
  capabilityTitle?: string;
}

export interface PlanIssue {
  severity: "error" | "warning";
  gang: string;
  node: number;
  code: "MISSING_NODE" | "LONG_RANGE" | "SECURITY_MISMATCH" | "NO_GROUP" | "NO_CAPABILITY" | "GROUP_FULL";
  message: string;
  remediation?: string;
}

export interface Plan {
  actions: PlanAction[];
  issues: PlanIssue[];
  satisfied: number;
}

const label = (n: ZNode) => n.name || n.product || `node ${n.id}`;
const capTitle = (c: CapabilityId) => CAPABILITIES.find((x) => x.id === c)?.title ?? c;
/** Human description of what a group does, for stale-link messaging (never shows group numbers). */
function groupBehavior(g: AssociationGroup): string {
  const caps = [...groupCapabilities(g)];
  return caps.length ? CAPABILITIES.filter((c) => caps.includes(c.id)).map((c) => c.title).join(" / ") : "an extra action";
}
const isLinkedTo = (list: { nodeId: number; endpoint?: number }[] | undefined, target: number) =>
  (list ?? []).some((t) => t.nodeId === target && (t.endpoint ?? 0) === 0);

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

/** Resolve the concrete group ids to wire on a companion (explicit override, else by capability).
 *  Pushes NO_CAPABILITY warnings for any requested capability the device can't provide. */
function groupsForCompanion(
  topo: Topology,
  gang: GangSpec,
  comp: { node: number },
  deviceGroups: Awaited<ReturnType<AssociationTransport["getAssociationGroups"]>>,
  src: ZNode,
  issues: PlanIssue[],
): number[] {
  const raw = rawGroupsFor(topo, gang, comp);
  if (raw) return raw;
  const wanted = wantedCapabilitiesFor(topo, gang, comp);
  const res = resolveGroups(deviceGroups, wanted);
  for (const cap of res.missing) {
    issues.push({
      severity: "warning",
      gang: gang.name,
      node: comp.node,
      code: "NO_CAPABILITY",
      message: `#${comp.node} "${label(src)}" can't "${capTitle(cap)}" the load by direct association — no group on this device provides it.`,
      remediation: `Pick a different behavior for this companion, or handle that action with a Home Assistant automation.`,
    });
  }
  return res.groups;
}

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
          severity: "error", gang: gang.name, node: comp.node, code: "LONG_RANGE",
          message: `#${comp.node} "${label(src)}" is on Z-Wave Long Range and cannot do direct associations.`,
          remediation: `Exclude and re-include #${comp.node} as a regular (mesh) Z-Wave device, then re-run. Until then, drive it via a Home Assistant automation.`,
        });
        continue;
      }
      if (src.securityClass != null && load.securityClass != null && src.securityClass !== load.securityClass) {
        issues.push({
          severity: "warning", gang: gang.name, node: comp.node, code: "SECURITY_MISMATCH",
          message: `#${comp.node} and load #${gang.load} report different security levels; the association may be silently unavailable.`,
          remediation: `Re-include both switches at the same security level, or verify the companion works after applying.`,
        });
      }

      const deviceGroups = await read.groupsOf(comp.node);
      const groupsById = new Map(deviceGroups.map((g) => [g.id, g]));
      const current = await read.assocOf(comp.node);

      for (const gid of groupsForCompanion(topo, gang, comp, deviceGroups, src, issues)) {
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
      if (!src || src.isLongRange) continue;
      const deviceGroups = await read.groupsOf(comp.node);
      const groupsById = new Map(deviceGroups.map((g) => [g.id, g]));
      const current = await read.assocOf(comp.node);
      for (const gid of groupsForCompanion(topo, gang, comp, deviceGroups, src, issues)) {
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

/** Stale links: companion->load associations that exist on non-lifeline groups OUTSIDE the desired
 *  set (e.g. left over after narrowing a gang's behavior). Remove actions to make live match intent. */
export async function computeStale(adapter: AssociationTransport, topo: Topology): Promise<Plan> {
  const nodes = await adapter.getNodes();
  const byId = new Map<number, ZNode>(nodes.map((n) => [n.id, n]));
  const read = makeReader(adapter);
  const actions: PlanAction[] = [];

  for (const gang of topo.gangs) {
    if (!byId.has(gang.load)) continue;
    for (const comp of gang.companions) {
      const src = byId.get(comp.node);
      if (!src || src.isLongRange) continue;
      const deviceGroups = await read.groupsOf(comp.node);
      const groupsById = new Map(deviceGroups.map((g) => [g.id, g]));
      const desired = new Set(groupsForCompanion(topo, gang, comp, deviceGroups, src, []));
      const current = await read.assocOf(comp.node);
      for (const [gidStr, list] of Object.entries(current)) {
        const gid = Number(gidStr);
        const g = groupsById.get(gid);
        if (!g || g.isLifeline || desired.has(gid)) continue;
        const stored = (list ?? []).find((t) => t.nodeId === gang.load && (t.endpoint ?? 0) === 0);
        if (stored) {
          actions.push({ kind: "remove", gang: gang.name, source: comp.node, group: gid, groupLabel: g.label, target: gang.load, targetEndpoint: stored.endpoint, capabilityTitle: groupBehavior(g) });
        }
      }
    }
  }
  return { actions, issues: [], satisfied: 0 };
}
