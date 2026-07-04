# zwave-associations

Declarative association manager for Z-Wave **companion / 3-way switches**. You describe your
switch _gangs_ once in `gangs.yaml`; the tool reconciles your controller to match — instant,
Home-Assistant-independent multi-way control, managed as code.

It talks to the **zwave-js-server** WebSocket API (the same interface Home Assistant uses),
so it needs no browser access to the Z-Wave JS UI web page and works headless.

## Status

Early scaffold. Working today:

- `npm run dump` — connect and print every node with its association groups + current
  associations as JSON (read-only).

Coming next: `plan` (diff `gangs.yaml` against live state) and `apply` (reconcile, idempotent),
then a small web UI.

## Requirements

- Node >= 22 (uses the built-in global `WebSocket`).
- A reachable **zwave-js-server** endpoint. In the Home Assistant _Z-Wave JS UI_ add-on this is
  the **"Z-Wave JS server port"** (default 3000) — enable it under the add-on's
  Configuration → Network, then restart the add-on.

## Configure the connection

Precedence: CLI flags > env vars > `config/config.json` > defaults (`127.0.0.1:3000`).

```bash
# config/config.json  (git-ignored; copy from config.example.json)
{ "host": "192.168.1.50", "port": 3000 }

# or env / flags
ZWS_HOST=192.168.1.50 ZWS_PORT=3000 npm run dump
node src/cli.ts dump --url ws://192.168.1.50:3000
```

## Usage

```bash
npm install
npm run dump                 # read-only inventory + associations as JSON
```
