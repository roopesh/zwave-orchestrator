// Connection resolution. Precedence: CLI flags > env > HA add-on options > config/config.json >
// defaults. Kept transport-agnostic so the web server reuses the same resolver.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Connection {
  host: string;
  port: number;
  url: string;
}

interface FileConfig {
  host?: string;
  port?: number;
  url?: string;
}

/** Minimal `--key value` / `--flag` parser (no deps). */
export function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function readConfigFile(): FileConfig {
  const path = join(process.cwd(), "config", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch {
    return {};
  }
}

/** Home Assistant writes an add-on's user options to /data/options.json. When running as the HA
 *  add-on, that's where the zwave-js-server host/port come from (keys defined in config.yaml). */
function readAddonOptions(): FileConfig {
  const path = "/data/options.json";
  if (!existsSync(path)) return {};
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return { host: o.zws_host as string, port: o.zws_port as number, url: o.zws_url as string };
  } catch {
    return {};
  }
}

export function resolveConnection(argv: string[] = []): Connection {
  const flags = parseFlags(argv);
  const addon = readAddonOptions();
  const file = readConfigFile();

  const host = flags.host ?? process.env.ZWS_HOST ?? addon.host ?? file.host ?? "127.0.0.1";
  const port = Number(flags.port ?? process.env.ZWS_PORT ?? addon.port ?? file.port ?? 3000);
  const url = flags.url ?? process.env.ZWS_URL ?? addon.url ?? file.url ?? `ws://${host}:${port}`;

  return { host, port, url };
}
