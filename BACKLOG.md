# Backlog

Tracked, not yet started. Ordered roughly by priority within each section.

## Parameters — bugs

- ~~Expose ALL config parameters, including bitmask/"partial" parameters.~~ **DONE 2026-07-05**:
  adapter reads partial params as `{param, key}` entries with their own metadata; policies
  store `key`; UI (policy editor, drift finder, LED seed) is key-aware. ~1,100 previously
  invisible settings now exposed on the live mesh.
- ~~New-policy parameter dropdown is empty until you check a target device.~~ **DONE 2026-07-05**:
  the settings section is hidden until ≥1 device or gang is selected, with an explanation
  ("settings and value choices come from the selected devices"); no more silent fallback.

## Parameters — forwarding fix (mechanism built; applying is the user's call)

- **DONE (tooling) 2026-07-05:** gangs now have a "Forward app/automation changes to
  companions" option (gangs.yaml `forwardRemote`); Sync enables the load's "Forward Z-Wave
  Commands to Associated Devices" setting, shown in the plan first. Policies can also target
  gangs by role (all / load / companions), so a house-wide forwarding policy is possible.
- **TODO (user):** enable the option on the remaining gangs (currently on for Downstairs
  Hallway Pendant only, pending Sync) — or make one gang-targeted policy for all loads.
  Then Sync and physically verify the LED bars track app/voice/automation changes.

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
