# Contributing to zwave-orchestrator

Thanks for helping out. This is a self-hostable tool for managing Z-Wave **associations** (companion / multi-way switches), **device parameters**, **lock codes**, and **cross-protocol light sync** — all as declarative config that the tool reconciles against your live mesh. It talks to the **zwave-js-server** WebSocket API (the same one Home Assistant uses) and ships both a web UI and a CLI, plus a Home Assistant add-on.

New here? Read the [README](README.md) first, then skim [BACKLOG.md](BACKLOG.md) for open ideas.

## ⚠️ Never commit personal config or secrets

These files are created at runtime, hold your home's data, and are **gitignored — keep them that way**:

- `gangs.yaml`, `policies.yaml`, `devices.yaml`, `mirrors.yaml` — your topology.
- `codes.yaml` — **contains plaintext door PINs.**
- `config/config.json` — host/port and your **Home Assistant long-lived token**.

Only the `*.example.yaml` reference files are tracked. Before every PR, run `git status` and confirm none of the above are staged. Never paste PINs, tokens, or your Z-Wave `homeId` into issues or PRs.

## Development setup

- **Node ≥ 22** (the source runs directly via type stripping — no build step for dev — and uses the built-in `WebSocket`). We use [`fnm`](https://github.com/Schniz/fnm) but any Node ≥ 22 works.

```bash
npm install
npm run serve        # web UI at http://localhost:8090
npm test             # unit tests (node --test)
npm run build        # bundle src/ -> dist/ (esbuild) — for release/Docker only
npx tsc --noEmit     # type-check
```

Point it at your controller with the web UI **Settings**, or `--host`/`--port` flags, or `ZWS_HOST`/`ZWS_PORT` env vars (see README). A read-only `node src/cli.ts plan` is the safest way to exercise your changes against a real mesh.

## Project layout

| Path | What's there |
|------|--------------|
| `src/zwave/` | `client.ts` (zwave-js-server WS handshake + request/response) and `adapter.ts` (the transport interface the rest of the code uses). |
| `src/topology/` | The engines. `gangs.ts`/`plan.ts` (associations), `policies.ts`/`paramPlan.ts` (device parameters + precedence), `mirrors.ts`/`hubMirror.ts` (Z-Wave mirrors + cross-protocol hub mirrors), `codes.ts` (lock PINs), `devices.ts` (registry), `capabilities.ts` (capability→group resolution), `discover.ts`. |
| `src/server/` | `index.ts` (node:http server + JSON API, serves the UI) and `ha.ts` (Home Assistant REST client for cross-protocol mirrors). |
| `public/index.html` | The entire single-page UI (vanilla JS, no framework, no build). |
| `blueprints/` | Home Assistant blueprints the tool deploys (cross-protocol mirror, scene-controller → covers). |
| `hassio-addon/` | Home Assistant add-on packaging. |
| `src/test/` | `node --test` suites with a `MockAdapter` — no hardware needed. |

## How it works (the mental model)

**Config-as-code, reconciled.** Your YAML is the source of truth. Each engine computes a *plan* — a diff between desired and live state — then applies it **idempotently, re-reading and verifying every write**. Nothing is assumed; a redeploy trusts a fresh read, not a cached one. Follow this pattern for any new engine: `compute*Plan()` (pure, unit-testable) + `apply*()` (writes with read-back verification).

## Conventions

- **Match the surrounding code.** Minimal dependencies, no framework, small focused modules.
- **Human-readable UI, always.** User-facing text shows device/room names and parameter labels — **never raw node IDs or `pXX` parameter numbers.** IDs are for logs and debugging only. This is a hard rule; regressions get flagged.
- **Writes are additive and verified.** Never blindly overwrite; diff, apply, re-read, confirm. Warn (don't silently skip) on things like Long Range nodes or security-class mismatches.
- **Keep it testable.** Plan logic should be pure functions over the adapter interface so it can be tested with `MockAdapter`.

## Submitting changes

1. Fork and branch off `main`.
2. Make the change with tests. **Add or update `node --test` coverage** for any engine/logic change.
3. Before opening the PR: `npm test` **and** `npx tsc --noEmit` must pass.
4. In the PR description, say **what you changed and how you tested it** — ideally including a `plan` run or a unit test, and a note if you verified against real hardware.
5. Keep PRs focused; one concern per PR.

## Reporting bugs & requesting features

Open a GitHub issue. For bugs, include your controller/zwave-js-server version, the relevant device model(s), and what you expected vs. saw — but **redact PINs, tokens, and identifiers**. Security-sensitive reports (anything involving lock codes or tokens): please open a private report rather than a public issue.

## Home Assistant add-on

The add-on builds from source via its `Dockerfile` (`hassio-addon/`). It serves the same UI through HA ingress and uses the Supervisor token for the Home Assistant API. Changes to `src/` and `public/` must be re-synced into the add-on and rebuilt to take effect there.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
