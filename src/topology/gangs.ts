// Load, normalize, and persist the declarative topology (gangs.yaml) — the source of truth.
// Capability-first: a gang/companion expresses INTENT (a preset id or explicit capabilities);
// concrete group numbers are resolved per device at plan time. Explicit `groups`/`controlGroups`
// remain honored as a power-user override.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { presetCapabilities, type CapabilityId } from "./capabilities.ts";

export interface CompanionSpec {
  node: number;
  groups?: number[]; // explicit override (bypasses capability resolution)
  capabilities?: CapabilityId[];
  profile?: string; // preset id, e.g. "full"
}

export interface GangSpec {
  name: string;
  load: number;
  companions: CompanionSpec[];
  controlGroups?: number[]; // explicit override for the whole gang
  capabilities?: CapabilityId[];
  profile?: string;
  /** Also wire load→each companion on the level group so every LED bar tracks together. */
  ledSync?: boolean;
}

export interface Topology {
  defaults: { profile?: string; capabilities?: CapabilityId[]; controlGroups?: number[] };
  gangs: GangSpec[];
}

export function loadTopology(path: string): Topology {
  // First run (npx / fresh Docker volume): no file yet — start empty; saveTopology creates it.
  if (!existsSync(path)) return { defaults: { profile: "full" }, gangs: [] };
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as any;
  const d = raw.defaults ?? {};
  const defaults = { profile: d.profile, capabilities: d.capabilities, controlGroups: d.controlGroups };
  const gangs: GangSpec[] = (raw.gangs ?? []).map((g: any, i: number) => {
    if (g == null || g.load == null) {
      throw new Error(`gang #${i}${g?.name ? ` (${g.name})` : ""} is missing "load"`);
    }
    const companions: CompanionSpec[] = (g.companions ?? []).map((c: any) =>
      typeof c === "number" ? { node: c } : { node: c.node, groups: c.groups, capabilities: c.capabilities, profile: c.profile },
    );
    return { name: g.name ?? `gang-${i}`, load: g.load, companions, controlGroups: g.controlGroups, capabilities: g.capabilities, profile: g.profile, ledSync: g.ledSync === true };
  });
  return { defaults, gangs };
}

/** Explicit group override, if the user pinned specific numbers. Null = resolve by capability. */
export function rawGroupsFor(topo: Topology, gang: GangSpec, comp: CompanionSpec): number[] | null {
  return comp.groups ?? gang.controlGroups ?? topo.defaults.controlGroups ?? null;
}

/** Resolve the intended capabilities: companion > gang > defaults > "full". */
export function wantedCapabilitiesFor(topo: Topology, gang: GangSpec, comp: CompanionSpec): CapabilityId[] {
  const fromProfile = (p?: string) => (p ? presetCapabilities(p) : null);
  return (
    comp.capabilities ??
    fromProfile(comp.profile) ??
    gang.capabilities ??
    fromProfile(gang.profile) ??
    topo.defaults.capabilities ??
    fromProfile(topo.defaults.profile) ??
    ["onoff", "level", "dim"]
  );
}

const SAVE_HEADER = "# Managed by zwave-associations (editable by hand or via the web UI).\n\n";

export function saveTopology(path: string, topo: Topology): void {
  const defaults: Record<string, unknown> = {};
  if (topo.defaults.profile) defaults.profile = topo.defaults.profile;
  if (topo.defaults.capabilities) defaults.capabilities = topo.defaults.capabilities;
  if (topo.defaults.controlGroups) defaults.controlGroups = topo.defaults.controlGroups;

  const doc = {
    defaults,
    gangs: topo.gangs.map((g) => {
      const out: Record<string, unknown> = {
        name: g.name,
        load: g.load,
        companions: g.companions.map((c) =>
          c.groups || c.capabilities || c.profile
            ? { node: c.node, ...(c.groups ? { groups: c.groups } : {}), ...(c.capabilities ? { capabilities: c.capabilities } : {}), ...(c.profile ? { profile: c.profile } : {}) }
            : c.node,
        ),
      };
      if (g.profile) out.profile = g.profile;
      if (g.capabilities) out.capabilities = g.capabilities;
      if (g.controlGroups) out.controlGroups = g.controlGroups;
      if (g.ledSync) out.ledSync = true;
      return out;
    }),
  };
  writeFileSync(path, SAVE_HEADER + stringify(doc));
}
