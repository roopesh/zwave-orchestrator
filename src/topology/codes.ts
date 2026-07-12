// User-code management (Command Class 99) — declarative, mirroring the gangs/policies engine:
// codes.yaml is the source of truth, diffed against each lock's live slots to a set of actions.
//
// Model: a CODE is a named PIN with a set of doors (lock names) and a global slot number. The
// slot is tool-assigned, held for that code across ALL locks while the code exists, and freed
// when the code is deleted. Slots 0/1/2 are reserved (0 = master, 1/2 = Schlage factory codes),
// so managed slots run 3..30. PINs are digit strings of a single house-wide length (Schlage 4-8),
// unique across all codes so access logs are unambiguous.
//
// SAFETY: this engine never touches a slot it doesn't own. A code sitting in a managed slot that
// no entry claims (someone programmed it by hand) is left strictly alone — importing it is the
// only way it becomes managed. Deleting an entry is handled at the apply layer (clear the slot on
// the hardware, like gang teardown), NOT here — computeCodePlan only reconciles entries that exist.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { ConfigParam, UserCodeSlot } from "../types.ts";

/** Reserved: slot 0 = master/all-users, slots 1-2 = Schlage factory defaults. Never managed. */
export const MANAGED_SLOT_MIN = 3;
export const MANAGED_SLOT_MAX = 30; // this lock exposes slots 0..30
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8; // Schlage caps at 8 (the raw CC allows 10)
const STATUS_AVAILABLE = 0;
const STATUS_ENABLED = 1;

export interface LockRef {
  node: number;
  name: string;
}

export interface CodeEntry {
  name: string;
  pin: string;
  enabled: boolean;
  doors: string[]; // lock names this code applies to
  slot: number; // tool-assigned global slot; not user-edited
}

export interface CodesDoc {
  pinLength: number;
  locks: LockRef[];
  codes: CodeEntry[];
}

export function loadCodes(path: string): CodesDoc {
  if (!existsSync(path)) return { pinLength: MIN_PIN_LENGTH, locks: [], codes: [] };
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as any;
  return {
    pinLength: typeof raw.pinLength === "number" ? raw.pinLength : MIN_PIN_LENGTH,
    locks: (raw.locks ?? []).map((l: any) => ({ node: Number(l.node), name: String(l.name ?? "") })),
    codes: (raw.codes ?? []).map((c: any) => ({
      name: String(c.name ?? ""),
      pin: String(c.pin ?? ""),
      enabled: c.enabled !== false,
      doors: Array.isArray(c.doors) ? c.doors.map(String) : [],
      slot: Number(c.slot),
    })),
  };
}

export function saveCodes(path: string, doc: CodesDoc): void {
  const out = {
    pinLength: doc.pinLength,
    locks: doc.locks.map((l) => ({ node: l.node, name: l.name })),
    codes: doc.codes.map((c) => ({ name: c.name, pin: c.pin, enabled: c.enabled, doors: c.doors, slot: c.slot })),
  };
  writeFileSync(path, "# Managed by zwave-associations (user codes). Plaintext PINs — gitignored, never committed.\n\n" + stringify(out));
}

export interface CodeIssue {
  code: "BAD_PIN_LENGTH" | "PIN_NOT_DIGITS" | "PIN_RESERVED" | "DUPLICATE_PIN" | "DUPLICATE_NAME" | "UNKNOWN_DOOR" | "NO_SLOT" | "BAD_PIN_LENGTH_SETTING";
  name?: string;
  message: string;
}

