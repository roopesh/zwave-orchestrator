#!/usr/bin/env node
// CLI entry. Commands: `dump` (read-only inventory), `plan` (diff gangs.yaml vs live).
// `apply` lands next, on top of the same adapter + planner.

import type { NodeDump } from "./types.ts";
import { parseFlags, resolveConnection } from "./config.ts";
import { ZwaveClient } from "./zwave/client.ts";
import { ZWaveAdapter } from "./zwave/adapter.ts";
import { loadTopology } from "./topology/gangs.ts";
import { computePlan, computeStale, computeTeardown, type Plan, type PlanAction } from "./topology/plan.ts";
import { applyActions } from "./topology/executor.ts";

async function main(): Promise<void> {
  const [, , command = "dump", ...rest] = process.argv;
  const flags = parseFlags(rest);
  const conn = resolveConnection(rest);
  const client = new ZwaveClient(conn.url);

  process.stderr.write(`Connecting to ${conn.url} ...\n`);
  const version = await client.connect();
  process.stderr.write(
    `Connected: zwave-js ${version.driverVersion}, server ${version.serverVersion}, ` +
      `schema ${client.schemaVersion} (homeId ${version.homeId})\n\n`,
  );
  const adapter = new ZWaveAdapter(client);

  try {
    switch (command) {
      case "dump":
        await cmdDump(adapter);
        break;
      case "plan":
        await cmdPlan(adapter, flags.file ?? "gangs.yaml");
        break;
      case "apply":
        await cmdWrite(adapter, flags.file ?? "gangs.yaml", flags, "add");
        break;
      case "teardown":
        await cmdWrite(adapter, flags.file ?? "gangs.yaml", flags, "remove");
        break;
      case "reconcile":
        await cmdReconcile(adapter, flags.file ?? "gangs.yaml", flags);
        break;
      default:
        process.stderr.write(
          `Unknown command: ${command}\n` +
            `Usage: zorc <dump|plan|apply|reconcile|teardown> [--file gangs.yaml] [--gang NAME] [--node ID] [--yes]\n` +
            `                                                        [--host H] [--port P] [--url ws://host:port]\n`,
        );
        process.exitCode = 2;
    }
  } finally {
    client.close();
  }
}

