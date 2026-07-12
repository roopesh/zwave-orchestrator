import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodeActions, computeCodePlan, ensureSlots, findPinLengthParam, importCandidates,
  loadCodes, saveCodes, validateCodes,
  type CodeAction, type CodesDoc, type CodeTransport,
} from "../topology/codes.ts";
import type { ConfigParam, UserCodeSlot } from "../types.ts";

const doc = (over: Partial<CodesDoc> = {}): CodesDoc => ({
  pinLength: 4,
  locks: [{ node: 30, name: "Front Door" }, { node: 45, name: "Back Door" }],
  codes: [],
  ...over,
});
const entry = (over: Partial<any> = {}) => ({ name: "X", pin: "1234", enabled: true, doors: ["Front Door"], slot: 3, ...over });

// ---- validation ----
test("validate accepts a clean doc", () => {
  const d = doc({ codes: [entry({ name: "Roopesh", pin: "1234", slot: 3 }), entry({ name: "Wife", pin: "5678", slot: 4 })] });
  assert.deepEqual(validateCodes(d), []);
});

test("validate catches wrong length, non-digits, all-zeros, duplicate pin/name, unknown door, bad pinLength", () => {
  const bad = doc({
    pinLength: 4,
    codes: [
      entry({ name: "A", pin: "123", slot: 3 }), // too short
      entry({ name: "B", pin: "12ab", slot: 4 }), // non-digit
      entry({ name: "C", pin: "0000", slot: 5 }), // reserved
      entry({ name: "D", pin: "1234", slot: 6 }),
      entry({ name: "d", pin: "1234", slot: 7 }), // dup name (case-insensitive) + dup pin
      entry({ name: "E", pin: "9999", doors: ["Garage"], slot: 8 }), // unknown door
    ],
  });
  const codes = validateCodes(bad).map((i) => i.code);
  assert.ok(codes.includes("BAD_PIN_LENGTH"));
  assert.ok(codes.includes("PIN_NOT_DIGITS"));
  assert.ok(codes.includes("PIN_RESERVED"));
  assert.ok(codes.includes("DUPLICATE_NAME"));
  assert.ok(codes.includes("DUPLICATE_PIN"));
  assert.ok(codes.includes("UNKNOWN_DOOR"));

  assert.ok(validateCodes(doc({ pinLength: 3 })).some((i) => i.code === "BAD_PIN_LENGTH_SETTING"));
  assert.ok(validateCodes(doc({ pinLength: 9 })).some((i) => i.code === "BAD_PIN_LENGTH_SETTING"));
});

// ---- slot allocation ----
test("ensureSlots assigns the lowest free managed slot starting at 3", () => {
  const d = doc({ codes: [entry({ name: "A", slot: 0 }), entry({ name: "B", slot: 0 }), entry({ name: "C", slot: 0 })] });
  ensureSlots(d);
  assert.deepEqual(d.codes.map((c) => c.slot), [3, 4, 5]);
});

test("ensureSlots preserves existing slots and fills a freed gap", () => {
  // A=3, C=5 already assigned; B needs one -> should take the freed 4, not 6.
  const d = doc({ codes: [entry({ name: "A", slot: 3 }), entry({ name: "B", slot: 0 }), entry({ name: "C", slot: 5 })] });
  ensureSlots(d);
  assert.equal(d.codes.find((c) => c.name === "A")!.slot, 3);
  assert.equal(d.codes.find((c) => c.name === "C")!.slot, 5);
  assert.equal(d.codes.find((c) => c.name === "B")!.slot, 4);
});

test("deleting a code frees its slot for the next new code (global reservation released)", () => {
  const d = doc({ codes: [entry({ name: "A", slot: 3 }), entry({ name: "Cleaner", slot: 5 })] });
  // remove Cleaner (slot 5 now free), add a new code with no slot
  d.codes = d.codes.filter((c) => c.name !== "Cleaner");
  d.codes.push(entry({ name: "New", slot: 0 }));
  ensureSlots(d);
  assert.equal(d.codes.find((c) => c.name === "New")!.slot, 4); // lowest free (4), then 5 available too
});

// ---- plan / diff ----
const slot = (s: number, status: number, code: string): UserCodeSlot => ({ slot: s, status, code });

