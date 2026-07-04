// Low-level zwave-js-server WebSocket client: connect, schema negotiation, request/response.
// Uses the global WebSocket (Node >=22). Protocol verified live: handshake -> set_api_schema
// -> start_listening, results correlated by messageId.

export interface VersionInfo {
  type: "version";
  homeId: number;
  driverVersion: string;
  serverVersion: string;
  minSchemaVersion: number;
  maxSchemaVersion: number;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

export class ZwaveClient {
  readonly url: string;
  version?: VersionInfo;
  schemaVersion = 0;
  open = false;
  /** Invoked when the socket closes (unexpected or otherwise) — used by the server to reconnect. */
  onClose?: () => void;

  private ws?: WebSocket;
  private msgId = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(url: string) {
    this.url = url;
  }

  /** Connect, wait for the version frame, negotiate the max schema, and resolve. */
  connect(): Promise<VersionInfo> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;

      ws.addEventListener("error", (ev: any) => {
        reject(new Error(`WebSocket error for ${this.url}: ${ev?.message ?? ev?.error ?? "connection failed"}`));
      });
      ws.addEventListener("open", () => {
        this.open = true;
      });
      ws.addEventListener("close", () => {
        this.open = false;
        for (const [, p] of this.pending) p.reject(new Error("connection closed"));
        this.pending.clear();
        this.onClose?.();
      });
      ws.addEventListener("message", (ev: any) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        this.handle(msg, resolve, reject);
      });
    });
  }

  private handle(msg: any, onReady: (v: VersionInfo) => void, onError: (e: any) => void): void {
    if (msg.type === "version") {
      this.version = msg;
      this.schemaVersion = msg.maxSchemaVersion;
      this.request("set_api_schema", { schemaVersion: this.schemaVersion })
        .then(() => onReady(msg))
        .catch(onError);
      return;
    }
    if (msg.type === "result" && msg.messageId) {
      const p = this.pending.get(msg.messageId);
      if (!p) return;
      this.pending.delete(msg.messageId);
      if (msg.success) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.message ?? `command failed (errorCode ${msg.errorCode})`), msg));
      return;
    }
    // Other frames are pushed state/event updates — ignored until the live server needs them.
  }

  /** Issue a command and resolve with its `result` payload (rejects on `success:false`). */
  request(command: string, extra: Record<string, unknown> = {}): Promise<any> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("not connected"));
    const messageId = `m${++this.msgId}`;
    return new Promise((resolve, reject) => {
      // Guard against a silently-dead connection hanging the caller forever.
      const timer = setTimeout(() => {
        if (!this.pending.has(messageId)) return;
        this.pending.delete(messageId);
        this.open = false; // force a reconnect on the next request
        reject(new Error(`zwave-js-server request "${command}" timed out`));
      }, 15000);
      this.pending.set(messageId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        ws.send(JSON.stringify({ messageId, command, ...extra }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(messageId);
        this.open = false;
        reject(e);
      }
    });
  }

  /** Full state dump: { controller, nodes }. */
  async startListening(): Promise<{ controller: any; nodes: any[] }> {
    const res = await this.request("start_listening");
    return res.state;
  }

  close(): void {
    this.ws?.close();
  }
}
