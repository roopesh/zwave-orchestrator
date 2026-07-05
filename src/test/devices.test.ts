import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeDevices, fingerprintOf, loadDevices, remapNodeId, saveDevices } from "../topology/devices.ts";

const node = (id: number, over: any = {}) => ({ id, name: "", location: "", product: "Inovelli VZW31-SN", isController: false, isLongRange: false, supports: ["onoff", "level", "dim"], ...over });

test("new association-capable devices are eligible; sensors are not", () => {
  const nodes = [
    node(2),
    node(3, { supports: [] }), // e.g. a sensor — no control capability
  ];
  const { status } = analyzeDevices(nodes, { devices: [] });
  assert.equal(status[2].disposition, "new");
  assert.equal(status[2].groupEligible, true);
  assert.equal(status[3].groupEligible, false);
});

test("ignored devices are not eligible; adopted always are", () => {
  const nodes = [node(2), node(3)];
  const reg = { devices: [
    { id: 2, fingerprint: fingerprintOf(node(2)), disposition: "ignored" as const },
    { id: 3, fingerprint: fingerprintOf(node(3)), disposition: "adopted" as const },
  ] };
  const { status } = analyzeDevices(nodes, reg);
  assert.equal(status[2].groupEligible, false);
  assert.equal(status[3].groupEligible, true);
});

test("detects a changed fingerprint (renamed / re-purposed under the same id)", () => {
  const nodes = [node(2, { name: "Kitchen Counter" })];
  const reg = { devices: [{ id: 2, fingerprint: fingerprintOf(node(2, { name: "Kitchen Ceiling" })), disposition: "adopted" as const }] };
  const { status } = analyzeDevices(nodes, reg);
  assert.equal(status[2].changed, true);
});

test("detects removed devices and re-pair candidates by fingerprint", () => {
  const oldFp = fingerprintOf(node(12, { name: "Island", location: "Kitchen" }));
  const nodes = [node(40, { name: "Island", location: "Kitchen" })]; // same fingerprint, new id
  const reg = { devices: [{ id: 12, fingerprint: oldFp, disposition: "adopted" as const }] };
  const { removed, repairCandidates } = analyzeDevices(nodes, reg);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 12);
  assert.equal(repairCandidates.length, 1);
  assert.deepEqual({ from: repairCandidates[0].from.id, to: repairCandidates[0].to }, { from: 12, to: 40 });
});

test("remapNodeId repoints gangs, policies, and the registry", () => {
  const topo: any = { defaults: {}, gangs: [{ name: "K", load: 6, companions: [{ node: 12 }, { node: 5 }] }] };
  const policies: any = { policies: [{ name: "P", targets: [12, 6], settings: [{ param: 1, value: 0 }] }] };
  const registry: any = { devices: [{ id: 12, fingerprint: "old", disposition: "ignored" }] };
  remapNodeId(12, 40, "new-fp", topo, policies, registry);
  assert.deepEqual(topo.gangs[0].companions.map((c: any) => c.node), [40, 5]);
  assert.deepEqual(policies.policies[0].targets, [40, 6]);
  assert.equal(registry.devices.find((d: any) => d.id === 12), undefined);
  assert.deepEqual(registry.devices.find((d: any) => d.id === 40), { id: 40, fingerprint: "new-fp", disposition: "ignored" });
});

test("remapNodeId repoints a load", () => {
  const topo: any = { defaults: {}, gangs: [{ name: "K", load: 12, companions: [{ node: 5 }] }] };
  remapNodeId(12, 40, "fp", topo, { policies: [] }, { devices: [] });
  assert.equal(topo.gangs[0].load, 40);
});

test("registry round-trips through yaml", () => {
  const path = join(tmpdir(), `zwa-dev-${process.pid}.yaml`);
  const reg = { devices: [{ id: 2, fingerprint: "a|b|c", disposition: "adopted" as const }, { id: 5, fingerprint: "x|y|z", disposition: "ignored" as const }] };
  saveDevices(path, reg);
  assert.deepEqual(loadDevices(path), reg);
  rmSync(path, { force: true });
});
