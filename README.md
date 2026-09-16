# zwave-orchestrator

Declarative, **config-as-code** control for your Z-Wave mesh — and the cross-protocol edges around it. You describe what you want (multi-way switch groups, device parameters, lock codes, light mirrors, scene-button actions); the tool reconciles your controller and Home Assistant to match, and keeps them there.

It talks to the **zwave-js-server** WebSocket API (the same interface Home Assistant uses), so it needs no access to the Z-Wave JS UI web page and runs headless. Ships a **web UI**, a **CLI (`zorc`)**, and a **Home Assistant add-on**.

> **Why:** Z-Wave JS UI is powerful but tedious for anything you want *consistent across many devices* — wiring the same associations on every companion, setting the same parameters on dozens of switches, keeping paired shades in sync. This turns all of that into declarative config that's diffed, applied, and verified — with instant, hub-independent multi-way control where latency actually matters.

## What it manages

- **Associations / multi-way switches** — describe a *gang* (one load + its companion switches) with plain-language behaviors (on/off, match brightness, hold-to-dim). The tool reads each device's capabilities, resolves them to that device's actual association groups, and wires them. Direct associations mean instant response with no hub in the loop. Works across brands and mixed-device gangs.
- **Device parameters** — config-as-code parameter *policies*: named sets of values applied to chosen devices/gangs and reconciled to match. **Stack-ranked precedence** resolves conflicts when a device falls under multiple policies (a house-wide default plus targeted exceptions), and the UI shows exactly which policy wins each setting.
- **Lock codes** — manage user PINs (CC 99) as config: named codes, per-lock assignment, enable/disable, stable slot mapping.
- **Mirrors (Z-Wave)** — two or more co-equal loaded dimmers that track each other (on/off + brightness) via direct association, loop-free, with one exposed to Home Assistant as the primary.
- **Cross-protocol mirrors** *(needs Home Assistant)* — keep two or more HA `light` entities in sync across protocols that can't associate directly (e.g. a Zigbee dimmer ↔ a Z-Wave dimmer), via a Home Assistant blueprint the tool deploys and manages. Instances are created for you, tracked in one place, and **drift-checked** against your intent — while staying editable in HA.
- **Scene control** *(needs Home Assistant)* — bind a scene controller's buttons (built for the Zooz ZEN32's 5 buttons; works with any Central Scene device) to covers/shades: single / double / triple tap and hold-to-move, including "set position to N%". Also realized as a tool-managed blueprint.

Associations, parameters, lock codes, and Z-Wave mirrors work with **just zwave-js-server**. Cross-protocol mirrors and scene control run through Home Assistant blueprints — use the add-on, or point the tool at your HA with a long-lived token.

## Highlights

- **Web UI** — see your mesh, build gangs/policies/mirrors by clicking, reconcile with one button, and review drift.
- **Safe by construction** — every apply re-reads live state, is idempotent, and verifies each write. Diagnostics flag Long Range nodes (can't associate), security-class mismatches, missing capabilities, and read-only parameters.
- **Config-as-code** — your YAML (and the blueprint instances) are the durable source of truth; survives controller rebuilds and device re-pairs (with node-id remap).
- **Human-readable** — device and room names everywhere; no group numbers or parameter IDs to memorize.
- **Runs anywhere** — Home Assistant add-on, Docker, `npx`, or from source; `zorc` CLI for scripting/headless.

## Requirements

- A reachable **zwave-js-server** endpoint. In the Home Assistant *Z-Wave JS UI* add-on, enable the **"Z-Wave JS server port"** (default 3000) under Configuration → Network, then restart it.
- **Home Assistant** — only for cross-protocol mirrors and scene control (the add-on wires this up automatically; standalone needs an HA URL + long-lived token).
- To run from source or build: **Node ≥ 22** (uses type stripping + the built-in `WebSocket`). The bundled/published app runs on Node ≥ 20.11.

## Run it

### Home Assistant add-on (recommended)

Best if you want the cross-protocol and scene features: it wires up Home Assistant access for you (Supervisor token, blueprint deploys) and serves the UI in the HA sidebar via ingress. See [`hassio-addon/DOCS.md`](hassio-addon/DOCS.md) to add the repository and install.

### Docker

```bash
docker build -t zwave-orchestrator .
docker run -d --name zwave-orchestrator -p 8090:8090 \
  -e ZWS_HOST=192.168.1.50 -e ZWS_PORT=3000 \
  -v "$PWD/data:/data" zwave-orchestrator
# open http://localhost:8090
```

Or copy `docker-compose.example.yml` → `docker-compose.yml`, set `ZWS_HOST`, and `docker compose up -d`. Your config persists in the mounted `/data` volume.

### npx / npm  *(after the first npm release is tagged)*

```bash
npx zwave-orchestrator             # web UI on :8090
# or the CLI:
#   npm i -g zwave-orchestrator && zorc plan
```

### From source (development)

```bash
npm install
npm run serve                      # web UI at http://localhost:8090
npm test                           # unit tests (node --test)
npm run build                      # bundle to dist/ (esbuild)
```

## Configure

**Z-Wave connection** — precedence: CLI flags > env (`ZWS_HOST`, `ZWS_PORT`, `ZWS_URL`, `PORT`) > `config/config.json` > defaults (`127.0.0.1:3000`). Or set host/port in the web UI **Settings**. In Docker, prefer `ZWS_HOST` / `ZWS_PORT`.

**Home Assistant** (for cross-protocol mirrors + scenes, standalone only) — add your HA URL and a long-lived access token in **Settings**. The add-on uses the Supervisor token automatically, so there's nothing to enter there.

## Topology as code

A gang is one load plus its companions and a behavior preset (see [`gangs.example.yaml`](gangs.example.yaml)):

```yaml
defaults:
  profile: full            # on/off + brightness sync + hold-to-dim
gangs:
  - name: Kitchen Ceiling
    load: 2
    companions: [3, 4]
```

Parameter policies, mirrors, and lock codes are built in the web UI and persisted the same way (`policies.yaml`, `mirrors.yaml`, `codes.yaml`). **All of these are gitignored** — they hold your home's data, and `codes.yaml` holds plaintext PINs. Only the `*.example.yaml` files are tracked.

## CLI (`zorc`)

The CLI covers associations (parameters, codes, mirrors, and cross-protocol features live in the web UI / add-on):

```bash
node src/cli.ts dump                       # JSON inventory + associations (read-only)
node src/cli.ts plan                       # diff gangs.yaml vs live state
node src/cli.ts apply --yes                # add missing links (idempotent, verified)
node src/cli.ts reconcile --yes            # add missing AND remove stale links
node src/cli.ts teardown --gang "Kitchen Ceiling" --yes
# filters: --gang NAME, --node ID ; connection: --host H --port P --url ws://host:port
```

Installed globally, the command is `zorc` (e.g. `zorc plan`).

## How it works

Your config is the source of truth. Each domain computes a **plan** — a diff between desired and live state — then applies it **idempotently, re-reading and verifying every write**. A "redeploy" trusts a fresh read, not a cached one. Cross-protocol mirrors and scene control are realized as Home Assistant blueprint automations that the tool deploys and drift-checks, so they stay human-editable in HA while remaining tracked here.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the project layout, and conventions. **Never commit personal config or secrets:** `gangs.yaml`, `policies.yaml`, `devices.yaml`, `mirrors.yaml`, `codes.yaml`, and `config/config.json` are all gitignored — keep them that way.

## License

[MIT](LICENSE) © Roopesh Sheth
