#!/usr/bin/env node
// Local web server: reuses the proven adapter/planner/executor and serves a same-origin UI.
// The browser only ever talks to this server; this server talks to zwave-js-server. No CORS,
// no mixed-content. Built on node:http to keep dependencies minimal.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { resolveConnection, type Connection } from "../config.ts";
import { ZwaveClient } from "../zwave/client.ts";
import { ZWaveAdapter } from "../zwave/adapter.ts";
import { loadTopology, saveTopology, type Topology } from "../topology/gangs.ts";
import { computePlan, computeStale, computeTeardown, type PlanAction } from "../topology/plan.ts";
import { applyActions } from "../topology/executor.ts";
import { CAPABILITIES, PRESETS, deviceCapabilities } from "../topology/capabilities.ts";
import { loadPolicies, savePolicies, type PolicyDoc } from "../topology/policies.ts";
import { discoverGangs } from "../topology/discover.ts";
import { analyzeDevices, fingerprintOf, forgetDevice, loadDevices, remapNodeId, saveDevices } from "../topology/devices.ts";
import { applyParamActions, computeParamPlan, type ParamAction } from "../topology/paramPlan.ts";
import type { NodeDump } from "../types.ts";

type UiNode = NodeDump & { supports: string[] };

const PORT = Number(process.env.PORT ?? 8090);
const GANGS_FILE = process.env.GANGS_FILE ?? "gangs.yaml";
const POLICIES_FILE = process.env.POLICIES_FILE ?? "policies.yaml";
const DEVICES_FILE = process.env.DEVICES_FILE ?? "devices.yaml";
const CONFIG_FILE = join(process.cwd(), "config", "config.json");

// Resolve public/ relative to this script so it works in dev (src/server), a bundled dist/,
// and an installed package (npx), falling back to cwd.
function resolvePublicDir(): string {
  const here = import.meta.dirname;
  const candidates = [process.env.PUBLIC_DIR, join(here, "..", "public"), join(here, "..", "..", "public"), join(here, "public"), join(process.cwd(), "public")].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? join(process.cwd(), "public");
}
const PUBLIC_DIR = resolvePublicDir();

/** Holds the live connection to zwave-js-server and reconnects on demand. */
class Hub {
  conn: Connection;
  private client?: ZwaveClient;
  adapter?: ZWaveAdapter;
  lastError?: string;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  get connected(): boolean {
    return Boolean(this.client?.open);
  }
  get version() {
    return this.client?.version;
  }

  async connect(conn?: Connection): Promise<void> {
    if (conn) this.conn = conn;
    this.client?.close();
    const client = new ZwaveClient(this.conn.url);
    this.client = client;
    try {
      await client.connect();
      this.adapter = new ZWaveAdapter(client);
      this.lastError = undefined;
    } catch (e: any) {
      this.adapter = undefined;
      this.lastError = e?.message ?? String(e);
      throw e;
    }
  }

  async ensure(): Promise<ZWaveAdapter> {
    if (this.connected && this.adapter) return this.adapter;
    await this.connect();
    return this.adapter!;
  }
}

async function buildNodes(adapter: ZWaveAdapter): Promise<UiNode[]> {
  const nodes = await adapter.getNodes();
  // Read every node's groups + associations in parallel (was sequential — the main cost at scale).
  return Promise.all(
    nodes.map(async (n): Promise<UiNode> => {
      if (n.isController) return { ...n, groups: [], associations: {}, supports: [] };
      try {
        const [groups, associations] = await Promise.all([adapter.getAssociationGroups({ nodeId: n.id }), adapter.getAssociations({ nodeId: n.id })]);
        return { ...n, groups, associations, supports: deviceCapabilities(groups) };
      } catch (e: any) {
        log(`WARN #${n.id} "${n.name || n.product}" failed to read groups/associations: ${e?.message ?? e} — treated as having none, which can make plans look wrong for this node`);
        return { ...n, groups: [], associations: {}, supports: [] };
      }
    }),
  );
}

