// Device parameter policies — "config-as-code". A policy is a user-built named set of parameter
// values applied to chosen devices and/or gangs; the tool reconciles devices to match. Stored in
// policies.yaml. A setting's optional `key` addresses a bitmask sub-parameter (zwave-js
// propertyKey), e.g. Inovelli param 59 key 2 = "Forward Z-Wave Commands to Associated Devices".

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

export interface PolicySetting {
  param: number;
  key?: number;
  value: number;
}

export type GangRole = "all" | "load" | "companions";

/** Dynamic target: resolved to node ids from the gang's CURRENT membership at plan time. */
export interface GangTarget {
  gang: string;
  role: GangRole;
}

export interface Policy {
  name: string;
  targets: number[]; // explicit node ids
  gangTargets?: GangTarget[]; // resolved dynamically against gangs.yaml
  settings: PolicySetting[];
}

export interface PolicyDoc {
  policies: Policy[];
}

export function loadPolicies(path: string): PolicyDoc {
  if (!existsSync(path)) return { policies: [] };
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as any;
  const policies: Policy[] = (raw.policies ?? []).map((p: any, i: number) => ({
    name: p.name ?? `policy-${i}`,
    targets: (p.targets ?? []).map(Number),
    gangTargets: (p.gangTargets ?? []).map((g: any) => ({
      gang: String(g.gang),
      role: g.role === "load" || g.role === "companions" ? g.role : "all",
    })),
    settings: (p.settings ?? []).map((s: any) => ({
      param: Number(s.param),
      key: s.key !== undefined ? Number(s.key) : undefined,
      value: Number(s.value),
    })),
  }));
  return { policies };
}

const SAVE_HEADER = "# Managed by zwave-associations (device parameter policies).\n\n";

export function savePolicies(path: string, doc: PolicyDoc): void {
  const out = {
    policies: doc.policies.map((p) => ({
      name: p.name,
      targets: p.targets,
      ...(p.gangTargets?.length ? { gangTargets: p.gangTargets } : {}),
      settings: p.settings.map((s) => ({ param: s.param, ...(s.key !== undefined ? { key: s.key } : {}), value: s.value })),
    })),
  };
  writeFileSync(path, SAVE_HEADER + stringify(out));
}
