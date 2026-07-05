import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTopology, saveTopology } from "../topology/gangs.ts";

const tmp = (n: string) => join(tmpdir(), `zwa-${n}-${process.pid}.yaml`);

test("saveTopology handles raw-number companions (the null-companion bug)", () => {
  const path = tmp("g1");
  // Exactly what the UI sends: companions as raw node ids.
  const topo: any = { defaults: { profile: "full" }, gangs: [{ name: "K", load: 2, companions: [3, 4], profile: "full" }] };
  saveTopology(path, topo);
  const reloaded = loadTopology(path);
  assert.deepEqual(reloaded.gangs[0].companions, [{ node: 3 }, { node: 4 }]);
  rmSync(path, { force: true });
});

test("saveTopology round-trips ledSync, profile, and per-companion overrides", () => {
  const path = tmp("g2");
  const topo: any = { defaults: { profile: "full" }, gangs: [{ name: "K", load: 2, companions: [{ node: 3, capabilities: ["onoff"] }], profile: "full", ledSync: true }] };
  saveTopology(path, topo);
  const r = loadTopology(path);
  assert.equal(r.gangs[0].ledSync, true);
  assert.equal(r.gangs[0].profile, "full");
  assert.equal(r.gangs[0].companions[0].node, 3);
  assert.deepEqual(r.gangs[0].companions[0].capabilities, ["onoff"]);
  rmSync(path, { force: true });
});

test("loadTopology returns an empty topology when the file is missing", () => {
  const t = loadTopology(join(tmpdir(), "definitely-does-not-exist-zwa.yaml"));
  assert.deepEqual(t.gangs, []);
});
