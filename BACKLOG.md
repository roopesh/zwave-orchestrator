# Backlog

Tracked, not yet started. Ordered roughly by priority within each section.

## Parameters — bugs

- **Expose ALL config parameters, including bitmask/"partial" parameters.**
  `adapter.getConfigParams()` filters to `propertyKey === undefined`, which drops every
  bitmask sub-parameter (e.g. Inovelli param 59 "Send Local Commands to Associated Devices" /
  "Forward Z-Wave Commands to Associated Devices", and the LED-effect params like `64[0xff]`).
  These are currently invisible to the Parameters tab and can't be set through the tool at all.
  Confirmed via a raw (unfiltered) query against live devices — 2026-07-05.
  Fix: read partial-parameter values too, and label each bit using its own metadata (not the
  parent parameter's), storing/targeting them as `{param, bit}` or similar in policies.
- **New-policy parameter dropdown is empty until you check a target device.**
  The settings picker is scoped to the currently-checked target devices' params; with zero
  targets checked (the default state of a brand-new policy) it silently falls back to a
  hardcoded parameter (Dimming Speed). Reproduced live — 2026-07-05. Fix: show a sensible
  full/deduped parameter list before any target is picked (e.g. union across all devices, or
  prompt to pick devices first instead of silently defaulting).

## Parameters — suggested policy (once the above are fixed)

- **Turn on "Forward Z-Wave Commands to Associated Devices" (Inovelli param 59, bit 0x02) on
  every load switch.** Confirmed live: disabled (0) on every load in the house except #2
  (Kitchen Counter Lights). This is very likely why companion LED bars don't track the load
  when it's controlled via Home Assistant/voice/automation rather than a physical local press —
  the load simply never forwards that state change to its associated group. Root-caused
  2026-07-05; not yet applied to any device.

## Associations / gangs

- Physically verify LED-tracking behavior once a gang has "Mirror brightness to companions"
  enabled and synced (mechanism verified in the planner/tests, not yet confirmed on real
  hardware end-to-end).
- Investigate the "delayed response (seconds) from one remote switch" symptom further — current
  best hypothesis is peer-route quality / S2 handshake overhead on that specific companion↔load
  link (not explained by param 59, which governs a different path). No fix identified yet;
  would need per-node route/RSSI data our zwave-js-server version doesn't expose
  (`node.get_statistics` → `unknown_command`).

## Smaller polish (carried over, still open)

- "Forget removed device" action in the device registry (remove a stale entry without a re-pair).
- Search on the plain list views (gangs, nodes, policy drift) — pickers already have search;
  the read-only lists don't.
- Broader nav restructure — likely unnecessary now that search/grouping landed in the pickers;
  revisit only if it's still a problem after everything else above.

## Publishing (needs the user's accounts — not code work)

- Create the GitHub repo, push, replace `OWNER` in `package.json`.
- Set `NPM_TOKEN` repo secret if publishing to npm.
- Cut a tagged release once the above is done (triggers the Docker/npm workflows already in
  `.github/workflows/`).
