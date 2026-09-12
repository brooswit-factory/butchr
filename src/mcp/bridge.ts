import { legacyStdioRelayAction } from "@brooswit/thatch";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";

export interface BridgeOptions {
  stdin?: Readable;
  stdout?: Writable;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  onError?: (error: Error) => void;
}

/** Relay only: Thatch owns initialization, discovery, and the entire tool surface. */
export async function startBridge(url: URL, identity: string, options: BridgeOptions = {}) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP bridge requires an HTTP URL");
  if (!identity.trim() || identity !== identity.trim() || /[^\x21-\x7e]/.test(identity)) {
    throw new Error("MCP bridge requires a nonempty issue identity without whitespace");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1_000;
  for (const timeout of [requestTimeoutMs, cleanupTimeoutMs]) {
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
      throw new Error("MCP bridge timeouts must be positive timer-safe integers");
    }
  }
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stdio = new StdioServerTransport(stdin, stdout);
  const http = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "x-issue": identity, "x-butchr-provider": "agy" } },
    reconnectionOptions: {
      maxRetries: 0, initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1,
    },
  });
  let closing = false;
  let initializeId: string | number | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const close = (): Promise<void> => {
    if (closing) return closed;
    closing = true;
    stdin.off("end", onEnd);
    stdin.off("close", onEnd);
    stdout.off("error", onOutputError);
    stdout.off("close", onEnd);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    void (async () => {
      // DELETE is best effort; abort the SDK even when the peer never answers it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await stdio.close();
        await Promise.race([
          http.terminateSession().catch(() => {}),
          new Promise<void>(resolve => { timer = setTimeout(resolve, cleanupTimeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
        await http.close().catch(() => {});
        resolveClosed();
      }
    })().catch(() => { resolveClosed(); });
    return closed;
  };
  const fail = (message: string) => {
    if (closing) return;
    void close();
    const error = new Error(message);
    try {
      if (options.onError) options.onError(error);
      else console.error(error.message);
    } catch { /* Reporting must not prevent transport cleanup. */ }
  };
  const onEnd = () => { void close(); };
  const onOutputError = () => fail("MCP bridge stdio output failed");
  const send = (operation: Promise<void>, label: string) => {
    const timer = setTimeout(() => fail(`MCP bridge ${label} timed out`), requestTimeoutMs);
    timers.add(timer);
    void operation.catch(() => fail(`MCP bridge ${label} failed`)).finally(() => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  };
  http.onmessage = message => {
    if (closing) return;
    if ("method" in message && !("id" in message) && message.method === "notifications/claude/channel") return;
    if ("result" in message && initializeId !== undefined && message.id === initializeId) {
      if (typeof message.result.protocolVersion === "string") http.setProtocolVersion(message.result.protocolVersion);
      initializeId = undefined;
    }
    send(stdio.send(message), "stdio send");
  };
  stdio.onmessage = message => {
    if (closing) return;
    const action = legacyStdioRelayAction(message, !!http.sessionId);
    if (action.type === "ignore") return;
    if (action.type === "reply") { send(stdio.send(action.message), "stdio send"); return; }
    if ("method" in message && "id" in message && message.method === "initialize") initializeId = message.id;
    send(http.send(message), "HTTP send");
  };
  http.onerror = () => fail("MCP bridge upstream transport failed");
  stdio.onerror = () => fail("MCP bridge stdio transport failed");
  http.onclose = onEnd;
  stdio.onclose = onEnd;
  stdin.once("end", onEnd);
  stdin.once("close", onEnd);
  stdout.on("error", onOutputError);
  stdout.once("close", onEnd);
  try {
    await http.start();
    if (!closing) await stdio.start();
    if (stdin.readableEnded || stdin.destroyed || stdout.destroyed) await close();
  } catch (error) {
    await close();
    throw error;
  }
  return { close, closed };
}
