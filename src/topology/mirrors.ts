// "Mirror" topology: a set of co-equal LOADED dimmers that mirror each other (unlike a gang,
// which is one load + dumb companions). Every member associates to every other member on the
// resolved control groups, so pressing/dimming any one drives them all. One member is the
// "primary" (the switch you expose to HA): forwarding is enabled only on it so hub-driven changes
// relay to the rest, while the others keep forwarding off — which makes the whole thing loop-free
// by construction (see the closet write-up). Reconciled declaratively like gangs/policies.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { AssociationTransport } from "../zwave/adapter.ts";
import type { ConfigParam, ZNode } from "../types.ts";
import type { PlanAction } from "./plan.ts";
import type { ParamAction } from "./paramPlan.ts";
import { resolveGroups, type CapabilityId } from "./capabilities.ts";

export interface MirrorSpec {
  name: string;
  members: number[]; // co-equal loaded dimmers
  primary: number; // the HA-exposed member (forwarding on); must be one of members
  capabilities: CapabilityId[]; // which behaviours to mirror (onoff / level / dim)
}

/** Cross-protocol "hub" mirror: two+ Home Assistant `light` entities kept in sync through a HA
 *  blueprint automation (not Z-Wave associations). Used when the lights can't associate directly
 *  — e.g. a Zigbee dimmer and a Z-Wave dimmer. The tool owns a HA automation per hub mirror. */
export interface HubMirror {
  name: string;
  entities: string[]; // HA light entity_ids (≥2), kept in sync with each other
  tolerance: number; // brightness tolerance 0–255 (absorbs cross-protocol rounding)
}

export interface MirrorDoc { mirrors: MirrorSpec[]; hubMirrors?: HubMirror[]; }

export function loadMirrors(path: string): MirrorDoc {
  if (!existsSync(path)) return { mirrors: [], hubMirrors: [] };
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as any;
  return {
    mirrors: (raw.mirrors ?? []).map((m: any) => ({
      name: String(m.name ?? ""),
      members: (m.members ?? []).map(Number),
      primary: Number(m.primary),
      capabilities: (m.capabilities ?? ["onoff", "level", "dim"]) as CapabilityId[],
    })),
    hubMirrors: (raw.hubMirrors ?? []).map((h: any) => ({
      name: String(h.name ?? ""),
      entities: (h.entities ?? []).map(String),
      tolerance: h.tolerance != null ? Number(h.tolerance) : 4,
    })),
  };
}

export function saveMirrors(path: string, doc: MirrorDoc): void {
  const out = {
    mirrors: doc.mirrors.map((m) => ({ name: m.name, members: m.members, primary: m.primary, capabilities: m.capabilities })),
    ...(doc.hubMirrors?.length ? { hubMirrors: doc.hubMirrors.map((h) => ({ name: h.name, entities: h.entities, tolerance: h.tolerance })) } : {}),
  };
  writeFileSync(path, "# Managed by zwave-associations (mirror groups: co-equal dimmers that track each other).\n\n" + stringify(out));
}

// Match the two Inovelli param-59 bits by label, so it works per device rather than by number.
const findSendLocal = (list: ConfigParam[]) => list.find((p) => p.writeable && /send/i.test(p.label) && /local/i.test(p.label));
const findForward = (list: ConfigParam[]) => list.find((p) => p.writeable && /forward/i.test(p.label) && /z.?wave/i.test(p.label));

const label = (n?: ZNode) => n?.name || n?.product || `node ${n?.id}`;
const optLabel = (def: ConfigParam, v: number) => def.options?.find((o) => o.value === v)?.label ?? String(v);
const mkParam = (mirror: string, node: number, def: ConfigParam, desired: number): ParamAction => ({
  policy: mirror, node, param: def.param, key: def.key, label: def.label,
  current: def.value, currentLabel: optLabel(def, def.value ?? 0), desired, desiredLabel: optLabel(def, desired),
});

export interface MirrorIssue {
  severity: "error" | "warning";
  mirror: string;
  node: number;
  code: "MISSING_NODE" | "TOO_FEW" | "NO_CAPABILITY" | "NO_SETTING" | "BAD_PRIMARY";
  message: string;
}
export interface MirrorPlan {
  actions: PlanAction[]; // associations to add (member -> member)
  paramActions: ParamAction[]; // param-59 send-local / forward fixes
  issues: MirrorIssue[];
  satisfied: number;
}

