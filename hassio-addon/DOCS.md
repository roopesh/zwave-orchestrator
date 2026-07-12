# Z-Wave Associations — Home Assistant add-on

Runs the Z-Wave Associations manager inside Home Assistant, behind HA's authenticated
**ingress** (a sidebar panel, reachable from the HA mobile app). Same app you can run
standalone — the whole thing (gangs, parameters, door codes) lives in the HA UI.

## What it talks to

It connects to your **Z-Wave JS server** (the WebSocket API exposed by the *Z-Wave JS UI*
or *Z-Wave JS* add-on), the same API Home Assistant itself uses. It does **not** touch the
radio directly.

## Install

1. In HA: **Settings → Add-ons → Add-on Store → ⋮ (top right) → Repositories**, and add:
   `https://github.com/OWNER/zwave-associations`
2. Find **Z-Wave Associations** in the store and click **Install**.
3. Open the **Configuration** tab and set:
   - **zws_host** — the hostname of your Z-Wave JS server add-on. For the community
     *Z-Wave JS UI* add-on this is usually `a0d7b954-zwave-js-ui`; for the official
     *Z-Wave JS* add-on it's `core-zwave-js`. (You can also use its IP, e.g. a fixed LAN
     address.) The add-on's "Z-Wave JS server" / WebSocket port must be enabled.
   - **zws_port** — the server port (default **3000**).
4. **Start** the add-on, then open it from the sidebar (**Z-Wave Assoc**).

## Data

Your `gangs.yaml`, `policies.yaml`, `devices.yaml`, and `codes.yaml` are stored in the
add-on's persistent `/data` volume — they survive restarts and updates. **`codes.yaml`
contains door PINs in plaintext**; it never leaves the add-on and is never committed to git.

## Prerequisite for the maintainer (one-time)

This add-on pulls a prebuilt image from GitHub Container Registry. Before it can install,
the image must exist:

1. Replace `OWNER` with your GitHub username in `hassio-addon/config.yaml`, `repository.yaml`,
   and `package.json`.
2. Push the repo to GitHub and cut a tag (`git tag v0.1.0 && git push --tags`) — the
   `docker-publish` workflow builds and pushes the multi-arch image to
   `ghcr.io/OWNER/zwave-associations`.
3. Make the GHCR package public (or configure HA with a registry login).

The add-on `version` in `config.yaml` must match a published image tag.