function filterActions(actions: PlanAction[], body: any): PlanAction[] {
  let out = actions;
  if (body?.gang) out = out.filter((a) => a.gang.toLowerCase() === String(body.gang).toLowerCase());
  if (body?.node != null) out = out.filter((a) => a.source === Number(body.node));
  return out;
}

/** Same gang/node filtering for gang-driven device-setting fixes (policy field = gang name). */
function filterGangParamActions(actions: ParamAction[], body: any): ParamAction[] {
  let out = actions;
  if (body?.gang) out = out.filter((a) => a.policy.toLowerCase() === String(body.gang).toLowerCase());
  if (body?.node != null) out = out.filter((a) => a.node === Number(body.node));
  return out;
}

// ---- tiny http helpers ----
function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// Every mutating request logs what it computed and the outcome of every device write — this is
// what launchd's StandardOutPath captures, so "did it actually do anything" is answerable after the fact.
function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}
function logResults(label: string, results: { ok: boolean; error?: string; action: any }[]): void {
  for (const r of results) {
    const a = r.action;
    const what = "kind" in a ? `${a.kind} #${a.source} group ${a.group} -> #${a.target}` : `param #${a.node} p${a.param}${a.key != null ? `[${a.key}]` : ""} -> ${a.desired}`;
    log(`  ${r.ok ? "OK  " : "FAIL"} ${label} ${what}${r.error ? ` (${r.error})` : ""}`);
  }
}
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

async function main(): Promise<void> {
  const hub = new Hub(resolveConnection(process.argv.slice(2)));
  // Try an initial connection; if it fails the UI still loads and can fix settings.
  await hub.connect().catch(() => {});

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path === "/api/state") return void (await handleState(hub, res));
      if (path === "/api/apply" && req.method === "POST") return void (await handleWrite(hub, res, await readBody(req), "add"));
      if (path === "/api/teardown" && req.method === "POST") return void (await handleWrite(hub, res, await readBody(req), "remove"));
      if (path === "/api/reconcile" && req.method === "POST") return void (await handleReconcile(hub, res, await readBody(req)));
      if (path === "/api/redeploy" && req.method === "POST") return void (await handleRedeploy(hub, res));
      if (path === "/api/gangs" && req.method === "POST") return void (await handleSaveGangs(hub, res, await readBody(req)));
      if (path === "/api/discover" && req.method === "GET") return void (await handleDiscover(hub, res));
      if (path === "/api/params" && req.method === "GET") return void (await handleParams(hub, res));
      if (path === "/api/params/apply" && req.method === "POST") return void (await handleParamsApply(hub, res, await readBody(req)));
      if (path === "/api/policies" && req.method === "POST") return void (await handleSavePolicies(hub, res, await readBody(req)));
      if (path === "/api/devices" && req.method === "POST") return void (await handleSaveDevices(res, await readBody(req)));
      if (path === "/api/devices/forget" && req.method === "POST") return void (await handleForgetDevice(res, await readBody(req)));
      if (path === "/api/remap" && req.method === "POST") return void (await handleRemap(hub, res, await readBody(req)));
      if (path === "/api/config" && req.method === "GET") return void json(res, 200, { host: hub.conn.host, port: hub.conn.port, url: hub.conn.url, connected: hub.connected });
      if (path === "/api/config" && req.method === "POST") return void (await handleConfig(hub, res, await readBody(req)));
      if (path.startsWith("/api/")) return void json(res, 404, { error: "unknown endpoint" });
      return void (await serveStatic(res, path));
    } catch (e: any) {
      log(`ERROR ${req.method} ${path}: ${e?.stack ?? e?.message ?? String(e)}`);
      json(res, 500, { error: e?.message ?? String(e) });
    }
  });

  server.listen(PORT, () => {
    process.stdout.write(`zwave-associations UI on http://localhost:${PORT}  (zwave-js-server: ${hub.conn.url}${hub.connected ? " ✓" : " — not connected"})\n`);
  });
}

