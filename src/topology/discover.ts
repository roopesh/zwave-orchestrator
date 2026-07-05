// Discover gangs from an EXISTING install: read the live associations and reverse-engineer the
// load→companion structure, so someone who already wired associations by hand can adopt the tool.
//
// The tricky part is direction: an association A→B could mean "A is a companion of load B", but a
// load that broadcasts its level back to companions (LED-sync / full-mesh) also produces B→A. We
// use in-degree to tell them apart: the real load is the node that MANY switches point to, so an
// edge S→T is only treated as companion→load when in-degree(S) <= in-degree(T) — reverse/broadcast
// links (from a high-in-degree load out to a companion) are dropped.

import type { AssociationTransport } from "../zwave/adapter.ts";
import { CAPABILITIES, groupCapabilities, type CapabilityId } from "./capabilities.ts";

export interface DiscoveredGang {
  name: string;
  load: number;
  companions: number[];
  capabilities: CapabilityId[];
}

interface Edge {
  source: number;
  target: number;
  caps: Set<CapabilityId>;
}

export async function discoverGangs(adapter: AssociationTransport): Promise<DiscoveredGang[]> {
  const nodes = await adapter.getNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const controllers = new Set(nodes.filter((n) => n.isController).map((n) => n.id));

  // Pass 1: collect control edges source→target (with the capabilities the source sends).
  const edges: Edge[] = [];
  for (const n of nodes) {
    if (n.isController || n.isLongRange) continue;
    let groups, assoc;
    try {
      groups = await adapter.getAssociationGroups({ nodeId: n.id });
      assoc = await adapter.getAssociations({ nodeId: n.id });
    } catch {
      continue;
    }
    const gById = new Map(groups.map((g) => [g.id, g]));
    const perTarget = new Map<number, Set<CapabilityId>>();
    for (const [gidStr, targets] of Object.entries(assoc)) {
      const g = gById.get(Number(gidStr));
      if (!g || g.isLifeline) continue;
      const caps = groupCapabilities(g);
      if (!caps.size) continue;
      for (const t of targets ?? []) {
        if (controllers.has(t.nodeId) || t.nodeId === n.id || !byId.has(t.nodeId)) continue;
        if (!perTarget.has(t.nodeId)) perTarget.set(t.nodeId, new Set());
        for (const c of caps) perTarget.get(t.nodeId)!.add(c);
      }
    }
    for (const [target, caps] of perTarget) edges.push({ source: n.id, target, caps });
  }

  // in-degree = number of distinct sources pointing to a node.
  const inSources = new Map<number, Set<number>>();
  for (const e of edges) {
    if (!inSources.has(e.target)) inSources.set(e.target, new Set());
    inSources.get(e.target)!.add(e.source);
  }
  const deg = (id: number) => inSources.get(id)?.size ?? 0;
  const edgeCap = new Map<string, number>();
  for (const e of edges) edgeCap.set(`${e.source}|${e.target}`, e.caps.size);

  // Pass 2: for each edge S→T (S=companion of load T), keep it unless the reverse edge is the
  // "better" companion→load. Decide by in-degree (a load has more distinct sources), then by
  // capability count (a companion sends full control; a load only broadcasts level back for LED
  // sync, so it sends fewer), then by id — so a symmetric LED-synced pair yields one gang, not two.
  const loads = new Map<number, Map<number, Set<CapabilityId>>>();
  for (const e of edges) {
    const dS = deg(e.source), dT = deg(e.target);
    const cS = e.caps.size, cT = edgeCap.get(`${e.target}|${e.source}`) ?? 0;
    const keep = dS !== dT ? dS < dT : cS !== cT ? cS > cT : e.source < e.target;
    if (!keep) continue;
    if (!loads.has(e.target)) loads.set(e.target, new Map());
    loads.get(e.target)!.set(e.source, e.caps);
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