/** Diff each mirror against the live mesh: what associations/params are missing to make every
 *  member drive every other, with forwarding only on the primary. Additive (never removes here —
 *  deleting a mirror uses computeMirrorTeardown). */
export async function computeMirrorPlan(adapter: AssociationTransport, doc: MirrorDoc): Promise<MirrorPlan> {
  const nodes = await adapter.getNodes();
  const byId = new Map<number, ZNode>(nodes.map((n) => [n.id, n]));
  const params = await adapter.getConfigParams();
  const actions: PlanAction[] = [];
  const paramActions: ParamAction[] = [];
  const issues: MirrorIssue[] = [];
  let satisfied = 0;

  for (const mir of doc.mirrors) {
    const present = mir.members.filter((m) => byId.has(m));
    for (const m of mir.members) if (!byId.has(m)) issues.push({ severity: "error", mirror: mir.name, node: m, code: "MISSING_NODE", message: `#${m} isn't on the mesh.` });
    if (present.length < 2) { issues.push({ severity: "warning", mirror: mir.name, node: 0, code: "TOO_FEW", message: `"${mir.name}" needs at least two switches on the mesh.` }); continue; }
    if (!present.includes(mir.primary)) issues.push({ severity: "warning", mirror: mir.name, node: mir.primary, code: "BAD_PRIMARY", message: `The HA-primary #${mir.primary} isn't a member on the mesh.` });

    const groupsOf = new Map<number, number[]>();
    const glabel = new Map<number, Map<number, string>>();
    for (const m of present) {
      const dg = await adapter.getAssociationGroups({ nodeId: m });
      const res = resolveGroups(dg, mir.capabilities);
      groupsOf.set(m, res.groups);
      glabel.set(m, new Map(dg.map((g) => [g.id, g.label])));
      for (const cap of res.missing) issues.push({ severity: "warning", mirror: mir.name, node: m, code: "NO_CAPABILITY", message: `#${m} "${label(byId.get(m))}" can't ${cap} its peers by association.` });
    }

    // Associations: member -> every other member, on that member's resolved groups.
    for (const m of present) {
      const cur = await adapter.getAssociations({ nodeId: m });
      for (const other of present) {
        if (other === m) continue;
        for (const g of groupsOf.get(m) ?? []) {
          if ((cur[g] ?? []).some((t) => t.nodeId === other && (t.endpoint ?? 0) === 0)) { satisfied++; continue; }
          actions.push({ kind: "add", gang: mir.name, source: m, group: g, groupLabel: glabel.get(m)?.get(g) ?? String(g), target: other });
        }
      }
    }

    // Params: send-local on for everyone; forward on for the primary only.
    for (const m of present) {
      const list = params[m] ?? [];
      const sl = findSendLocal(list);
      if (!sl) issues.push({ severity: "warning", mirror: mir.name, node: m, code: "NO_SETTING", message: `#${m} has no "send local commands" setting — physical presses won't mirror.` });
      else if (sl.value !== 1) paramActions.push(mkParam(mir.name, m, sl, 1));
      else satisfied++;

      const fw = findForward(list);
      const want = m === mir.primary ? 1 : 0;
      if (!fw) { if (want) issues.push({ severity: "warning", mirror: mir.name, node: m, code: "NO_SETTING", message: `#${m} has no "forward z-wave commands" setting — HA changes won't relay from the primary.` }); }
      else if (fw.value !== want) paramActions.push(mkParam(mir.name, m, fw, want));
      else satisfied++;
    }
  }
  return { actions, paramActions, issues, satisfied };
}

/** Remove every inter-member association on the mirror's groups — used when deleting a mirror. */
export async function computeMirrorTeardown(adapter: AssociationTransport, mir: MirrorSpec): Promise<PlanAction[]> {
  const nodes = await adapter.getNodes();
  const present = new Set(mir.members.filter((m) => nodes.some((n) => n.id === m)));
  const actions: PlanAction[] = [];
  for (const m of present) {
    const dg = await adapter.getAssociationGroups({ nodeId: m });
    const groups = resolveGroups(dg, mir.capabilities).groups;
    const glabel = new Map(dg.map((g) => [g.id, g.label]));
    const cur = await adapter.getAssociations({ nodeId: m });
    for (const g of groups) {
      for (const t of cur[g] ?? []) {
        if (present.has(t.nodeId) && t.nodeId !== m) actions.push({ kind: "remove", gang: mir.name, source: m, group: g, groupLabel: glabel.get(g) ?? String(g), target: t.nodeId, targetEndpoint: t.endpoint });
      }
    }
  }
  return actions;
}
