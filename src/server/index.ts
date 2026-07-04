#!/usr/bin/env node
// Local web server: reuses the proven adapter/planner/executor and serves a same-origin UI.
// The browser only ever talks to this server; this server talks to zwave-js-server. No CORS,
// no mixed-content. Built on node:http to keep dependencies minimal.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveConnection, type Connection } from "../config.ts";
import { ZwaveClient } from "../zwave/client.ts";
import { ZWaveAdapter } from "../zwave/adapter.ts";
import { loadTopology, saveTopology, type Topology } from "../topology/gangs.ts";
import { computePlan, computeTeardown, type PlanAction } from "../topology/plan.ts";
import { applyActions } from "../topology/executor.ts";
import { CAPABILITIES, PRESETS, deviceCapabilities } from "../topology/capabilities.ts";
import type { NodeDump } from "../types.ts";

type UiNode = NodeDump & { supports: string[] };

const PORT = Number(process.env.PORT ?? 8090);
const PUBLIC_DIR = join(process.cwd(), "public");
const GANGS_FILE = process.env.GANGS_FILE ?? "gangs.yaml";
const CONFIG_FILE = join(process.cwd(), "config", "config.json");

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
  const out: UiNode[] = [];
  for (const n of nodes) {
    if (n.isController) {
      out.push({ ...n, groups: [], associations: {}, supports: [] });
      continue;
    }
    try {
      const groups = await adapter.getAssociationGroups({ nodeId: n.id });
      const associations = await adapter.getAssociations({ nodeId: n.id });
      out.push({ ...n, groups, associations, supports: deviceCapabilities(groups) });
    } catch {
      out.push({ ...n, groups: [], associations: {}, supports: [] });
    }
  }
  return out;
}

function filterActions(actions: PlanAction[], body: any): PlanAction[] {
  let out = actions;
  if (body?.gang) out = out.filter((a) => a.gang.toLowerCase() === String(body.gang).toLowerCase());
  if (body?.node != null) out = out.filter((a) => a.source === Number(body.node));
  return out;
}

// ---- tiny http helpers ----
function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
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
      if (path === "/api/gangs" && req.method === "POST") return void (await handleSaveGangs(hub, res, await readBody(req)));
      if (path === "/api/config" && req.method === "GET") return void json(res, 200, { host: hub.conn.host, port: hub.conn.port, url: hub.conn.url, connected: hub.connected });
      if (path === "/api/config" && req.method === "POST") return void (await handleConfig(hub, res, await readBody(req)));
      if (path.startsWith("/api/")) return void json(res, 404, { error: "unknown endpoint" });
      return void (await serveStatic(res, path));
    } catch (e: any) {
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
    json(res, 200, { ...base, connection: { ...base.connection, connected: false, error: hub.lastError }, nodes: [], plan: { actions: [], issues: [], satisfied: 0 } });
    return;
  }
  const [nodes, plan] = [await buildNodes(adapter), await computePlan(adapter, topology)];
  json(res, 200, { ...base, connection: { ...base.connection, connected: true }, nodes, plan });
}

async function handleWrite(hub: Hub, res: ServerResponse, body: any, mode: "add" | "remove"): Promise<void> {
  const adapter = await hub.ensure();
  const topology = loadTopology(GANGS_FILE);
  const plan = mode === "add" ? await computePlan(adapter, topology) : await computeTeardown(adapter, topology);
  const results = await applyActions(adapter, filterActions(plan.actions, body));
  const after = await computePlan(adapter, topology); // fresh plan reflecting the writes
  json(res, 200, { results, plan: after });
}

async function handleSaveGangs(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const topology = body?.topology as Topology;
  if (!topology?.gangs) return void json(res, 400, { error: "expected { topology: { gangs: [...] } }" });
  saveTopology(GANGS_FILE, topology);
  let plan = { actions: [], issues: [], satisfied: 0 } as any;
  if (hub.connected && hub.adapter) plan = await computePlan(hub.adapter, topology);
  json(res, 200, { ok: true, topology, plan });
}

async function handleConfig(hub: Hub, res: ServerResponse, body: any): Promise<void> {
  const host = String(body?.host ?? hub.conn.host);
  const port = Number(body?.port ?? hub.conn.port);
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
