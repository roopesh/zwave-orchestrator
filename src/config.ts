// Connection resolution. Precedence: CLI flags > env > config/config.json > defaults.
// Kept transport-agnostic so the future web server reuses the same resolver.

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

export function resolveConnection(argv: string[] = []): Connection {
  const flags = parseFlags(argv);
  const file = readConfigFile();

  const host = flags.host ?? process.env.ZWS_HOST ?? file.host ?? "127.0.0.1";
  const port = Number(flags.port ?? process.env.ZWS_PORT ?? file.port ?? 3000);
  const url = flags.url ?? process.env.ZWS_URL ?? file.url ?? `ws://${host}:${port}`;

  return { host, port, url };
}
