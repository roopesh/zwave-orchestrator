// Load and normalize the declarative topology (gangs.yaml) — the source of truth.
// A companion may be a bare node id, or an object with a per-companion group override.

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface CompanionSpec {
  node: number;
  /** Override the control groups wired on this companion (else gang, else defaults). */
  groups?: number[];
}

export interface GangSpec {
  name: string;
  load: number;
  companions: CompanionSpec[];
  /** Override the default control groups for this gang. */
  controlGroups?: number[];
}

export interface Topology {
  defaults: { controlGroups: number[] };
  gangs: GangSpec[];
}

const DEFAULT_CONTROL_GROUPS = [2, 3, 4];

export function loadTopology(path: string): Topology {
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as any;
  const defaults = {
    controlGroups: raw.defaults?.controlGroups ?? DEFAULT_CONTROL_GROUPS,
  };
  const gangs: GangSpec[] = (raw.gangs ?? []).map((g: any, i: number) => {
    if (g == null || g.load == null) {
      throw new Error(`gang #${i}${g?.name ? ` (${g.name})` : ""} is missing "load"`);
    }
    const companions: CompanionSpec[] = (g.companions ?? []).map((c: any) =>
      typeof c === "number" ? { node: c } : { node: c.node, groups: c.groups },
    );
    return {
      name: g.name ?? `gang-${i}`,
      load: g.load,
      companions,
      controlGroups: g.controlGroups,
    };
  });
  return { defaults, gangs };
}

/** Resolve the control groups for a companion: per-companion > per-gang > defaults. */
export function controlGroupsFor(topo: Topology, gang: GangSpec, comp: CompanionSpec): number[] {
  return comp.groups ?? gang.controlGroups ?? topo.defaults.controlGroups;
}
