import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAdapter, wired } from "./mock.ts";
import { computePlan, computeStale, computeTeardown } from "../topology/plan.ts";
import type { Topology } from "../topology/gangs.ts";

const controller = { id: 1, isController: true };
const gang = (over: any): Topology => ({ defaults: { profile: "full" }, gangs: [{ name: "K", load: 2, profile: "full", ...over }] });

test("computePlan proposes the missing companion links", async () => {
  const a = new MockAdapter([controller, { id: 2 }, { id: 3, assoc: { 2: [{ nodeId: 2 }] } }]); // only on/off wired
  const plan = await computePlan(a, gang({ companions: [{ node: 3 }] }));
  assert.deepEqual(plan.actions.filter((x) => x.source === 3).map((x) => x.group).sort(), [3, 4]);
  assert.equal(plan.satisfied, 1);
});

test("computePlan flags a Long Range companion and adds nothing", async () => {
  const a = new MockAdapter([controller, { id: 2 }, { id: 256, isLongRange: true }]);
  const plan = await computePlan(a, gang({ companions: [{ node: 256 }] }));
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.issues.filter((i) => i.code === "LONG_RANGE").length, 1);
});

test("computeStale removes a companion dropped from the gang", async () => {
  const a = new MockAdapter([controller, { id: 2 }, { id: 3, assoc: wired(2) }, { id: 4, assoc: wired(2) }]);
  const stale = await computeStale(a, gang({ companions: [{ node: 3 }] })); // #4 removed
  assert.equal(stale.actions.filter((x) => x.source === 4 && x.target === 2).length, 3);
  assert.equal(stale.actions.filter((x) => x.source === 3).length, 0);
});

test("computeStale flags only the extra group, keeps desired links", async () => {
  const a = new MockAdapter([controller, { id: 2 }, { id: 3, assoc: { 2: [{ nodeId: 2 }], 3: [{ nodeId: 2 }], 4: [{ nodeId: 2 }], 5: [{ nodeId: 2 }] } }]);
  const stale = await computeStale(a, gang({ companions: [{ node: 3 }] }));
  assert.deepEqual(stale.actions.map((x) => x.group), [5]);
});

test("computeStale flags an orphaned load->companion broadcast when ledSync is off", async () => {
  const a = new MockAdapter([controller, { id: 2, assoc: { 3: [{ nodeId: 3 }] } }, { id: 3, assoc: wired(2) }]);
  const stale = await computeStale(a, gang({ companions: [{ node: 3 }] }));
  assert.equal(stale.actions.filter((x) => x.source === 2 && x.target === 3).length, 1);
});

test("ledSync makes the load->companion broadcast desired (not stale, and planned)", async () => {
  const a = new MockAdapter([controller, { id: 2 }, { id: 3, assoc: wired(2) }]);
  const topo = gang({ companions: [{ node: 3 }], ledSync: true });
  const plan = await computePlan(a, topo);
  assert.equal(plan.actions.filter((x) => x.source === 2 && x.target === 3 && x.group === 3).length, 1);
  const stale = await computeStale(a, topo);
  assert.equal(stale.actions.filter((x) => x.source === 2).length, 0);
});

test("computeTeardown removes all managed links", async () => {
  const a = new MockAdapter([controller, { id: 2 }, { id: 3, assoc: wired(2) }]);
  const td = await computeTeardown(a, gang({ companions: [{ node: 3 }] }));
  assert.equal(td.actions.length, 3);
  assert.ok(td.actions.every((x) => x.kind === "remove"));
});
