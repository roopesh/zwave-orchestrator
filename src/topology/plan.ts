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

/** The load's "level" (brightness) group + its current members — used for LED-sync links. */
async function levelGroupOfLoad(read: ReturnType<typeof makeReader>, loadId: number) {
  const groups = await read.groupsOf(loadId);
  const gid = resolveGroups(groups, ["level"]).groups[0];
  if (gid == null) return null;
  const group = groups.find((g) => g.id === gid)!;
  const current = (await read.assocOf(loadId))[gid] ?? [];
  return { gid, group, current };
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

    // LED sync: wire load -> each companion on the level group so all bars track together.
    if (gang.ledSync) {
      const ctx = await levelGroupOfLoad(read, gang.load);
      if (!ctx) {
        issues.push({ severity: "warning", gang: gang.name, node: gang.load, code: "NO_CAPABILITY", message: `#${gang.load} "${label(load)}" has no brightness group to broadcast for LED sync.` });
      } else {
        for (const comp of gang.companions) {
          const src = byId.get(comp.node);
          if (!src || src.isLongRange) continue;
          if (isLinkedTo(ctx.current, comp.node)) { satisfied++; continue; }
          if (ctx.current.length >= ctx.group.maxNodes) { issues.push({ severity: "warning", gang: gang.name, node: gang.load, code: "GROUP_FULL", message: `the load's brightness group is full (max ${ctx.group.maxNodes}) — can't add more LED-sync links` }); break; }
          actions.push({ kind: "add", gang: gang.name, source: gang.load, group: ctx.gid, groupLabel: ctx.group.label, target: comp.node });
        }
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

    // LED sync: remove the load -> companion level links too.
    if (gang.ledSync) {
      const ctx = await levelGroupOfLoad(read, gang.load);
      if (ctx) for (const comp of gang.companions) {
        const stored = ctx.current.find((t) => t.nodeId === comp.node && (t.endpoint ?? 0) === 0);
        if (stored) actions.push({ kind: "remove", gang: gang.name, source: gang.load, group: ctx.gid, groupLabel: ctx.group.label, target: comp.node, targetEndpoint: stored.endpoint });
      }
    }
  }
  return { actions, issues, satisfied: 0 };
}

/** Stale links: any control association *touching a managed load* that the topology doesn't want —
 *  a removed companion's link, an orphaned load→companion broadcast, a link to a removed device, or
 *  a link left over after narrowing a gang. Authoritative: it inspects the whole mesh, not just the
 *  companions still listed, so removing a companion (or a device) actually un-associates on Sync. */
export async function computeStale(adapter: AssociationTransport, topo: Topology): Promise<Plan> {
  const nodes = await adapter.getNodes();
  const byId = new Map<number, ZNode>(nodes.map((n) => [n.id, n]));
  const read = makeReader(adapter);
  const actions: PlanAction[] = [];

  // Managed loads + the desired directed control links: `${source}|${group}|${target}`.
  const loadIds = new Set<number>();
  const loadName = new Map<number, string>();
  for (const g of topo.gangs) if (byId.has(g.load)) { loadIds.add(g.load); loadName.set(g.load, g.name); }

  const desired = new Set<string>();
  for (const gang of topo.gangs) {
    if (!byId.has(gang.load)) continue;
    for (const comp of gang.companions) {
      const src = byId.get(comp.node);
      if (!src || src.isLongRange) continue;
      const groups = await read.groupsOf(comp.node);
      for (const gid of groupsForCompanion(topo, gang, comp, groups, src, [])) desired.add(`${comp.node}|${gid}|${gang.load}`);
    }
    if (gang.ledSync) {
      const ctx = await levelGroupOfLoad(read, gang.load);
      if (ctx) for (const comp of gang.companions) {
        const c = byId.get(comp.node);
        if (c && !c.isLongRange) desired.add(`${gang.load}|${ctx.gid}|${comp.node}`);
      }
    }
  }

  // Scan every device's control associations; anything touching a managed load that isn't desired is stale.
  for (const n of nodes) {
    if (n.isController || n.isLongRange) continue;
    const groups = await read.groupsOf(n.id);
    const gById = new Map(groups.map((g) => [g.id, g]));
    const assoc = await read.assocOf(n.id);
    for (const [gidStr, list] of Object.entries(assoc)) {
      const gid = Number(gidStr);
      const g = gById.get(gid);
      if (!g || g.isLifeline || groupCapabilities(g).size === 0) continue;
      for (const t of list ?? []) {
        if (!loadIds.has(t.nodeId) && !loadIds.has(n.id)) continue; // only manage links involving a load
        if (desired.has(`${n.id}|${gid}|${t.nodeId}`)) continue;
        const gang = loadName.get(t.nodeId) ?? loadName.get(n.id) ?? "";
        actions.push({ kind: "remove", gang, source: n.id, group: gid, groupLabel: g.label, target: t.nodeId, targetEndpoint: t.endpoint, capabilityTitle: groupBehavior(g) });
      }
    }
  }
  return { actions, issues: [], satisfied: 0 };
}