/** Validate the whole document. Returns [] when clean. Never logs PINs. */
export function validateCodes(doc: CodesDoc): CodeIssue[] {
  const issues: CodeIssue[] = [];
  if (!Number.isInteger(doc.pinLength) || doc.pinLength < MIN_PIN_LENGTH || doc.pinLength > MAX_PIN_LENGTH) {
    issues.push({ code: "BAD_PIN_LENGTH_SETTING", message: `PIN length must be an integer ${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH}.` });
  }
  const lockNames = new Set(doc.locks.map((l) => l.name));
  const seenPins = new Map<string, string>(); // pin -> first name
  const seenNames = new Set<string>();
  for (const c of doc.codes) {
    if (seenNames.has(c.name.toLowerCase())) issues.push({ code: "DUPLICATE_NAME", name: c.name, message: `Two codes are both named "${c.name}".` });
    seenNames.add(c.name.toLowerCase());
    if (!/^\d+$/.test(c.pin)) issues.push({ code: "PIN_NOT_DIGITS", name: c.name, message: `"${c.name}" has a non-numeric PIN.` });
    else if (c.pin.length !== doc.pinLength) issues.push({ code: "BAD_PIN_LENGTH", name: c.name, message: `"${c.name}"'s PIN is ${c.pin.length} digits; all codes must be ${doc.pinLength}.` });
    else if (/^0+$/.test(c.pin)) issues.push({ code: "PIN_RESERVED", name: c.name, message: `"${c.name}" uses an all-zeros PIN, which is reserved for clearing a slot.` });
    if (c.pin && seenPins.has(c.pin)) issues.push({ code: "DUPLICATE_PIN", name: c.name, message: `"${c.name}" and "${seenPins.get(c.pin)}" share the same PIN.` });
    else if (c.pin) seenPins.set(c.pin, c.name);
    for (const d of c.doors) if (!lockNames.has(d)) issues.push({ code: "UNKNOWN_DOOR", name: c.name, message: `"${c.name}" references a lock "${d}" that isn't in your locks list.` });
    if (!Number.isInteger(c.slot) || c.slot < MANAGED_SLOT_MIN || c.slot > MANAGED_SLOT_MAX) issues.push({ code: "NO_SLOT", name: c.name, message: `"${c.name}" has no valid slot assigned.` });
  }
  return issues;
}

/** Assign a global slot to any code that lacks a valid one — lowest free managed slot. Mutates
 *  and returns the doc. Existing slots are preserved (stable); deleting a code frees its slot
 *  simply because it's no longer in the list. Throws only if all 28 managed slots are taken. */
export function ensureSlots(doc: CodesDoc): CodesDoc {
  const used = new Set<number>();
  for (const c of doc.codes) if (Number.isInteger(c.slot) && c.slot >= MANAGED_SLOT_MIN && c.slot <= MANAGED_SLOT_MAX) used.add(c.slot);
  for (const c of doc.codes) {
    if (used.has(c.slot) && c.slot >= MANAGED_SLOT_MIN) continue;
    let next = MANAGED_SLOT_MIN;
    while (used.has(next)) next++;
    if (next > MANAGED_SLOT_MAX) throw new Error(`No free lock slots left (managed range ${MANAGED_SLOT_MIN}-${MANAGED_SLOT_MAX}).`);
    c.slot = next;
    used.add(next);
  }
  return doc;
}

export interface CodeAction {
  kind: "set" | "clear";
  node: number;
  lockName: string;
  slot: number;
  name: string; // whose code — for logs/UI. The PIN itself is never logged.
  pin?: string; // present only for "set"
  reason: "missing" | "code-changed" | "re-enable" | "disabled" | "removed-from-door";
}

/** Diff desired (codes.yaml) against each lock's live slots. Only slots owned by an existing entry
 *  are ever cleared; unmanaged slots are left untouched. Deletion is handled at the apply layer. */
export function computeCodePlan(doc: CodesDoc, currentByLock: Record<number, UserCodeSlot[]>): CodeAction[] {
  const actions: CodeAction[] = [];
  const ownedSlots = new Set(doc.codes.map((c) => c.slot));
  for (const lock of doc.locks) {
    const current = currentByLock[lock.node] ?? [];
    const bySlot = new Map(current.map((s) => [s.slot, s]));
    const desired = new Map<number, CodeEntry>();
    for (const c of doc.codes) if (c.enabled && c.doors.includes(lock.name)) desired.set(c.slot, c);

    // Sets / updates: desired codes that are missing, changed, or disabled on the lock.
    for (const [slot, c] of desired) {
      const cur = bySlot.get(slot);
      if (cur && cur.status === STATUS_ENABLED && cur.code === c.pin) continue;
      const reason = !cur || cur.status === STATUS_AVAILABLE ? "missing" : cur.code !== c.pin ? "code-changed" : "re-enable";
      actions.push({ kind: "set", node: lock.node, lockName: lock.name, slot, name: c.name, pin: c.pin, reason });
    }

    // Clears: a slot we OWN that shouldn't be on this lock (code disabled, or door removed) but
    // still holds a code. Slots below the managed range, or not owned by any entry, are left alone.
    for (const cur of current) {
      if (cur.slot < MANAGED_SLOT_MIN) continue; // reserved / factory slots
      if (desired.has(cur.slot)) continue; // handled above
      if (!ownedSlots.has(cur.slot)) continue; // unmanaged / hand-programmed — never auto-wipe
      if (cur.status === STATUS_AVAILABLE && !cur.code) continue; // already clear
      const owner = doc.codes.find((c) => c.slot === cur.slot)!;
      actions.push({ kind: "clear", node: lock.node, lockName: lock.name, slot: cur.slot, name: owner.name, reason: owner.enabled ? "removed-from-door" : "disabled" });
    }
  }
  return actions;
}