async function handleState(hub: Hub, res: ServerResponse): Promise<void> {
  const topology = loadTopology(GANGS_FILE);
  const base = { connection: { url: hub.conn.url, connected: hub.connected, version: hub.version, error: hub.lastError }, presets: PRESETS, capabilities: CAPABILITIES, topology };
  let adapter: ZWaveAdapter;
  try {
    adapter = await hub.ensure();
  } catch {
    json(res, 200, { ...base, connection: { ...base.connection, connected: false, error: hub.lastError }, nodes: [], plan: { actions: [], issues: [], satisfied: 0 }, stale: [], deviceChanges: { removed: [], repairCandidates: [] } });
    return;
  }
  const [nodes, plan, stale] = [await buildNodes(adapter), await computePlan(adapter, topology), await computeStale(adapter, topology)];
  const analysis = analyzeDevices(nodes, loadDevices(DEVICES_FILE));
  const nodesOut = nodes.map((n) => ({ ...n, device: analysis.status[n.id] }));
  json(res, 200, { ...base, connection: { ...base.connection, connected: true }, nodes: nodesOut, plan, stale: stale.actions, deviceChanges: { removed: analysis.removed, repairCandidates: analysis.repairCandidates } });
}

async function handleWrite(hub: Hub, res: ServerResponse, body: any, mode: "add" | "remove"): Promise<void> {
  const adapter = await hub.ensure();
  const topology = loadTopology(GANGS_FILE);
  const plan = mode === "add" ? await computePlan(adapter, topology) : await computeTeardown(adapter, topology);
  const filtered = filterActions(plan.actions, body);
  log(`${mode === "add" ? "APPLY" : "TEARDOWN"} gang=${body?.gang ?? "*"} node=${body?.node ?? "*"}: ${filtered.length}/${plan.actions.length} action(s) matched filter`);
  const results: any[] = await applyActions(adapter, filtered);
  logResults(mode, results);
  if (mode === "add" && plan.paramActions.length) {
    const pfiltered = filterGangParamActions(plan.paramActions, body);
    const paramResults = await applyParamActions(adapter, pfiltered);
    logResults("apply-param", paramResults);
    results.push(...paramResults);
  }
  const after = await computePlan(adapter, topology); // fresh plan reflecting the writes
  json(res, 200, { results, plan: after });
}

async function handleReconcile(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const adapter = await hub.ensure();
  const topology = loadTopology(GANGS_FILE);
  const addPlan = await computePlan(adapter, topology);
  const addFiltered = filterActions(addPlan.actions, body);
  log(`RECONCILE gang=${body?.gang ?? "*"} node=${body?.node ?? "*"}: ${addFiltered.length} add / ${addPlan.paramActions.length} param action(s) matched filter`);
  const addResults: any[] = await applyActions(adapter, addFiltered);
  logResults("reconcile-add", addResults);
  if (addPlan.paramActions.length) {
    const paramResults = await applyParamActions(adapter, filterGangParamActions(addPlan.paramActions, body));
    logResults("reconcile-param", paramResults);
    addResults.push(...paramResults);
  }
  const stalePlan = await computeStale(adapter, topology);
  const remFiltered = filterActions(stalePlan.actions, body);
  log(`RECONCILE stale: ${remFiltered.length} remove action(s) matched filter`);
  const remResults = await applyActions(adapter, remFiltered);
  logResults("reconcile-remove", remResults);
  const after = await computePlan(adapter, topology);
  const afterStale = await computeStale(adapter, topology);
  json(res, 200, { results: [...addResults, ...remResults], plan: after, stale: afterStale.actions });
}