test("plan sets a missing code on the assigned door only", () => {
  const d = doc({ codes: [entry({ name: "Roopesh", pin: "1234", doors: ["Front Door"], slot: 3 })] });
  const plan = computeCodePlan(d, { 30: [], 45: [] });
  assert.equal(plan.length, 1);
  assert.deepEqual({ kind: plan[0].kind, node: plan[0].node, slot: plan[0].slot, pin: plan[0].pin }, { kind: "set", node: 30, slot: 3, pin: "1234" });
});

test("plan is empty when the lock already matches (enabled + same pin)", () => {
  const d = doc({ codes: [entry({ name: "Roopesh", pin: "1234", doors: ["Front Door"], slot: 3 })] });
  const plan = computeCodePlan(d, { 30: [slot(3, 1, "1234")], 45: [] });
  assert.equal(plan.length, 0);
});

test("plan updates when the PIN changed on the lock", () => {
  const d = doc({ codes: [entry({ name: "Roopesh", pin: "1234", doors: ["Front Door"], slot: 3 })] });
  const plan = computeCodePlan(d, { 30: [slot(3, 1, "9999")], 45: [] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, "set");
  assert.equal(plan[0].reason, "code-changed");
});

test("plan clears a globally-disabled code that still sits on a lock", () => {
  const d = doc({ codes: [entry({ name: "Cleaner", pin: "1234", enabled: false, doors: ["Front Door"], slot: 5 })] });
  const plan = computeCodePlan(d, { 30: [slot(5, 1, "1234")], 45: [] });
  assert.equal(plan.length, 1);
  assert.deepEqual({ kind: plan[0].kind, node: plan[0].node, slot: plan[0].slot, reason: plan[0].reason }, { kind: "clear", node: 30, slot: 5, reason: "disabled" });
});

test("plan clears a code from a door it was removed from, keeps it on the others", () => {
  const d = doc({ codes: [entry({ name: "Cleaner", pin: "1234", enabled: true, doors: ["Front Door"], slot: 5 })] });
  // currently present on BOTH locks; desired only on Front Door
  const plan = computeCodePlan(d, { 30: [slot(5, 1, "1234")], 45: [slot(5, 1, "1234")] });
  assert.equal(plan.length, 1);
  assert.deepEqual({ kind: plan[0].kind, node: plan[0].node, reason: plan[0].reason }, { kind: "clear", node: 45, reason: "removed-from-door" });
});

test("SAFETY: a code in an unmanaged slot (hand-programmed, no entry) is never touched", () => {
  const d = doc({ codes: [entry({ name: "Roopesh", pin: "1234", doors: ["Front Door"], slot: 3 })] });
  // slot 7 has a code but no entry owns it; slot 1 is a factory slot with a code
  const plan = computeCodePlan(d, { 30: [slot(3, 1, "1234"), slot(7, 1, "8888"), slot(1, 1, "0000")], 45: [] });
  assert.equal(plan.length, 0); // only slot 3 is ours and it already matches
});

test("plan re-enables a disabled slot that should be active", () => {
  const d = doc({ codes: [entry({ name: "Roopesh", pin: "1234", doors: ["Front Door"], slot: 3 })] });
  const plan = computeCodePlan(d, { 30: [slot(3, 2, "1234")], 45: [] }); // status 2 = Disabled
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, "set");
  assert.equal(plan[0].reason, "re-enable");
});

// ---- import ----
test("importCandidates proposes only occupied managed slots not already owned", () => {
  const d = doc({ codes: [entry({ name: "Roopesh", pin: "1234", slot: 3 })] });
  const live: UserCodeSlot[] = [
    slot(1, 1, "1111"), // factory slot — skip
    slot(3, 1, "1234"), // already owned — skip
    slot(4, 1, "5678"), // NEW -> candidate
    slot(6, 0, ""), // available/empty — skip
    slot(8, 2, "4321"), // disabled but has a code -> candidate (enabled:false)
  ];
  const cands = importCandidates(d, { node: 30, name: "Front Door" }, live);
  assert.deepEqual(cands.map((c) => ({ slot: c.slot, pin: c.pin, enabled: c.enabled })), [
    { slot: 4, pin: "5678", enabled: true },
    { slot: 8, pin: "4321", enabled: false },
  ]);
  assert.deepEqual(cands[0].doors, ["Front Door"]);
});

