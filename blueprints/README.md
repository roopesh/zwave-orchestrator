# Home Assistant blueprints

Companion blueprints for cases this tool **can't** solve at the Z-Wave layer.

Z-Wave associations only link Z-Wave devices to each other. When you need to keep
devices in sync **across protocols** — e.g. an Inovelli Blue (Zigbee) dimmer and an
Inovelli Red (Z-Wave) dimmer — there's no native device-to-device path, so it has to
go through the hub. These blueprints are that hub-side fallback.

## `inovelli_blue_red_dimmer_sync.yaml`

Two-way on/off + brightness sync between any two `light` entities (built for a
Blue↔Red dimmer pair, but works on any two lights). Loop-safe via a brightness
tolerance that absorbs the Zigbee 0–255 ↔ Z-Wave 0–99 rounding.

**Install:** drop it in your HA config under
`blueprints/automation/<you>/inovelli_blue_red_dimmer_sync.yaml`, then
**Settings → Automations & Scenes → Blueprints** → create an automation from it,
picking the two dimmers. One automation per pair.

**Note:** cross-protocol sync round-trips through HA, so expect a small lag —
unlike a native Z-Wave mirror (see the app's Mirror tab), which is instant.