/** Propose entries for codes already on a lock that no entry claims — the import/adopt path.
 *  Only occupied managed slots (>=3, not Available, non-empty PIN) that aren't already owned. */
export function importCandidates(doc: CodesDoc, lock: LockRef, slots: UserCodeSlot[]): CodeEntry[] {
  const ownedSlots = new Set(doc.codes.map((c) => c.slot));
  const out: CodeEntry[] = [];
  for (const s of slots) {
    if (s.slot < MANAGED_SLOT_MIN || s.slot > MANAGED_SLOT_MAX) continue;
    if (ownedSlots.has(s.slot)) continue;
    if (s.status === STATUS_AVAILABLE || !s.code) continue;
    out.push({ name: `Imported (slot ${s.slot})`, pin: s.code, enabled: s.status === STATUS_ENABLED, doors: [lock.name], slot: s.slot });
  }
  return out;
}

/** The lock's writeable "PIN length" config parameter, matched by label so it works per brand
 *  rather than by a hardcoded number (Schlage BE469 = param 16 "User Code PIN Length"). */
export function findPinLengthParam(params: ConfigParam[]): ConfigParam | undefined {
  return params.find((p) => p.writeable && /pin|code/i.test(p.label) && /length/i.test(p.label));
}

// ---- write path -----------------------------------------------------------------------------
// Minimal transport surface the applier needs. ZWaveAdapter implements all three; tests use a fake.
export interface CodeTransport {
  getUserCodes(): Promise<Record<number, UserCodeSlot[]>>;
  setUserCode(nodeId: number, slot: number, code: string): Promise<number>;
  clearUserCode(nodeId: number, slot: number): Promise<number>;
}

export interface CodeResult {
  action: CodeAction;
  ok: boolean;
  status?: number;
  error?: string;
}

/** True when the live read reflects the intended end state of an action. */
function codeActionVerified(a: CodeAction, after: Record<number, UserCodeSlot[]>): boolean {
  const cur = (after[a.node] ?? []).find((s) => s.slot === a.slot);
  return a.kind === "set" ? !!cur && cur.status === STATUS_ENABLED && cur.code === a.pin : !cur || cur.status === STATUS_AVAILABLE;
}

/** Apply set/clear actions to the locks, then verify. A supervised success status (255/254) is
 *  authoritative — the device acknowledged the write. Locks report the new value back
 *  asynchronously (often several seconds, longer if asleep), so we POLL the read-back: re-read
 *  until every action is reflected or we run out of tries. This both confirms writes and leaves
 *  zwave-js's cached state fresh, so the caller's follow-up plan doesn't show a phantom "pending".
 *  A success status still counts even if the poll times out. Never logs or returns a bare PIN. */
export async function applyCodeActions(adapter: CodeTransport, actions: CodeAction[], opts: { settleMs?: number; maxTries?: number } = {}): Promise<CodeResult[]> {
  const { settleMs = 1000, maxTries = 8 } = opts;
  const results: CodeResult[] = [];
  for (const a of actions) {
    try {
      const status = a.kind === "set" ? await adapter.setUserCode(a.node, a.slot, a.pin!) : await adapter.clearUserCode(a.node, a.slot);
      results.push({ action: a, ok: status === 255 || status === 254, status });
    } catch (e: any) {
      results.push({ action: a, ok: false, error: e?.message ?? String(e) });
    }
  }
  if (!results.length) return results;
  let after: Record<number, UserCodeSlot[]> = {};
  for (let i = 0; i < maxTries; i++) {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    after = await adapter.getUserCodes();
    if (results.every((r) => codeActionVerified(r.action, after))) break;
  }
  for (const r of results) {
    r.ok = r.ok || codeActionVerified(r.action, after);
    if (!r.ok && !r.error) r.error = `not confirmed (status ${r.status ?? "?"})`;
  }
  return results;
}
