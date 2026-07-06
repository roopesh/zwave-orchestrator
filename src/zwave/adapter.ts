// Transport-agnostic association adapter. Everything above this layer (planner, CLI, future
// web server / UI) depends only on these five methods, so an alternate transport (ZUI Socket.IO,
// MQTT) can be dropped in by implementing the same shape. Envelopes verified live against
// zwave-js-server 3.9.0 / schema 49.

import type { AssociationAddress, AssociationGroup, AssociationsByGroup, ConfigParam, ZNode } from "../types.ts";
import { ZwaveClient } from "./client.ts";

const CONFIGURATION_CC = 112;

export interface AssociationTransport {
  getNodes(): Promise<ZNode[]>;
  getAssociationGroups(addr: AssociationAddress): Promise<AssociationGroup[]>;
  getAssociations(addr: AssociationAddress): Promise<AssociationsByGroup>;
  addAssociations(addr: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void>;
  removeAssociations(addr: AssociationAddress, group: number, targets: AssociationAddress[]): Promise<void>;
  getConfigParams(): Promise<Record<number, ConfigParam[]>>;
  setConfigValue(nodeId: number, param: number, value: number, key?: number): Promise<number>;
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
      issuedCommands: g.issuedCommands,
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

  // --- Configuration parameters (Command Class 112) ---

  /** Read every node's config parameters (label, current value, named options) from one state
   *  dump. Includes bitmask/"partial" parameters (numeric propertyKey) as their own entries —
   *  each sub-field carries its own metadata (label/options), so they behave like any setting. */
  async getConfigParams(): Promise<Record<number, ConfigParam[]>> {
    const { nodes } = await this.client.startListening();
    const out: Record<number, ConfigParam[]> = {};
    for (const n of nodes) {
      const params: ConfigParam[] = (n.values ?? [])
        .filter((v: any) => v.commandClass === CONFIGURATION_CC && v.metadata && typeof v.property === "number" && (v.propertyKey === undefined || typeof v.propertyKey === "number"))
        .map((v: any) => ({
          param: v.property,
          key: typeof v.propertyKey === "number" ? v.propertyKey : undefined,
          label: v.metadata.label ?? `Parameter ${v.property}`,
          description: v.metadata.description,
          value: v.value ?? null,
          default: v.metadata.default,
          min: v.metadata.min,
          max: v.metadata.max,
          unit: v.metadata.unit,
          writeable: v.metadata.writeable !== false,
          options: v.metadata.states
            ? Object.entries(v.metadata.states).map(([k, l]) => ({ value: Number(k), label: String(l) })).sort((a, b) => a.value - b.value)
            : undefined,
        }))
        .sort((a: ConfigParam, b: ConfigParam) => a.param - b.param || (a.key ?? -1) - (b.key ?? -1));
      out[n.nodeId] = params;
    }
    return out;
  }

  /** Set one config parameter (pass `key` for a bitmask sub-parameter).
   *  Returns the SetValueStatus (255/254 = success, 1 = working). */
  async setConfigValue(nodeId: number, param: number, value: number, key?: number): Promise<number> {
    const valueId: Record<string, unknown> = { commandClass: CONFIGURATION_CC, endpoint: 0, property: param };
    if (key !== undefined) valueId.propertyKey = key;
    const res = await this.client.request("node.set_value", { nodeId, valueId, value });
    return res?.result?.status ?? -1;
  }
}
