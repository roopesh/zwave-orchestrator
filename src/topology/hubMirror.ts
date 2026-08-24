// Cross-protocol "hub" mirrors: HA `light` entities kept in sync via a blueprint automation the
// tool owns. Pure logic here — the HA automation id/alias convention, the blueprint-instance config
// we write, and drift detection (does HA still match what we intended?). The HTTP I/O lives in
// ../server/ha.ts; the add-on deploys the blueprint file itself.

import type { HubMirror } from "./mirrors.ts";

export const BLUEPRINT_FILE = "cross_protocol_mirror.yaml";
export const BLUEPRINT_DIR = "zwave-associations"; // under <ha-config>/blueprints/automation/
export const BLUEPRINT_USE_PATH = `${BLUEPRINT_DIR}/${BLUEPRINT_FILE}`; // automation use_blueprint.path

export const ID_PREFIX = "zwa_mirror_";
export const ALIAS_PREFIX = "[ZWA Mirror] ";

export const hubSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
export const hubAutomationId = (name: string) => ID_PREFIX + hubSlug(name);
export const isHubAutomationId = (id: unknown): id is string => typeof id === "string" && id.startsWith(ID_PREFIX);

export interface HaAutomationConfig {
  id?: string;
  alias?: string;
  description?: string;
  use_blueprint?: { path: string; input?: Record<string, any> };
  [k: string]: any;
}

/** The automation config the tool writes to HA for a hub mirror (a blueprint instance). Human-
 *  readable + editable in the HA UI; the id/alias prefixes mark it as tool-managed. */
export function hubAutomationConfig(m: HubMirror): HaAutomationConfig {
  return {
    id: hubAutomationId(m.name),
    alias: ALIAS_PREFIX + m.name,
    description: "Managed by Z-Wave Associations — edit the member list from the tool's Mirror tab; manual changes here show as drift.",
    use_blueprint: {
      path: BLUEPRINT_USE_PATH,
      input: { lights: [...m.entities], brightness_tolerance: m.tolerance },
    },
  };
}

export type DriftStatus = "ok" | "missing" | "drifted" | "detached";
export interface DriftResult { status: DriftStatus; detail: string; }

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Compare a hub mirror's intended config against what HA actually has. `readback` is the config
 *  from GET /config/automation/config/{id}, or null when the automation doesn't exist. */
export function hubDrift(m: HubMirror, readback: HaAutomationConfig | null): DriftResult {
  if (!readback) return { status: "missing", detail: "Not in Home Assistant yet — Sync to create it." };
  const ub = readback.use_blueprint;
  if (!ub || ub.path !== BLUEPRINT_USE_PATH) return { status: "detached", detail: "This automation no longer uses the mirror blueprint (converted or repointed in HA)." };
  const gotLights: string[] = Array.isArray(ub.input?.lights) ? ub.input!.lights.map(String) : [];
  const wantLights = [...m.entities];
  const gotTol = ub.input?.brightness_tolerance != null ? Number(ub.input.brightness_tolerance) : null;
  const parts: string[] = [];
  if (!sameSet(gotLights, wantLights)) {
    const added = gotLights.filter((e) => !wantLights.includes(e));
    const removed = wantLights.filter((e) => !gotLights.includes(e));
    if (added.length) parts.push(`HA has extra: ${added.join(", ")}`);
    if (removed.length) parts.push(`HA is missing: ${removed.join(", ")}`);
  }
  if (gotTol !== m.tolerance) parts.push(`tolerance is ${gotTol} in HA vs ${m.tolerance} here`);
  return parts.length ? { status: "drifted", detail: parts.join("; ") } : { status: "ok", detail: "In sync with Home Assistant." };
}
