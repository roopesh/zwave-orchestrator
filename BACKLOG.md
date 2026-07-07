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

## Parameters — forwarding fix

- ~~Enable "Forward Z-Wave Commands to Associated Devices" on every load.~~ **DONE 2026-07-06**:
  all 5 gangs now have `forwardRemote: true` in `gangs.yaml` and are synced live (verified via
  the plan showing 0 pending param actions). `forwardRemote` is a true tri-state (on/off/unset)
  as of 2026-07-06 — unchecking it on a gang that had it on now disables the load's setting on
  Sync, instead of silently leaving it as-is.

## Associations / gangs

- Physically verify LED-tracking behavior once a gang has "Mirror brightness to companions"
  enabled and synced (mechanism verified in the planner/tests AND via a full live
  teardown/recreate/resync round-trip on "Downstairs Hallway Pendant Light" 2026-07-07 — but
  that only proves the associations exist, not that the LED bars visually track; still needs
  eyes-on-the-hardware confirmation).
- Investigate the "delayed response (seconds) from one remote switch" symptom further — current
  best hypothesis is peer-route quality / S2 handshake overhead on that specific companion↔load
  link (not explained by param 59, which governs a different path). No fix identified yet;
  would need per-node route/RSSI data our zwave-js-server version doesn't expose
  (`node.get_statistics` → `unknown_command`).

## Diagnosability / reliability (DONE 2026-07-06/07)

- ~~Devices window is clunky, too many clicks/scrolling.~~ **DONE**: redesigned to compact
  one-line rows + single checkbox (checked=in groups) + filter chips with live counts
  (All/New/In groups/Ignored) + per-room "all in"/"all ignore" bulk + search. Verified live in
  a real browser against the running server 2026-07-07 (33 devices, room-grouped).
- ~~No way to force-reapply everything without trusting the diff.~~ **DONE**: header "Redeploy
  everything" button (`/api/redeploy`) force-reapplies every declared association and
  parameter regardless of what the current read thinks is already correct — `computePlan`/
  `computeParamPlan` gained a `{force:true}` option. Per-tab "Sync" buttons stay diff-based
  (fast) on purpose.
- ~~Server had zero request logging (only startup banners).~~ **DONE**: every mutating endpoint
  (apply/teardown/reconcile/redeploy/params-apply/save-gangs/save-policies/remap) now logs
  computed-vs-filtered action counts + a per-action OK/FAIL line with the real error, to
  `~/Library/Logs/zwave-associations.log`. Per-node association-read failures log a WARN
  instead of silently defaulting to "no associations." Browser console gets the full response
  + explicit failed-entry list on every write.
- ~~Gang "Delete" only edited config, never touched the devices; standalone "Teardown" button
  edited devices but never config, so the next Sync silently restored what Teardown just
  removed.~~ **DONE**: Delete now atomically tears down the devices then removes from config
  (aborts config removal — with a clear per-link error dialog — if any unwire fails, unless the
  user explicitly overrides). Standalone Teardown button removed entirely. Verified via a full
  real delete→confirm-torn-down→recreate→confirm-restored cycle on "Downstairs Hallway Pendant
  Light" plus a create/delete-before-sync throwaway-gang test, both 2026-07-07.

## Smaller polish (carried over, still open)

- ~~"Forget removed device" action in the device registry.~~ **DONE 2026-07-07**: registry
  entries no longer on the mesh now show in a card on the Associations tab with a per-device
  "Forget" button (`forgetDevice()` in devices.ts + `POST /api/devices/forget`, logged). Doesn't
  touch anything on the mesh — clears the local record only. Verified live with a synthetic
  removed entry: shows up, Cancel leaves it untouched, confirming removes it (logged + confirmed
  gone from `devices.yaml`), unaffected entries untouched.
- ~~Search on the plain list views (gangs, nodes, policy drift) — pickers already have search;
  the read-only lists don't.~~ **DONE 2026-07-07**: added search to gangs, nodes, policies, and
  "Where devices differ". All search everywhere (these + the 3 existing pickers) now shares one
  matcher (`matchesSearch`/`parseSearchTerms`): unquoted words are AND'd regardless of order
  ("kitchen remote" matches "Remote FR Kitchen Counter Lights"), `"quoted phrases"` match as one
  exact contiguous substring. Verified live across all 7 search boxes with real data (multi-word,
  reversed order, exact phrase, wrong-order-in-quotes correctly failing, no-match) + the matcher
  logic unit-tested directly (20 assertions).
- Broader nav restructure — likely unnecessary now that search/grouping landed everywhere;
  revisit only if it's still a problem after everything else above.

## Publishing (needs the user's accounts — not code work)

- Create the GitHub repo, push, replace `OWNER` in `package.json`.
- Set `NPM_TOKEN` repo secret if publishing to npm.
- Cut a tagged release once the above is done (triggers the Docker/npm workflows already in
  `.github/workflows/`).
