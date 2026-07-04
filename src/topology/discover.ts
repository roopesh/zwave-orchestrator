// Discover gangs from an EXISTING install: read the live associations and reverse-engineer the
// load→companion structure, so someone who already wired associations by hand can adopt the tool
// and manage them going forward. Companion→load edges (a companion associates TO the load switch);
// we group by load, and infer behaviors from the groups in use.

import type { AssociationTransport } from "../zwave/adapter.ts";
import { CAPABILITIES, groupCapabilities, type CapabilityId } from "./capabilities.ts";

export interface DiscoveredGang {
  name: string;
  load: number;
  companions: number[];
  capabilities: CapabilityId[];
}

export async function discoverGangs(adapter: AssociationTransport): Promise<DiscoveredGang[]> {
  const nodes = await adapter.getNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const controllers = new Set(nodes.filter((n) => n.isController).map((n) => n.id));

  // load id -> (companion id -> set of capabilities it sends toward the load)
  const loads = new Map<number, Map<number, Set<CapabilityId>>>();

  for (const n of nodes) {
    if (n.isController || n.isLongRange) continue;
    let groups, assoc;
    try {
      groups = await adapter.getAssociationGroups({ nodeId: n.id });
      assoc = await adapter.getAssociations({ nodeId: n.id });
    } catch {
      continue; // no Association CC
    }
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    for (const [gidStr, targets] of Object.entries(assoc)) {
      const g = groupsById.get(Number(gidStr));
      if (!g || g.isLifeline) continue;
      const caps = groupCapabilities(g);
      if (!caps.size) continue;
      for (const t of targets ?? []) {
        if (controllers.has(t.nodeId) || t.nodeId === n.id || !byId.has(t.nodeId)) continue;
        if (!loads.has(t.nodeId)) loads.set(t.nodeId, new Map());
        const comps = loads.get(t.nodeId)!;
        if (!comps.has(n.id)) comps.set(n.id, new Set());
        for (const c of caps) comps.get(n.id)!.add(c);
      }
    }
  }

  const order = CAPABILITIES.map((c) => c.id);
  const out: DiscoveredGang[] = [];
  for (const [loadId, comps] of loads) {
    const load = byId.get(loadId)!;
    const capSet = new Set<CapabilityId>();
    for (const s of comps.values()) for (const c of s) capSet.add(c);
    const name = load.location ? `${load.location} ${load.name || "load"}`.trim() : load.name || `Gang ${loadId}`;
    out.push({ name, load: loadId, companions: [...comps.keys()].sort((a, b) => a - b), capabilities: order.filter((c) => capSet.has(c)) });
  }
  return out.sort((a, b) => a.load - b.load);
}
