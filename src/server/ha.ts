// Home Assistant REST client for the cross-protocol (hub) mirror feature. Two ways to reach HA:
//  - as an HA add-on: the Supervisor injects SUPERVISOR_TOKEN; we proxy through http://supervisor/core/api
//  - standalone (dev): a base URL + a long-lived access token entered in Settings
// We create/read/delete blueprint-based automations via /config/automation/config/{id} (the same
// endpoint HA's own automation editor uses), so instances stay human-editable in the HA UI.

import { copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { BLUEPRINT_DIR, BLUEPRINT_FILE, ID_PREFIX } from "../topology/hubMirror.ts";

export interface HaAuth { base: string; token: string; source: "supervisor" | "config"; }

let cfgUrl = "";
let cfgToken = "";
/** Set the standalone HA URL + long-lived token (from Settings / config.json). */
export function setHaConfig(url?: string, token?: string): void { cfgUrl = (url ?? "").trim(); cfgToken = (token ?? "").trim(); }

export function resolveHa(): HaAuth | null {
  const sup = process.env.SUPERVISOR_TOKEN;
  if (sup) return { base: "http://supervisor/core/api", token: sup, source: "supervisor" };
  if (cfgUrl && cfgToken) return { base: cfgUrl.replace(/\/+$/, "") + "/api", token: cfgToken, source: "config" };
  return null;
}
export const haConfigured = (): boolean => !!resolveHa();

async function haFetch(path: string, init?: RequestInit): Promise<Response> {
  const auth = resolveHa();
  if (!auth) throw new Error("Home Assistant isn't configured — add a URL and long-lived token in Settings (an add-on install gets this automatically).");
  return fetch(auth.base + path, {
    ...init,
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
}

export interface HaLight { entity_id: string; name: string; state: string; }
export async function listLights(): Promise<HaLight[]> {
  const r = await haFetch("/states");
  if (!r.ok) throw new Error(`HA /states → ${r.status}`);
  const states = (await r.json()) as any[];
  return states
    .filter((s) => typeof s?.entity_id === "string" && s.entity_id.startsWith("light."))
    .map((s) => ({ entity_id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id, state: s.state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The automation config HA holds for this id, or null if it doesn't exist. */
export async function getAutomationConfig(id: string): Promise<any | null> {
  const r = await haFetch(`/config/automation/config/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HA read automation ${id} → ${r.status}`);
  return r.json();
}
export async function saveAutomationConfig(id: string, config: unknown): Promise<void> {
  const r = await haFetch(`/config/automation/config/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(config) });
  if (!r.ok) throw new Error(`HA write automation ${id} → ${r.status} ${await r.text().catch(() => "")}`.trim());
}
export async function deleteAutomationConfig(id: string): Promise<void> {
  const r = await haFetch(`/config/automation/config/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error(`HA delete automation ${id} → ${r.status}`);
}
export async function reloadAutomations(): Promise<void> {
  const r = await haFetch("/services/automation/reload", { method: "POST", body: "{}" });
  if (!r.ok) throw new Error(`HA automation reload → ${r.status}`);
}

/** Config ids of tool-managed automations HA currently has (from the automation entity states),
 *  so we can spot orphans — a zwa_mirror_* automation in HA with no matching entry in mirrors.yaml. */
export async function listZwaAutomationIds(): Promise<string[]> {
  const r = await haFetch("/states");
  if (!r.ok) throw new Error(`HA /states → ${r.status}`);
  const states = (await r.json()) as any[];
  return states
    .filter((s) => typeof s?.entity_id === "string" && s.entity_id.startsWith("automation."))
    .map((s) => String(s.attributes?.id ?? s.entity_id.slice("automation.".length)))
    .filter((id) => id.startsWith(ID_PREFIX));
}

export async function haPing(): Promise<{ ok: boolean; source?: string; error?: string }> {
  const auth = resolveHa();
  if (!auth) return { ok: false, error: "not configured" };
  try {
    const r = await haFetch("/"); // GET /api/ → {"message":"API running."}
    return r.ok ? { ok: true, source: auth.source } : { ok: false, source: auth.source, error: `status ${r.status}` };
  } catch (e: any) {
    return { ok: false, source: auth.source, error: e?.message ?? String(e) };
  }
}

/** Copy the bundled blueprint into HA's blueprints dir so instances can reference it. Returns the
 *  destination path. Called on startup (add-on) and before creating the first instance. */
export function deployBlueprint(sourceFile: string, haConfigDir: string): string {
  const dest = join(haConfigDir, "blueprints", "automation", BLUEPRINT_DIR, BLUEPRINT_FILE);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(sourceFile, dest);
  return dest;
}
