// Device registry ("devices.yaml") — the on-demand spine for adoption + change detection.
// No events/daemon: each entry records a device's disposition (whether it belongs in the Groups
// UI) and a fingerprint (product|location|name) so re-pairs and removals can be detected by
// diffing the registry against the live mesh whenever the tool is opened or refreshed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { ZNode } from "../types.ts";
import type { Topology } from "./gangs.ts";
import type { PolicyDoc } from "./policies.ts";

export type Disposition = "adopted" | "ignored";

export interface DeviceEntry {
  id: number;
  fingerprint: string;
  disposition: Disposition;
}

export interface DeviceRegistry {
  devices: DeviceEntry[];
}

/** Stable-ish identity for a device: what the user set + the product. */
export function fingerprintOf(n: { product?: string; location?: string; name?: string }): string {
  return [n.product ?? "", n.location ?? "", n.name ?? ""].join("|");
}

export function loadDevices(path: string): DeviceRegistry {
  if (!existsSync(path)) return { devices: [] };
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as any;
  return {
    devices: (raw.devices ?? []).map((d: any) => ({
      id: Number(d.id),
      fingerprint: String(d.fingerprint ?? ""),
      disposition: d.disposition === "ignored" ? "ignored" : "adopted",
    })),
  };
}

export function saveDevices(path: string, reg: DeviceRegistry): void {
  writeFileSync(path, "# Managed by zwave-associations (device registry: adoption + fingerprints).\n\n" + stringify({ devices: reg.devices }));
}

export interface DeviceStatus {
  id: number;
  disposition: Disposition | "new"; // "new" = untriaged (not yet in the registry)
  changed: boolean; // fingerprint differs from what's stored (device re-paired / renamed under this id)
  groupEligible: boolean; // whether it should appear in the Groups UI
}

export interface DeviceAnalysis {
  status: Record<number, DeviceStatus>;
  removed: DeviceEntry[]; // in the registry but no longer on the mesh
  repairCandidates: { from: DeviceEntry; to: number }[]; // a removed adopted device whose fingerprint reappeared under a new id
}

type NodeWithSupport = ZNode & { supports?: string[] };

/** Diff the registry against the live mesh. New association-capable switches are eligible by
 *  default (so nothing breaks out of the box); sensors/plugs stay out until explicitly adopted. */
export function analyzeDevices(nodes: NodeWithSupport[], registry: DeviceRegistry): DeviceAnalysis {
  const byId = new Map(registry.devices.map((d) => [d.id, d]));
  const meshIds = new Set(nodes.map((n) => n.id));
  const newByFingerprint = new Map<string, number>();
  const status: Record<number, DeviceStatus> = {};

  for (const n of nodes) {
    if (n.isController) continue;
    const fp = fingerprintOf(n);
    const entry = byId.get(n.id);
    const capable = (n.supports ?? []).length > 0;
    let disposition: DeviceStatus["disposition"];
    let changed = false;
    if (!entry) {
      disposition = "new";
      newByFingerprint.set(fp, n.id);
    } else {
      disposition = entry.disposition;
      changed = entry.fingerprint !== fp;
    }
    const groupEligible = disposition === "adopted" || (disposition === "new" && capable);
    status[n.id] = { id: n.id, disposition, changed, groupEligible };
  }

  const removed = registry.devices.filter((d) => !meshIds.has(d.id));
  const repairCandidates: { from: DeviceEntry; to: number }[] = [];
  for (const r of removed) {
    const to = newByFingerprint.get(r.fingerprint);
    if (to != null && r.disposition === "adopted") repairCandidates.push({ from: r, to });
  }

  return { status, removed, repairCandidates };
}

/** Re-pair remap: point every reference to `from` at `to` across gangs, policies, and the
 *  registry (in place). Used when a device was excluded and re-included under a new node id. */
export function remapNodeId(from: number, to: number, newFingerprint: string, topo: Topology, policies: PolicyDoc, registry: DeviceRegistry): void {
  for (const g of topo.gangs) {
    if (g.load === from) g.load = to;
    g.companions = g.companions.map((c) => (c.node === from ? { ...c, node: to } : c));
  }
  for (const p of policies.policies) p.targets = p.targets.map((t) => (t === from ? to : t));
  const old = registry.devices.find((d) => d.id === from);
  registry.devices = registry.devices.filter((d) => d.id !== from && d.id !== to);
  registry.devices.push({ id: to, fingerprint: newFingerprint, disposition: old?.disposition ?? "adopted" });
}