// ---- round trip ----
test("codes.yaml round-trips through load/save", () => {
  const path = join(tmpdir(), `zwa-codes-${process.pid}.yaml`);
  const d = doc({ pinLength: 6, codes: [entry({ name: "Roopesh", pin: "123456", doors: ["Front Door", "Back Door"], slot: 3 }), entry({ name: "Cleaner", pin: "654321", enabled: false, doors: ["Front Door"], slot: 5 })] });
  saveCodes(path, d);
  assert.deepEqual(loadCodes(path), d);
  rmSync(path, { force: true });
});

test("loadCodes returns an empty doc when the file is missing", () => {
  assert.deepEqual(loadCodes(join(tmpdir(), "definitely-missing-codes-zwa.yaml")), { pinLength: 4, locks: [], codes: [] });
});

// ---- write path (fake in-memory lock) ----
class FakeLock implements CodeTransport {
  node = 30;
  slots = new Map<number, UserCodeSlot>();
  throwOnSet = false;
  noopWrites = false; // write reports back but doesn't actually change state
  writeStatus = 255; // 255/254 = supervised success; anything else = ambiguous
  async getUserCodes() { return { [this.node]: [...this.slots.values()].sort((a, b) => a.slot - b.slot) }; }
  async setUserCode(_node: number, slot: number, code: string) {
    if (this.throwOnSet) throw new Error("controller busy");
    if (!this.noopWrites) this.slots.set(slot, { slot, status: 1, code });
    return this.writeStatus;
  }
  async clearUserCode(_node: number, slot: number) {
    if (!this.noopWrites) this.slots.delete(slot);
    return this.writeStatus;
  }
}
const setAction = (over: Partial<CodeAction> = {}): CodeAction => ({ kind: "set", node: 30, lockName: "Front Door", slot: 3, name: "X", pin: "1234", reason: "missing", ...over });

test("applyCodeActions sets a code and verifies it by read-back", async () => {
  const lock = new FakeLock();
  const res = await applyCodeActions(lock, [setAction({ pin: "4471" })], { maxTries: 1, settleMs: 0 });
  assert.equal(res.length, 1);
  assert.ok(res[0].ok);
  assert.deepEqual(lock.slots.get(3), { slot: 3, status: 1, code: "4471" });
});

test("applyCodeActions clears a slot and verifies it's gone", async () => {
  const lock = new FakeLock();
  lock.slots.set(5, { slot: 5, status: 1, code: "9999" });
  const res = await applyCodeActions(lock, [{ kind: "clear", node: 30, lockName: "Front Door", slot: 5, name: "Cleaner", reason: "disabled" }], { maxTries: 1, settleMs: 0 });
  assert.ok(res[0].ok);
  assert.equal(lock.slots.has(5), false);
});

test("a supervised success (255) counts even if read-back is still stale (async lock reporting)", async () => {
  const lock = new FakeLock();
  lock.noopWrites = true; // status says success, but the read-back hasn't caught up
  const res = await applyCodeActions(lock, [setAction()], { maxTries: 1, settleMs: 0 });
  assert.ok(res[0].ok); // trusted the 255 — this is the false-negative bug we hit live
});

test("applyCodeActions fails when NEITHER status nor read-back confirm", async () => {
  const lock = new FakeLock();
  lock.noopWrites = true; lock.writeStatus = 1; // ambiguous status + nothing changed
  const res = await applyCodeActions(lock, [setAction()], { maxTries: 1, settleMs: 0 });
  assert.equal(res[0].ok, false);
  assert.match(res[0].error ?? "", /not confirmed|read-back/);
});

test("applyCodeActions catches a thrown write and never leaks the PIN in the error", async () => {
  const lock = new FakeLock();
  lock.throwOnSet = true;
  const res = await applyCodeActions(lock, [setAction({ pin: "8675" })], { maxTries: 1, settleMs: 0 });
  assert.equal(res[0].ok, false);
  assert.ok(!(res[0].error ?? "").includes("8675"));
});

test("findPinLengthParam matches the lock's PIN-length parameter by label", () => {
  const params: ConfigParam[] = [
    { param: 3, label: "Beeper", value: 255, writeable: true },
    { param: 16, label: "User Code PIN Length", value: 4, writeable: true },
    { param: 12, label: "Electronic Transition Count", value: 5, writeable: false },
  ];
  const def = findPinLengthParam(params);
  assert.equal(def?.param, 16);
});
