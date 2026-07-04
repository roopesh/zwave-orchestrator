// Capability model: the user picks plain-language INTENT ("on/off", "brightness sync",
// "hold to dim"); we derive what each association group actually does from its device-reported
// issuedCommands, then resolve the intent to that specific device's group numbers. No brand
// tables, no CC ids or group labels exposed to the user.

import type { AssociationGroup } from "../types.ts";

export type CapabilityId = "onoff" | "level" | "dim";

export interface Capability {
  id: CapabilityId;
  title: string; // plain language, shown to the user
  description: string;
  example: string;
}

export interface Preset {
  id: string;
  label: string;
  capabilities: CapabilityId[];
  summary: string;
  recommended?: boolean;
}

/** Human descriptions — the ONLY association vocabulary the user sees. */
export const CAPABILITIES: Capability[] = [
  { id: "onoff", title: "Turn on & off", description: "Tapping the companion switch turns the light on or off.", example: "Tap the hallway paddle and the kitchen light toggles." },
  { id: "level", title: "Match brightness", description: "Setting the companion's brightness sets the light to the same level, keeping them in sync.", example: "Dial one dimmer to 40% and the other follows to 40%." },
  { id: "dim", title: "Hold to dim", description: "Press and hold the companion to smoothly brighten or dim the light.", example: "Hold either paddle to ramp the lights up or down." },
];

export const PRESETS: Preset[] = [
  { id: "full", label: "Full companion", capabilities: ["onoff", "level", "dim"], summary: "Behaves like a true multi-way dimmer — on/off, brightness sync, and hold-to-dim.", recommended: true },
  { id: "onoff_level", label: "On/off + brightness", capabilities: ["onoff", "level"], summary: "Toggle the light and keep brightness in sync, without hold-to-dim." },
  { id: "onoff", label: "On/off only", capabilities: ["onoff"], summary: "Just switch the light on and off — good for non-dimmable or switched loads." },
];

export function presetCapabilities(id: string): CapabilityId[] | null {
  return PRESETS.find((p) => p.id === id)?.capabilities ?? null;
}

// --- Z-Wave command classes / commands we key on (standard across all brands) ---
const CC_BASIC = 32; // Basic Set = cmd 1
const CC_MULTILEVEL = 38; // Set = 1, StartLevelChange = 4, StopLevelChange = 5
const has = (g: AssociationGroup, cc: number, cmd: number) => (g.issuedCommands?.[cc] ?? []).includes(cmd);

/** A group is a "variant" (double/triple tap, config button, scene) — deprioritized vs the base group. */
function isVariant(g: AssociationGroup): boolean {
  return /double|triple|config|scene/i.test(g.label);
}

/** What a single group can do, from its issuedCommands (falls back to label keywords). */
export function groupCapabilities(g: AssociationGroup): Set<CapabilityId> {
  const caps = new Set<CapabilityId>();
  if (g.isLifeline) return caps;
  const hasCmds = g.issuedCommands && Object.keys(g.issuedCommands).length > 0;
  if (hasCmds) {
    if (has(g, CC_BASIC, 1)) caps.add("onoff");
    if (has(g, CC_MULTILEVEL, 1)) caps.add("level");
    if (has(g, CC_MULTILEVEL, 4) || has(g, CC_MULTILEVEL, 5)) caps.add("dim");
  } else {
    // Older / non-AGI devices that don't report issuedCommands: best-effort from the label.
    const l = g.label.toLowerCase();
    if (/basic|on.?off|binary/.test(l)) caps.add("onoff");
    if (/multilevel|dimmer|level/.test(l)) caps.add("level");
    if (/start|stop|ramp/.test(l)) caps.add("dim");
  }
  return caps;
}

/** Union of capabilities a device supports across its (non-lifeline) groups. */
export function deviceCapabilities(groups: AssociationGroup[]): CapabilityId[] {
  const set = new Set<CapabilityId>();
  for (const g of groups) for (const c of groupCapabilities(g)) set.add(c);
  return CAPABILITIES.map((c) => c.id).filter((id) => set.has(id));
}

export interface Resolution {
  groups: number[]; // concrete group ids to wire on this device
  byCapability: Record<string, number | null>;
  missing: CapabilityId[]; // requested capabilities this device can't provide
}

/** Resolve requested capabilities to this device's actual group numbers. */
export function resolveGroups(groups: AssociationGroup[], wanted: CapabilityId[]): Resolution {
  const usable = groups.filter((g) => !g.isLifeline);
  const byCapability: Record<string, number | null> = {};
  for (const cap of wanted) {
    const candidates = usable
      .filter((g) => groupCapabilities(g).has(cap))
      .sort((a, b) => Number(isVariant(a)) - Number(isVariant(b)) || a.id - b.id);
    byCapability[cap] = candidates[0]?.id ?? null;
  }
  const groupIds = [...new Set(Object.values(byCapability).filter((x): x is number => x != null))].sort((a, b) => a - b);
  const missing = wanted.filter((c) => byCapability[c] == null);
  return { groups: groupIds, byCapability, missing };
}
