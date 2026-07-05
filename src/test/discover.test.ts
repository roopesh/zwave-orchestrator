import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAdapter, wired } from "./mock.ts";
import { discoverGangs } from "../topology/discover.ts";

test("discovery groups companions under their load", async () => {
  const a = new MockAdapter([
    { id: 1, isController: true },
    { id: 2, name: "Ceiling", location: "Kitchen" },
    { id: 3, assoc: wired(2) },
    { id: 4, assoc: wired(2) },
  ]);
  const gangs = await discoverGangs(a);
  assert.equal(gangs.length, 1);
  assert.equal(gangs[0].load, 2);
  assert.deepEqual(gangs[0].companions, [3, 4]);
  assert.deepEqual(gangs[0].capabilities, ["onoff", "level", "dim"]);
});

test("discovery suppresses reverse/broadcast links (no phantom gangs)", async () => {
  const a = new MockAdapter([
    { id: 1, isController: true },
    { id: 2, name: "Ceiling", location: "Kitchen", assoc: { 3: [{ nodeId: 3 }, { nodeId: 4 }] } }, // load broadcasts to companions
    { id: 3, assoc: wired(2) },
    { id: 4, assoc: wired(2) },
  ]);
  const gangs = await discoverGangs(a);
  assert.deepEqual(gangs.map((g) => g.load), [2], "only #2 is a load; #3/#4 must not become phantom loads");
  assert.deepEqual(gangs[0].companions, [3, 4]);
});

test("discovery ignores Long Range nodes", async () => {
  const a = new MockAdapter([
    { id: 1, isController: true },
    { id: 2 },
    { id: 3, assoc: wired(2) },
    { id: 256, isLongRange: true, assoc: wired(2) },
  ]);
  const gangs = await discoverGangs(a);
  assert.deepEqual(gangs[0].companions, [3], "LR node should not appear as a companion");
});
