import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMirrors, saveMirrors, type HubMirror } from "../topology/mirrors.ts";
import { hubAutomationId, hubSlug, isHubAutomationId, hubAutomationConfig, hubDrift, BLUEPRINT_USE_PATH } from "../topology/hubMirror.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("hubSlug + automation id are stable and marked", () => {
  assert.equal(hubSlug("Kitchen & Nook!"), "kitchen_nook");
  assert.equal(hubSlug("   "), "unnamed");
  assert.equal(hubAutomationId("Kitchen & Nook!"), "zwa_mirror_kitchen_nook");
  assert.ok(isHubAutomationId("zwa_mirror_kitchen_nook"));
  assert.ok(!isHubAutomationId("automation.some_other"));
});

test("hubAutomationConfig is a blueprint instance with our inputs", () => {
  const m: HubMirror = { name: "Kitchen", entities: ["light.a", "light.b"], tolerance: 4 };
  const c = hubAutomationConfig(m);
  assert.equal(c.id, "zwa_mirror_kitchen");
  assert.equal(c.alias, "[ZWA Mirror] Kitchen");
  assert.equal(c.use_blueprint!.path, BLUEPRINT_USE_PATH);
  assert.deepEqual(c.use_blueprint!.input!.lights, ["light.a", "light.b"]);
  assert.equal(c.use_blueprint!.input!.brightness_tolerance, 4);
});

const m: HubMirror = { name: "Kitchen", entities: ["light.a", "light.b"], tolerance: 4 };

test("hubDrift: missing when HA has no automation", () => {
  assert.equal(hubDrift(m, null).status, "missing");
});

test("hubDrift: ok when HA matches (order-independent)", () => {
  const back = { use_blueprint: { path: BLUEPRINT_USE_PATH, input: { lights: ["light.b", "light.a"], brightness_tolerance: 4 } } };
  assert.equal(hubDrift(m, back).status, "ok");
});

test("hubDrift: drifted when the member list or tolerance differs", () => {
  const changedLights = hubDrift(m, { use_blueprint: { path: BLUEPRINT_USE_PATH, input: { lights: ["light.a", "light.c"], brightness_tolerance: 4 } } });
  assert.equal(changedLights.status, "drifted");
  assert.match(changedLights.detail, /extra: light\.c/);
  assert.match(changedLights.detail, /missing: light\.b/);
  const changedTol = hubDrift(m, { use_blueprint: { path: BLUEPRINT_USE_PATH, input: { lights: ["light.a", "light.b"], brightness_tolerance: 10 } } });
  assert.equal(changedTol.status, "drifted");
  assert.match(changedTol.detail, /tolerance is 10 in HA vs 4/);
});

test("hubDrift: detached when the automation no longer uses our blueprint", () => {
  assert.equal(hubDrift(m, { alias: "x", trigger: [] }).status, "detached");
  assert.equal(hubDrift(m, { use_blueprint: { path: "someone_else/other.yaml", input: {} } }).status, "detached");
});

test("mirrors.yaml round-trips hub mirrors alongside native mirrors", () => {
  const dir = mkdtempSync(join(tmpdir(), "zwa-hub-"));
  const file = join(dir, "mirrors.yaml");
  try {
    const doc = {
      mirrors: [{ name: "Closet", members: [10, 11], primary: 10, capabilities: ["onoff", "level"] as any }],
      hubMirrors: [{ name: "Kitchen", entities: ["light.a", "light.b"], tolerance: 5 }],
    };
    saveMirrors(file, doc);
    const back = loadMirrors(file);
    assert.equal(back.hubMirrors!.length, 1);
    assert.deepEqual(back.hubMirrors![0], { name: "Kitchen", entities: ["light.a", "light.b"], tolerance: 5 });
    assert.equal(back.mirrors.length, 1);
    assert.equal(back.mirrors[0].name, "Closet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