/** Read-only structured dump of every node + its association groups + current associations. */
async function cmdDump(adapter: ZWaveAdapter): Promise<void> {
  const nodes = await adapter.getNodes();
  const result: NodeDump[] = [];
  for (const n of nodes) {
    if (n.isController) {
      result.push({ ...n, groups: [], associations: {} });
      continue;
    }
    try {
      const groups = await adapter.getAssociationGroups({ nodeId: n.id });
      const associations = await adapter.getAssociations({ nodeId: n.id });
      result.push({ ...n, groups, associations });
    } catch {
      result.push({ ...n, groups: [], associations: {} });
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

/** Diff the topology against live state and print the reconcile plan + diagnostics. */
async function cmdPlan(adapter: ZWaveAdapter, file: string): Promise<void> {
  const topo = loadTopology(file);
  const plan = await computePlan(adapter, topo);
  printPlan(plan, file);
}

function printPlan(plan: Plan, file: string): void {
  const out = process.stdout;
  const removing = plan.actions[0]?.kind === "remove";
  const verb = removing ? "remove" : "add";
  const sign = removing ? "-" : "+";
  const arrow = removing ? " -x  load #" : "  ->  load #";

  out.write(`Plan from ${file}\n`);
  const prefix = removing ? "" : `${plan.satisfied} link(s) already in place, `;
  out.write(`  ${prefix}${plan.actions.length} to ${verb}.\n\n`);

  if (plan.actions.length) {
    const byGang = new Map<string, typeof plan.actions>();
    for (const a of plan.actions) {
      if (!byGang.has(a.gang)) byGang.set(a.gang, []);
      byGang.get(a.gang)!.push(a);
    }
    out.write(`WILL ${verb.toUpperCase()}:\n`);
    for (const [gang, actions] of byGang) {
      out.write(`  ${gang}\n`);
      for (const a of actions) {
        out.write(`    ${sign} #${a.source} group ${a.group} "${a.groupLabel}"${arrow}${a.target}\n`);
      }
    }
    out.write("\n");
  }

  const errors = plan.issues.filter((i) => i.severity === "error");
  const warnings = plan.issues.filter((i) => i.severity === "warning");
  if (errors.length) {
    out.write("ISSUES (blocking):\n");
    for (const i of errors) {
      out.write(`  ✗ [${i.gang}] ${i.message}\n`);
      if (i.remediation) out.write(`      → ${i.remediation}\n`);
    }
    out.write("\n");
  }
  if (warnings.length) {
    out.write("WARNINGS:\n");
    for (const i of warnings) {
      out.write(`  ! [${i.gang}] ${i.message}\n`);
      if (i.remediation) out.write(`      → ${i.remediation}\n`);
    }
    out.write("\n");
  }
  if (!plan.actions.length && !errors.length) {
    out.write("Nothing to do — live state already matches.\n");
  }
}

/** Write path for both `apply` (add) and `teardown` (remove). Gated behind --yes; --gang/--node filter. */
async function cmdWrite(adapter: ZWaveAdapter, file: string, flags: Record<string, string>, mode: "add" | "remove"): Promise<void> {
  const out = (s: string) => process.stdout.write(s);
  const topo = loadTopology(file);
  const plan = mode === "add" ? await computePlan(adapter, topo) : await computeTeardown(adapter, topo);

  let actions: PlanAction[] = plan.actions;
  if (flags.gang) actions = actions.filter((a) => a.gang.toLowerCase() === flags.gang.toLowerCase());
  if (flags.node) actions = actions.filter((a) => a.source === Number(flags.node));

  printPlan({ ...plan, actions }, file);
  if (flags.gang || flags.node) out(`(filtered to ${actions.length} action(s))\n`);

  const verb = mode === "add" ? "apply" : "remove";
  if (!actions.length) {
    out(`\nNothing to ${verb}.\n`);
    return;
  }
  if (flags.yes !== "true") {
    out(`\nDRY RUN — no writes performed. Re-run with --yes to ${verb} these on the mesh.\n`);
    return;
  }

  out(`\n${mode === "add" ? "Applying" : "Removing"}...\n`);
  const results = await applyActions(adapter, actions);
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    const sign = r.action.kind === "add" ? "->" : "-x";
    out(`  ${mark} #${r.action.source} group ${r.action.group} ${sign} #${r.action.target}` + (r.ok ? "\n" : `  (${r.error})\n`));
  }
  const failed = results.filter((r) => !r.ok).length;
  out(`\nDone: ${results.length - failed} ${mode === "add" ? "added" : "removed"}, ${failed} failed.\n`);
  if (failed) process.exitCode = 1;
}

/** Reconcile: add missing links and remove stale ones (make live state match the topology). */
async function cmdReconcile(adapter: ZWaveAdapter, file: string, flags: Record<string, string>): Promise<void> {
  const out = (s: string) => process.stdout.write(s);
  const topo = loadTopology(file);
  const filter = (as: PlanAction[]) => {
    let r = as;
    if (flags.gang) r = r.filter((a) => a.gang.toLowerCase() === flags.gang.toLowerCase());
    if (flags.node) r = r.filter((a) => a.source === Number(flags.node));
    return r;
  };
  const adds = filter((await computePlan(adapter, topo)).actions);
  const stale = filter((await computeStale(adapter, topo)).actions);

  out(`Reconcile from ${file}\n  ${adds.length} to add, ${stale.length} stale to remove.\n\n`);
  for (const a of adds) out(`  + #${a.source} group ${a.group} "${a.groupLabel}" -> #${a.target}\n`);
  for (const a of stale) out(`  - #${a.source} group ${a.group} "${a.groupLabel}" (${a.capabilityTitle}) -x #${a.target}\n`);
  if (!adds.length && !stale.length) {
    out("\nNothing to do — live state already matches.\n");
    return;
  }
  if (flags.yes !== "true") {
    out("\nDRY RUN — no writes performed. Re-run with --yes to reconcile.\n");
    return;
  }
  out("\nReconciling...\n");
  const results = [...(await applyActions(adapter, adds)), ...(await applyActions(adapter, stale))];
  const failed = results.filter((r) => !r.ok).length;
  for (const r of results) if (!r.ok) out(`  ✗ #${r.action.source} group ${r.action.group}: ${r.error}\n`);
  out(`\nDone: ${results.length - failed} change(s), ${failed} failed.\n`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`Error: ${err?.message ?? err}\n`);
  process.exit(1);
});
