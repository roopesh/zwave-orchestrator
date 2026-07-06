import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAdapter, wired } from "./mock.ts";
import { applyParamActions, computeParamPlan, resolveTargets } from "../topology/paramPlan.ts";
import { computePlan } from "../topology/plan.ts";
import type { Topology } from "../topology/gangs.ts";
import type { ConfigParam } from "../types.ts";

const enableDisable = (over: Partial<ConfigParam>): ConfigParam => ({
  param: 59,
  label: "x",
  value: 0,
  default: 0,
  writeable: true,
  options: [
    { value: 0, label: "Disable" },
    { value: 1, label: "Enable" },
  ],
  ...over,
});

/** Inovelli-style param 59 split into two bitmask sub-settings. */
const p59 = (localVal: number, forwardVal: number): ConfigParam[] => [
  enableDisable({ key: 1, label: "Send Local Commands to Associated Devices", value: localVal, default: 1 }),
  enableDisable({ key: 2, label: "Forward Z-Wave Commands to Associated Devices", value: forwardVal }),
];

test("bitmask sub-settings diff and apply independently", async () => {
  const a = new MockAdapter([{ id: 2, params: p59(1, 0) }]);
  const doc = { policies: [{ name: "F", targets: [2], settings: [{ param: 59, key: 2, value: 1 }] }] };
  const plan = await computeParamPlan(a, doc);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].key, 2);
  assert.equal(plan.actions[0].label, "Forward Z-Wave Commands to Associated Devices");

  const results = await applyParamActions(a, plan.actions);
  assert.ok(results.every((r) => r.ok));
  // key 2 flipped, key 1 untouched
  const params = (await a.getConfigParams())[2];
  assert.equal(params.find((p) => p.key === 2)!.value, 1);
  assert.equal(params.find((p) => p.key === 1)!.value, 1);
  const after = await computeParamPlan(a, doc);
  assert.equal(after.actions.length, 0);
  assert.equal(after.satisfied, 1);
});

test("a setting without key does not match a bitmask sub-setting (and warns NO_PARAM)", async () => {
  const a = new MockAdapter([{ id: 2, params: p59(1, 0) }]);
  const doc = { policies: [{ name: "F", targets: [2], settings: [{ param: 59, value: 1 }] }] };
  const plan = await computeParamPlan(a, doc);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.issues.filter((i) => i.code === "NO_PARAM").length, 1);
});

const topo: Topology = {
  defaults: {},
  gangs: [{ name: "Hall", load: 26, companions: [{ node: 20 }, { node: 21 }] }],
};

test("resolveTargets expands gang targets by role and dedupes with explicit ids", () => {
  const pol = (role: "all" | "load" | "companions") => ({ name: "P", targets: [20], gangTargets: [{ gang: "Hall", role }], settings: [] });
  assert.deepEqual(resolveTargets(pol("all"), topo), [20, 21, 26]);
  assert.deepEqual(resolveTargets(pol("load"), topo), [20, 26]);
  assert.deepEqual(resolveTargets(pol("companions"), topo), [20, 21]);
});

test("a missing gang target warns NO_GANG and is skipped", async () => {
  const a = new MockAdapter([{ id: 26, params: p59(1, 0) }]);
  const doc = { policies: [{ name: "P", targets: [], gangTargets: [{ gang: "Ghost", role: "load" as const }], settings: [{ param: 59, key: 2, value: 1 }] }] };
  const plan = await computeParamPlan(a, doc, topo);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.issues.filter((i) => i.code === "NO_GANG").length, 1);
});

test("gang-targeted policy plans against current membership", async () => {
  const a = new MockAdapter([
    { id: 26, params: p59(1, 0) },
    { id: 20, params: p59(1, 0) },
    { id: 21, params: p59(1, 1) }, // already correct
  ]);
  const doc = { policies: [{ name: "P", targets: [], gangTargets: [{ gang: "Hall", role: "all" as const }], settings: [{ param: 59, key: 2, value: 1 }] }] };
  const plan = await computeParamPlan(a, doc, topo);
  assert.deepEqual(plan.actions.map((x) => x.node).sort(), [20, 26]);
  assert.equal(plan.satisfied, 1);
});

test("computePlan with forwardRemote emits a param fix for the load", async () => {
  const a = new MockAdapter([
    { id: 1, isController: true },
    { id: 26, params: p59(1, 0) },
    { id: 20, assoc: wired(26), params: p59(1, 0) },
  ]);
  const t: Topology = { defaults: { profile: "full" }, gangs: [{ name: "Hall", load: 26, companions: [{ node: 20 }], profile: "full", forwardRemote: true }] };
  const plan = await computePlan(a, t);
  assert.equal(plan.paramActions.length, 1);
  assert.deepEqual(
    { node: plan.paramActions[0].node, param: plan.paramActions[0].param, key: plan.paramActions[0].key, desired: plan.paramActions[0].desired },
    { node: 26, param: 59, key: 2, desired: 1 },
  );
});

test("computePlan forwardRemote=false disables the load's forwarding when it's on", async () => {
  const a = new MockAdapter([{ id: 1, isController: true }, { id: 26, params: p59(1, 1) }, { id: 20, assoc: wired(26) }]);
  const t: Topology = { defaults: { profile: "full" }, gangs: [{ name: "Hall", load: 26, companions: [{ node: 20 }], profile: "full", forwardRemote: false }] };
  const plan = await computePlan(a, t);
  assert.equal(plan.paramActions.length, 1);
  assert.equal(plan.paramActions[0].desired, 0);
  assert.equal(plan.paramActions[0].node, 26);
});

test("computePlan forwardRemote=undefined leaves the load's forwarding untouched", async () => {
  const a = new MockAdapter([{ id: 1, isController: true }, { id: 26, params: p59(1, 1) }, { id: 20, assoc: wired(26) }]);
  const t: Topology = { defaults: { profile: "full" }, gangs: [{ name: "Hall", load: 26, companions: [{ node: 20 }], profile: "full" }] };
  const plan = await computePlan(a, t);
  assert.equal(plan.paramActions.length, 0);
});

test("computePlan forwardRemote: satisfied when already enabled, warns when device lacks it", async () => {
  const ok = new MockAdapter([{ id: 1, isController: true }, { id: 26, params: p59(1, 1) }, { id: 20, assoc: wired(26) }]);
  const t: Topology = { defaults: { profile: "full" }, gangs: [{ name: "Hall", load: 26, companions: [{ node: 20 }], profile: "full", forwardRemote: true }] };
  const plan1 = await computePlan(ok, t);
  assert.equal(plan1.paramActions.length, 0);

  const lacks = new MockAdapter([{ id: 1, isController: true }, { id: 26, params: [] }, { id: 20, assoc: wired(26) }]);
  const plan2 = await computePlan(lacks, t);
  assert.equal(plan2.paramActions.length, 0);
  assert.equal(plan2.issues.filter((i) => i.code === "NO_SETTING").length, 1);
});
