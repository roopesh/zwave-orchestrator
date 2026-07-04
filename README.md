# zwave-associations

Declarative association manager for Z-Wave **companion / 3-way switches**. You describe your
switch _gangs_ once; the tool reconciles your controller to match — instant, Home-Assistant-
independent multi-way control, managed as code.

It talks to the **zwave-js-server** WebSocket API (the same interface Home Assistant uses), so it
needs no browser access to the Z-Wave JS UI page and works headless.

## Highlights

- **Web UI** — see your mesh, build gangs by clicking, and reconcile with one button.
- **Capability-based** — you pick plain-language behaviors ("on/off", "match brightness",
  "hold to dim"); the tool reads each device's advertised capabilities and resolves them to that
  device's actual association groups. Works across brands and mixed-device gangs — no group
  numbers to know.
- **Safe writes** — every apply re-reads live state, is idempotent, and verifies each change.
  Diagnostics flag Long Range nodes (can't associate), security-class mismatches, and more.
- **CLI too** — `dump`, `plan`, `apply`, `reconcile`, `teardown` for scripting/headless use.

## Requirements

- A reachable **zwave-js-server** endpoint. In the Home Assistant _Z-Wave JS UI_ add-on this is
  the **"Z-Wave JS server port"** (default 3000) — enable it under the add-on's
  Configuration → Network, then restart the add-on.
- To run from source or build: **Node ≥ 22** (uses type stripping + the built-in `WebSocket`).
  The published/bundled app runs on Node ≥ 20.11.

## Run it

### Docker (recommended for a homelab / Proxmox box)

```bash
docker build -t zwave-associations .
docker run -d --name zwave-assoc -p 8090:8090 \
  -e ZWS_HOST=192.168.1.50 -e ZWS_PORT=3000 \
  -v "$PWD/data:/data" zwave-associations
# open http://localhost:8090
```

Or copy `docker-compose.example.yml` → `docker-compose.yml`, set `ZWS_HOST`, and `docker compose up -d`.
Your `gangs.yaml` topology persists in the mounted `/data` volume.

### npx / npm

```bash
npx zwave-associations                 # starts the web UI on :8090
# or install and use the CLI:
#   npm i -g zwave-associations && zwave-assoc plan
```

### From source (development)

```bash
npm install
npm run serve                          # web UI at http://localhost:8090
npm run build                          # bundle to dist/ (esbuild)
```

## Configure the connection

Precedence: CLI flags > env (`ZWS_HOST`, `ZWS_PORT`, `ZWS_URL`, `PORT`) > `config/config.json`
> defaults (`127.0.0.1:3000`). In the web UI, use **Settings** to set the host/port. In Docker,
prefer the `ZWS_HOST` / `ZWS_PORT` env vars.

## CLI

```bash
node src/cli.ts dump                    # JSON inventory + associations (read-only)
node src/cli.ts plan                    # diff gangs.yaml vs live state
node src/cli.ts apply --yes             # add missing links (idempotent, verified)
node src/cli.ts reconcile --yes         # add missing AND remove stale links
node src/cli.ts teardown --gang "Kitchen Ceiling" --yes
# filters: --gang NAME, --node ID ; connection: --host H --port P --url ws://host:port
```

## Topology (`gangs.yaml`)

See `gangs.example.yaml`. A gang is one load switch plus its companions and a behavior preset:

```yaml
defaults:
  profile: full # on/off + brightness sync + hold-to-dim
gangs:
  - name: Kitchen Ceiling
    load: 2
    companions: [3, 4]
```
