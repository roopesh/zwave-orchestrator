# Z-Wave Orchestrator — Home Assistant add-on

Runs Z-Wave Orchestrator inside Home Assistant, behind HA's authenticated **ingress** (a sidebar panel, reachable from the HA mobile app). It's the same app you can run standalone — associations, device parameters, lock codes, native + cross-protocol light mirrors, and scene control, all in the HA UI.

## What it talks to

It connects to your **Z-Wave JS server** — the WebSocket API exposed by the *Z-Wave JS UI* or *Z-Wave JS* add-on, the same API Home Assistant itself uses. It does **not** touch the radio directly. The cross-protocol mirror and scene-control features additionally use Home Assistant itself (via the Supervisor token this add-on is granted) to deploy their blueprints and read `light`/`cover` entities.

## Install

1. In HA: **Settings → Add-ons → Add-on Store → ⋮ (top right) → Repositories**, and add:
   `https://github.com/roopesh/zwave-orchestrator`
2. Find **Z-Wave Orchestrator** in the store and click **Install**.
   > **Heads-up:** this add-on builds from source on install, so the first install takes a few minutes (longer on a Raspberry Pi) while it compiles. Subsequent starts are instant.
3. Open the **Configuration** tab and set:
   - **zws_host** — the hostname of your Z-Wave JS server add-on. For the community *Z-Wave JS UI* add-on this is usually `a0d7b954-zwave-js-ui`; for the official *Z-Wave JS* add-on it's `core-zwave-js`. A fixed LAN IP works too. Its "Z-Wave JS server" / WebSocket port must be enabled.
   - **zws_port** — the server port (default **3000**).
4. **Start** the add-on, then open it from the sidebar (**Z-Wave Orch**).

## Cross-protocol mirrors & scene control

These run through Home Assistant blueprints the add-on deploys and manages. Nothing extra to configure: the add-on uses the **Supervisor token** automatically (the `homeassistant_api` grant), so there's no long-lived token to enter — that's only needed when running the app standalone, outside HA.

## Data & secrets

Your `gangs.yaml`, `policies.yaml`, `devices.yaml`, `mirrors.yaml`, and `codes.yaml` live in the add-on's persistent `/data` volume — they survive restarts and updates. **`codes.yaml` holds door PINs in plaintext**; it stays inside the add-on and is never committed to git.

## Updating

Rebuild from the add-on's ⋮ menu to pick up new commits, or bump the add-on `version` to have HA surface an **Update**. If this add-on later ships a prebuilt image, it keeps the same slug — so your install updates in place with its config and data intact.
