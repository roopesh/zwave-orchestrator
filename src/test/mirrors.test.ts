import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "./mock.ts";
import { computeMirrorPlan, computeMirrorTeardown, loadMirrors, saveMirrors, type MirrorDoc, type MirrorSpec } from "../topology/mirrors.ts";
import type { ConfigParam } from "../types.ts";
import type { CapabilityId } from "../topology/capabilities.ts";

// Inovelli param 59 split into the two bits the mirror manages.
const p59 = (sendLocal: number, forward: number): ConfigParam[] => [
  { param: 59, key: 1, label: "Send Local Commands to Associated Devices", value: sendLocal, writeable: true, options: [{ value: 0, label: "Disable" }, { value: 1, label: "Enable" }] },
  { param: 59, key: 2, label: "Forward Z-Wave Commands to Associated Devices", value: forward, writeable: true, options: [{ value: 0, label: "Disable" }, { value: 1, label: "Enable" }] },
];
const wired = (peer: number) => ({ 2: [{ nodeId: peer }], 3: [{ nodeId: peer }], 4: [{ nodeId: peer }] });
const CAPS: CapabilityId[] = ["onoff", "level", "dim"];
const mir = (over: Partial<MirrorSpec> = {}): MirrorSpec => ({ name: "Closet", members: [59, 60], primary: 59, capabilities: CAPS, ...over });

test("plans a full bidirectional mesh + forwarding only on the primary", async () => {
  const a = new MockAdapter([
    { id: 59, params: p59(1, 0) },
    { id: 60, params: p59(1, 0) },
  ]);
  const plan = await computeMirrorPlan(a, { mirrors: [mir()] });
  // 2 members x 1 peer x 3 groups (2,3,4) = 6 add actions
  assert.equal(plan.actions.length, 6);
  assert.deepEqual([...new Set(plan.actions.map((x) => x.group))].sort(), [2, 3, 4]);
  assert.ok(plan.actions.every((x) => x.kind === "add"));
  // only the primary's forward bit needs flipping on (send-local already 1, secondary forward already 0)
  assert.equal(plan.paramActions.length, 1);
  assert.deepEqual({ node: plan.paramActions[0].node, key: plan.paramActions[0].key, desired: plan.paramActions[0].desired }, { node: 59, key: 2, desired: 1 });
});

test("already-wired mirror plans nothing", async () => {
  const a = new MockAdapter([
    { id: 59, assoc: wired(60), params: p59(1, 1) }, // primary: forward on
    { id: 60, assoc: wired(59), params: p59(1, 0) }, // secondary: forward off
  ]);
  const plan = await computeMirrorPlan(a, { mirrors: [mir()] });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.paramActions.length, 0);
  assert.ok(plan.satisfied > 0);
});

test("secondary with forwarding wrongly ON is planned back OFF", async () => {
  const a = new MockAdapter([
    { id: 59, assoc: wired(60), params: p59(1, 1) },
    { id: 60, assoc: wired(59), params: p59(1, 1) }, // WRONG: forward on
  ]);
  const plan = await computeMirrorPlan(a, { mirrors: [mir()] });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.paramActions.length, 1);
  assert.deepEqual({ node: plan.paramActions[0].node, key: plan.paramActions[0].key, desired: plan.paramActions[0].desired }, { node: 60, key: 2, desired: 0 });
});

test("capabilities scope the groups (onoff only -> just group 2)", async () => {
  const a = new MockAdapter([{ id: 59, params: p59(1, 0) }, { id: 60, params: p59(1, 0) }]);
  const plan = await computeMirrorPlan(a, { mirrors: [mir({ capabilities: ["onoff"] as CapabilityId[] })] });
  assert.deepEqual([...new Set(plan.actions.map((x) => x.group))], [2]);
  assert.equal(plan.actions.length, 2); // 59->60 g2, 60->59 g2
});

test("a member off the mesh is flagged, not silently dropped", async () => {
  const a = new MockAdapter([{ id: 59, params: p59(1, 0) }]); // 60 missing
  const plan = await computeMirrorPlan(a, { mirrors: [mir()] });
  assert.ok(plan.issues.some((i) => i.code === "MISSING_NODE" && i.node === 60));
  assert.ok(plan.issues.some((i) => i.code === "TOO_FEW"));
});

test("teardown removes every inter-member association", async () => {
  const a = new MockAdapter([{ id: 59, assoc: wired(60), params: p59(1, 1) }, { id: 60, assoc: wired(59), params: p59(1, 0) }]);
  const actions = await computeMirrorTeardown(a, mir());
  assert.equal(actions.length, 6);
  assert.ok(actions.every((x) => x.kind === "remove"));
});

test("mirrors.yaml round-trips", () => {
  const path = join(tmpdir(), `zwa-mirrors-${process.pid}.yaml`);
  const doc: MirrorDoc = { mirrors: [{ name: "Closet", members: [59, 60], primary: 59, capabilities: ["onoff", "level", "dim"] }] };
  saveMirrors(path, doc);
  assert.deepEqual(loadMirrors(path), doc);
  rmSync(path, { force: true });
});
