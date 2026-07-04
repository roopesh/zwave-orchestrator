// Transport-agnostic association adapter. Everything above this layer (planner, CLI, future
// web server / UI) depends only on these five methods, so an alternate transport (ZUI Socket.IO,
// MQTT) can be dropped in by implementing the same shape. Envelopes verified live against
// zwave-js-server 3.9.0 / schema 49.

import type { AssociationAddress, AssociationGroup, AssociationsByGroup, ZNode } from "../types.ts";
import { ZwaveClient } from "./client.ts";

export interface AssociationTransport {
  getNodes(): Promise<ZNode[]>;
  getAssociationGroups(addr: AssociationAddress): Promise<AssociationGroup[]>;
  getAssociations(addr: AssociationAddress): Promise<AssociationsByGroup>;
  addAssociations(addr: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void>;
  removeAssociations(addr: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void>;
}

export class ZWaveAdapter implements AssociationTransport {
  private readonly client: ZwaveClient;

  constructor(client: ZwaveClient) {
    this.client = client;
  }

  async getNodes(): Promise<ZNode[]> {
    const { nodes } = await this.client.startListening();
    return nodes.map((n: any) => ({
      id: n.nodeId,
      name: n.name || "",
      location: n.location || "",
      product: [n.deviceConfig?.manufacturer, n.deviceConfig?.label].filter(Boolean).join(" "),
      status: n.status,
      isController: Boolean(n.isControllerNode),
      isLongRange: n.protocol === 1,
      securityClass: n.highestSecurityClass ?? undefined,
    }));
  }

  async getAssociationGroups(addr: AssociationAddress): Promise<AssociationGroup[]> {
    const res = await this.client.request("controller.get_association_groups", {
      nodeId: addr.nodeId,
      endpoint: addr.endpoint ?? 0,
    });
    return Object.entries<any>(res.groups).map(([id, g]) => ({
      id: Number(id),
      label: g.label,
      maxNodes: g.maxNodes,
      isLifeline: g.isLifeline,
      multiChannel: g.multiChannel,
      profile: g.profile,
    }));
  }

  async getAssociations(addr: AssociationAddress): Promise<AssociationsByGroup> {
    const res = await this.client.request("controller.get_associations", {
      nodeId: addr.nodeId,
      endpoint: addr.endpoint ?? 0,
    });
    const out: AssociationsByGroup = {};
    for (const [gid, list] of Object.entries<any>(res.associations)) {
      out[Number(gid)] = (list as any[]).map((t) => ({ nodeId: t.nodeId, endpoint: t.endpoint }));
    }
    return out;
  }

  async addAssociations(addr: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void> {
    await this.client.request("controller.add_associations", {
      nodeId: addr.nodeId,
      endpoint: addr.endpoint ?? 0,
      group,
      associations: targets.map((t) => ({ nodeId: t.nodeId, endpoint: t.endpoint })),
    });
  }

  async removeAssociations(addr: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void> {
    await this.client.request("controller.remove_associations", {
      nodeId: addr.nodeId,
      endpoint: addr.endpoint ?? 0,
      group,
      associations: targets.map((t) => ({ nodeId: t.nodeId, endpoint: t.endpoint })),
    });
  }
}
