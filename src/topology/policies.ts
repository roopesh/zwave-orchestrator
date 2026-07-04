// Device parameter policies — "config-as-code". A policy is a user-built named set of parameter
// values applied to a chosen set of devices. Fully configurable (you pick params + values +
// targets); the tool reconciles devices to match. Stored in policies.yaml.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

export interface PolicySetting {
  param: number;
  value: number;
}

export interface Policy {
  name: string;
  targets: number[]; // node ids this policy applies to
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
    settings: (p.settings ?? []).map((s: any) => ({ param: Number(s.param), value: Number(s.value) })),
  }));
  return { policies };
}

const SAVE_HEADER = "# Managed by zwave-associations (device parameter policies).\n\n";

export function savePolicies(path: string, doc: PolicyDoc): void {
  writeFileSync(path, SAVE_HEADER + stringify({ policies: doc.policies }));
}
