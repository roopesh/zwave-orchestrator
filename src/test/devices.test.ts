import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeDevices, fingerprintOf, loadDevices, saveDevices } from "../topology/devices.ts";

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

test("registry round-trips through yaml", () => {
  const path = join(tmpdir(), `zwa-dev-${process.pid}.yaml`);
  const reg = { devices: [{ id: 2, fingerprint: "a|b|c", disposition: "adopted" as const }, { id: 5, fingerprint: "x|y|z", disposition: "ignored" as const }] };
  saveDevices(path, reg);
  assert.deepEqual(loadDevices(path), reg);
  rmSync(path, { force: true });
});