/** One-shot "make reality match gangs.yaml + policies.yaml", no filtering, no diagnosis required. */
async function handleRedeploy(hub: Hub, res: ServerResponse): Promise<void> {
  const adapter = await hub.ensure();
  const topology = loadTopology(GANGS_FILE);
  const doc = loadPolicies(POLICIES_FILE);
  log("REDEPLOY starting (force: reapplying every declared setting)");

  // force: true — re-issue every declared association/setting rather than trusting the diff.
  // A "redeploy" exists precisely so a stale/incorrect read of current state can't cause silent no-ops.
  const addPlan = await computePlan(adapter, topology, { force: true });
  const assocResults: any[] = await applyActions(adapter, addPlan.actions);
  logResults("redeploy-assoc", assocResults);
  const gangParamResults = addPlan.paramActions.length ? await applyParamActions(adapter, addPlan.paramActions) : [];
  logResults("redeploy-gang-param", gangParamResults);

  const stalePlan = await computeStale(adapter, topology);
  const staleResults = await applyActions(adapter, stalePlan.actions);
  logResults("redeploy-stale-remove", staleResults);
  assocResults.push(...staleResults);

  const paramPlan = await computeParamPlan(adapter, doc, topology, undefined, { force: true });
  const policyParamResults = paramPlan.actions.length ? await applyParamActions(adapter, paramPlan.actions) : [];
  logResults("redeploy-policy-param", policyParamResults);

  const plan = await computePlan(adapter, topology);
  const stale = await computeStale(adapter, topology);
  const afterParamPlan = await computeParamPlan(adapter, doc, topology);

  const failed = [...assocResults, ...gangParamResults, ...policyParamResults].filter((r) => !r.ok).length;
  log(`REDEPLOY done: ${assocResults.length} assoc, ${gangParamResults.length} gang-param, ${policyParamResults.length} policy-param, ${failed} failed`);

  json(res, 200, {
    associations: assocResults.length,
    gangParams: gangParamResults.length,
    policyParams: policyParamResults.length,
    failed,
    plan,
    stale: stale.actions,
    paramPlan: afterParamPlan,
  });
}

async function handleParams(hub: Hub, res: ServerResponse): Promise<void> {
  const adapter = await hub.ensure();
  const [nodes, params] = [await adapter.getNodes(), await adapter.getConfigParams()];
  const doc = loadPolicies(POLICIES_FILE);
  const topology = loadTopology(GANGS_FILE);
  const plan = await computeParamPlan(adapter, doc, topology, params);
  json(res, 200, {
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, location: n.location, model: n.product, isController: n.isController, isLongRange: n.isLongRange })),
    params,
    policies: doc.policies,
    gangs: topology.gangs.map((g) => ({ name: g.name, load: g.load, companions: g.companions.map((c) => c.node) })),
    plan,
  });
}

async function handleParamsApply(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const adapter = await hub.ensure();
  const doc = loadPolicies(POLICIES_FILE);
  const topology = loadTopology(GANGS_FILE);
  const plan = await computeParamPlan(adapter, doc, topology);
  let actions: ParamAction[] = plan.actions;
  if (body?.policy) actions = actions.filter((a) => a.policy.toLowerCase() === String(body.policy).toLowerCase());
  if (body?.node != null) actions = actions.filter((a) => a.node === Number(body.node));
  log(`PARAMS-APPLY policy=${body?.policy ?? "*"} node=${body?.node ?? "*"}: ${actions.length}/${plan.actions.length} action(s) matched filter`);
  const results = await applyParamActions(adapter, actions);
  logResults("params-apply", results);
  const after = await computeParamPlan(adapter, doc, topology);
  json(res, 200, { results, plan: after });
}

async function handleSavePolicies(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const doc = body?.policies ? ({ policies: body.policies } as PolicyDoc) : null;
  if (!doc) return void json(res, 400, { error: "expected { policies: [...] }" });
  log(`SAVE-POLICIES: ${doc.policies.map((p) => p.name).join(", ") || "(none)"}`);
  savePolicies(POLICIES_FILE, doc);
  let plan: any = { actions: [], issues: [], satisfied: 0 };
  if (hub.connected && hub.adapter) plan = await computeParamPlan(hub.adapter, doc, loadTopology(GANGS_FILE));
  json(res, 200, { ok: true, policies: doc.policies, plan });
}

