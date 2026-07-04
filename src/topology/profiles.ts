// Group profiles: named presets of association groups with human explanations, so the UI can
// offer a selectable "what should this companion send?" with pros/cons/examples. Tuned for
// Inovelli VZW dimmers (the mesh in use); the actual per-device group labels still come live
// from the controller, and "custom" lets you pick any advertised groups.

export interface GroupInfo {
  group: number;
  label: string;
  blurb: string;
}

export interface GroupProfile {
  id: string;
  label: string;
  groups: number[];
  summary: string;
  pros: string[];
  cons: string[];
  example: string;
  recommended?: boolean;
}

/** Friendly one-liners for the individual Inovelli control groups. */
export const GROUP_INFO: GroupInfo[] = [
  { group: 2, label: "Basic Set", blurb: "Single tap up/down sends on/off to the load." },
  { group: 3, label: "Multilevel Switch Set", blurb: "Companion's dim level is mirrored onto the load (level tracks)." },
  { group: 4, label: "Multilevel Switch Start/Stop", blurb: "Press-and-hold ramps the load up/down, release stops." },
  { group: 5, label: "Basic Set (double-tap)", blurb: "Double-tap sends full on/off." },
  { group: 6, label: "Basic Set (triple-tap)", blurb: "Triple-tap sends on/off." },
];

export const GROUP_PROFILES: GroupProfile[] = [
  {
    id: "full",
    label: "Full companion",
    groups: [2, 3, 4],
    summary: "On/off, level tracking, and hold-to-dim — behaves like a true multi-way dimmer.",
    pros: ["Tap toggles the load", "Local dim level mirrors to the load", "Press-and-hold dims from either location"],
    cons: ["Most association slots used", "Slightly more to reason about if you later debug"],
    example: "Two dimmers on the same fixture: tap either to toggle, hold either to dim, and both stay in sync.",
    recommended: true,
  },
  {
    id: "level",
    label: "Level only",
    groups: [3],
    summary: "Only the dim level is mirrored to the load. Simplest; matches a common minimal setup.",
    pros: ["Fewest links", "Level stays in sync"],
    cons: ["Plain on/off tap and hold-to-dim may not carry, depending on the switch's association-behavior setting"],
    example: "You only care that setting one dimmer sets the other to the same brightness.",
  },
  {
    id: "onoff",
    label: "On/off only",
    groups: [2],
    summary: "Tap sends on/off, no dimming sync. Good for non-dimmable loads or switch (relay) devices.",
    pros: ["Simple, predictable toggling"],
    cons: ["No level sync", "No hold-to-dim"],
    example: "A companion controlling a switched (non-dim) fixture.",
  },
];
