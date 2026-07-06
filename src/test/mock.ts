// In-memory mock of the Z-Wave adapter for tests — no controller needed. Seeded with canned
// nodes / association groups / associations so the planner, stale, and discovery logic can be
// asserted deterministically.

import type { AssociationAddress, AssociationGroup, AssociationsByGroup, ConfigParam, ZNode } from "../types.ts";
import type { AssociationTransport } from "../zwave/adapter.ts";

/** Inovelli-style groups with issuedCommands, so capability derivation works in tests. */
export const INOVELLI_GROUPS: AssociationGroup[] = [
  { id: 1, label: "Lifeline", maxNodes: 8, isLifeline: true, multiChannel: true, issuedCommands: { 90: [1] } },
  { id: 2, label: "Basic Set", maxNodes: 8, isLifeline: false, multiChannel: true, issuedCommands: { 32: [1] } },
  { id: 3, label: "Multilevel Switch Set", maxNodes: 8, isLifeline: false, multiChannel: true, issuedCommands: { 38: [1] } },
  { id: 4, label: "Multilevel Switch Start/Stop", maxNodes: 8, isLifeline: false, multiChannel: true, issuedCommands: { 38: [4, 5] } },
  { id: 5, label: "Basic Set Double-tap", maxNodes: 8, isLifeline: false, multiChannel: true, issuedCommands: { 32: [1] } },
];

export interface MockNode {
  id: number;
  name?: string;
  location?: string;
  product?: string;
  isController?: boolean;
  isLongRange?: boolean;
  groups?: AssociationGroup[];
  assoc?: AssociationsByGroup;
  params?: ConfigParam[];
}

export class MockAdapter implements AssociationTransport {
  nodes: MockNode[];
  constructor(nodes: MockNode[]) {
    this.nodes = nodes;
  }
  private n(id: number) {
    return this.nodes.find((x) => x.id === id);
  }
  async getNodes(): Promise<ZNode[]> {
    return this.nodes.map((n) => ({
      id: n.id,
      name: n.name ?? "",
      location: n.location ?? "",
      product: n.product ?? "Inovelli VZW31-SN",
      isController: !!n.isController,
      isLongRange: !!n.isLongRange,
    }));
  }
  async getAssociationGroups(a: AssociationAddress): Promise<AssociationGroup[]> {
    const node = this.n(a.nodeId);
    if (!node || node.isController) return [];
    return node.groups ?? INOVELLI_GROUPS;
  }
  async getAssociations(a: AssociationAddress): Promise<AssociationsByGroup> {
    return structuredClone(this.n(a.nodeId)?.assoc ?? {});
  }
  async addAssociations(a: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void> {
    const node = this.n(a.nodeId);
    if (!node) return;
    node.assoc ??= {};
    node.assoc[group] ??= [];
    for (const t of targets) if (!node.assoc[group].some((x) => x.nodeId === t.nodeId)) node.assoc[group].push({ nodeId: t.nodeId, endpoint: t.endpoint });
  }
  async removeAssociations(a: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void> {
    const node = this.n(a.nodeId);
    if (!node?.assoc?.[group]) return;
    node.assoc[group] = node.assoc[group].filter((x) => !targets.some((t) => t.nodeId === x.nodeId && (t.endpoint ?? 0) === (x.endpoint ?? 0)));
  }
  async getConfigParams(): Promise<Record<number, ConfigParam[]>> {
    const out: Record<number, ConfigParam[]> = {};
    for (const n of this.nodes) out[n.id] = n.params ?? [];
    return out;
  }
  async setConfigValue(nodeId: number, param: number, value: number, key?: number): Promise<number> {
    const p = this.n(nodeId)?.params?.find((x) => x.param === param && x.key === key);
    if (p) p.value = value;
    return 255;
  }
}

/** Full companion→load wiring on the given groups (defaults to 2/3/4). */
export function wired(load: number, groups: number[] = [2, 3, 4]): AssociationsByGroup {
  const out: AssociationsByGroup = {};
  for (const g of groups) out[g] = [{ nodeId: load }];
  return out;
}