async function handleRemap(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const from = Number(body?.from), to = Number(body?.to);
  if (!from || !to) return void json(res, 400, { error: "expected { from, to }" });
  const adapter = await hub.ensure();
  const newNode = (await adapter.getNodes()).find((n) => n.id === to);
  const topo = loadTopology(GANGS_FILE);
  const policies = loadPolicies(POLICIES_FILE);
  const registry = loadDevices(DEVICES_FILE);
  log(`REMAP #${from} -> #${to} (fingerprint=${newNode ? fingerprintOf(newNode) : "unknown"})`);
  remapNodeId(from, to, newNode ? fingerprintOf(newNode) : "", topo, policies, registry);
  saveTopology(GANGS_FILE, topo);
  savePolicies(POLICIES_FILE, policies);
  saveDevices(DEVICES_FILE, registry);
  json(res, 200, { ok: true, from, to });
}

async function handleSaveDevices(res: ServerResponse, body: any): Promise<void> {
  if (!Array.isArray(body?.devices)) return void json(res, 400, { error: "expected { devices: [...] }" });
  saveDevices(DEVICES_FILE, { devices: body.devices });
  json(res, 200, { ok: true, devices: body.devices });
}

async function handleForgetDevice(res: ServerResponse, body: any): Promise<void> {
  const id = Number(body?.id);
  if (!id) return void json(res, 400, { error: "expected { id: number }" });
  const registry = loadDevices(DEVICES_FILE);
  const before = registry.devices.length;
  const after = forgetDevice(registry, id);
  log(`FORGET-DEVICE #${id}: ${before === after.devices.length ? "not in registry (no-op)" : "removed"}`);
  saveDevices(DEVICES_FILE, after);
  json(res, 200, { ok: true, devices: after.devices });
}

async function handleDiscover(hub: Hub, res: ServerResponse): Promise<void> {
  const adapter = await hub.ensure();
  const discovered = await discoverGangs(adapter);
  const existingLoads = loadTopology(GANGS_FILE).gangs.map((g) => g.load);
  json(res, 200, { discovered, existingLoads });
}

async function handleSaveGangs(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const topology = body?.topology as Topology;
  if (!topology?.gangs) return void json(res, 400, { error: "expected { topology: { gangs: [...] } }" });
  const before = loadTopology(GANGS_FILE).gangs.map((g) => g.name);
  const afterNames = topology.gangs.map((g) => g.name);
  const removed = before.filter((n) => !afterNames.includes(n));
  const added = afterNames.filter((n) => !before.includes(n));
  if (removed.length) log(`SAVE-GANGS removed: ${removed.join(", ")} (config only — device associations are untouched; Teardown or Sync to actually unwire)`);
  if (added.length) log(`SAVE-GANGS added: ${added.join(", ")}`);
  saveTopology(GANGS_FILE, topology);
  let plan = { actions: [], issues: [], satisfied: 0 } as any;
  if (hub.connected && hub.adapter) plan = await computePlan(hub.adapter, topology);
  json(res, 200, { ok: true, topology, plan });
}

async function handleConfig(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const host = String(body?.host ?? hub.conn.host);
  const port = Number(body?.port ?? hub.conn.port);
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ host, port }, null, 2) + "\n");
  const conn: Connection = { host, port, url: `ws://${host}:${port}` };
  try {
    await hub.connect(conn);
    json(res, 200, { ok: true, connected: true, url: conn.url, version: hub.version });
  } catch (e: any) {
    json(res, 200, { ok: false, connected: false, url: conn.url, error: e?.message ?? String(e) });
  }
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});
