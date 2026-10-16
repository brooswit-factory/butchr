/**
 * FACTORY-660 (SPEC CHANGE (c), agentsafety review 2026-10-05) — same-UID
 * peer check for a loopback HTTP connection: is the OS process that opened
 * this TCP connection owned by the SAME Unix user as this daemon? The
 * daemon binds loopback-only (`src/daemon/listen.ts`), but loopback is
 * shared by every user on the host — this is the one signal that
 * distinguishes "the operator's own dashboard" from "another local user's
 * process that happens to know the port."
 *
 * MECHANISM: `/proc/net/tcp`(6) lists every TCP socket on the host, one row
 * per socket, each carrying the owning process's uid — the classic
 * pre-SO_PEERCRED way to identify a loopback peer on Linux. The caller's own
 * socket (not this daemon's accepting socket) is the row whose
 * `local_address` is the CLIENT's own address:port
 * (`server.requestIP(request)`, read by the caller — this module has no
 * Elysia/Bun dependency) and whose `rem_address` is this daemon's own
 * listening address:port. That row's `uid` field names the peer.
 *
 * PR #642 review round 2 (G3): matching on PORT alone (the original
 * version of this module) is not the full socket identity — matching the
 * FULL 4-tuple (both addresses, both ports) is what actually names one
 * unique socket in the table. Address matching is IPv4-only (`ipv4ToHex`
 * below): `src/daemon/listen.ts`'s `DAEMON_HOSTNAME` is `"127.0.0.1"`
 * literally, so this daemon never has an IPv6 socket of its own to match
 * against — an IPv6 address on either side (a client address `"::1"`, say)
 * fails `ipv4ToHex` and so fails closed, same as any other unresolvable
 * input.
 *
 * FAIL CLOSED: no matching row (race between the read and the connection,
 * a malformed line, `/proc` unavailable, an address this module can't
 * parse) resolves to "not the same uid" — never "assume yes". This module
 * owns the mechanism only; FACTORY-662 (the write-path ticket) imports it
 * for the same purpose on its own routes rather than re-deriving it.
 */
import { readFileSync } from "node:fs";

/** One `/proc/net/tcp`-style table's relevant rows, already read into a string — injectable for tests; production reads `/proc/net/tcp` and `/proc/net/tcp6` for real. */
export type ReadProcNetTcp = () => string;

/** One side of a TCP socket, as seen by Bun (`SocketAddress`) or built by this daemon's own listen config — an IPv4 dotted-quad `address` (`"127.0.0.1"`), never a hostname. */
export interface SocketEndpoint {
  address: string;
  port: number;
}

/**
 * `local_address`/`rem_address` fields are `HEXIP:HEXPORT` (e.g.
 * `0100007F:1F90`) — only the port half matters here. Returns `null` for a
 * field that doesn't parse (the header row, a malformed line), never `NaN`,
 * so a caller comparing with `===` can't be accidentally fooled by `NaN ===
 * NaN` being `false` either way, but is explicit either way.
 */
function hexPort(field: string | undefined): number | null {
  const hex = field?.split(":")[1];
  if (!hex) return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * An IPv4 dotted-quad (`"127.0.0.1"`) → `/proc/net/tcp`'s own hex encoding:
 * the address's 4 bytes, byte-order REVERSED, each hex-encoded
 * (`"127.0.0.1"` → bytes `[127,0,0,1]` → reversed `[1,0,0,127]` →
 * `"0100007F"`) — verified against this module's own test fixtures and
 * `test/unit/peer-uid.test.ts`'s existing captured rows. Returns `null` for
 * anything else (an IPv6 address, a hostname, a malformed quad) — this
 * module's only address format; an unparseable address fails closed in
 * `peerUidOf` below, exactly like an unmatched port already does.
 */
function ipv4ToHex(address: string): string | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return bytes
    .slice()
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Scans one or more `/proc/net/tcp`-style tables (already concatenated by
 * the caller) for the row whose OWN local address:port is `local` and whose
 * remote address:port is `remote` — i.e. the CALLER's own socket, not this
 * daemon's accepting one (see this module's own top comment for which side
 * is which). Returns that row's uid, or `null` if no such row is found, or
 * if either address doesn't parse as IPv4 — exported standalone (not folded
 * into `isSameUidPeer`) so a test can prove the parsing itself against a
 * captured `/proc/net/tcp` sample without also wiring up an "own uid"
 * comparison.
 */
export function peerUidOf(table: string, local: SocketEndpoint, remote: SocketEndpoint): number | null {
  const localAddrHex = ipv4ToHex(local.address);
  const remoteAddrHex = ipv4ToHex(remote.address);
  if (localAddrHex === null || remoteAddrHex === null) return null;
  const lines = table.split("\n").slice(1); // header row
  let found: number | null = null;
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const localField = fields[1];
    const remoteField = fields[2];
    if ((localField?.split(":")[0] ?? "").toUpperCase() !== localAddrHex) continue;
    if ((remoteField?.split(":")[0] ?? "").toUpperCase() !== remoteAddrHex) continue;
    if (hexPort(localField) !== local.port) continue;
    if (hexPort(remoteField) !== remote.port) continue;
    const uid = Number(fields[7]);
    if (!Number.isFinite(uid)) return null;
    // One socket, one owner: rows for the same 4-tuple that disagree on the uid
    // (lsof prints one row per process holding the socket) are not an answer.
    if (found !== null && found !== uid) return null;
    found = uid;
  }
  return found;
}

/**
 * macOS has no `/proc`. `lsof -F` output (`-nP -iTCP@127.0.0.1`, one `u<uid>`
 * line per process followed by one `n<local>-><remote>` line per socket) is
 * rewritten here into the same row shape `peerUidOf` already parses, so the
 * 4-tuple match and the fail-closed rules stay in one place. Anything that
 * doesn't parse is dropped, never guessed at.
 */
export function lsofToProcNetTcp(lsofOutput: string): string {
  const rows = ["  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode"];
  let uid: number | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) uid = null; // a new process record: its `u` line follows
    else if (line.startsWith("u")) uid = /^\d+$/.test(line.slice(1)) ? Number(line.slice(1)) : null;
    else if (line.startsWith("n") && uid !== null) {
      const m = /^n(\d+\.\d+\.\d+\.\d+):(\d+)->(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(line);
      if (!m) continue;
      const hex = (addr: string, port: string) => {
        const a = ipv4ToHex(addr);
        return a === null ? null : `${a}:${Number(port).toString(16).toUpperCase().padStart(4, "0")}`;
      };
      const local = hex(m[1]!, m[2]!);
      const remote = hex(m[3]!, m[4]!);
      if (local && remote) rows.push(`   0: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000 ${uid} 0 0`);
    }
  }
  return rows.join("\n");
}

/** Real production read on Linux: `/proc/net/tcp` (IPv4) and `/proc/net/tcp6` (IPv6 — a loopback peer may connect over `::1`), concatenated. A missing/unreadable table (a sandboxed `/proc`) yields the empty string for that half, never a thrown error — `peerUidOf` then finds no matching row, which fails closed exactly as intended. macOS goes through `lsofPeerUid` below instead. */
export const readProcNetTcp: ReadProcNetTcp = () => {
  const readOrEmpty = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return `${readOrEmpty("/proc/net/tcp")}\n${readOrEmpty("/proc/net/tcp6")}`;
};

const LSOF_PATH = "/usr/sbin/lsof";
const LSOF_TIMEOUT_MS = 4000;
/** A positive answer for one 4-tuple is reused this long, so a page's burst of requests costs one `lsof`. */
const POSITIVE_TTL_MS = 1000;
/** Checks queued behind the running `lsof`; beyond this a check is refused outright (fail closed) so a flood cannot build an unbounded backlog. */
const MAX_PENDING_LSOF = 8;

export type RunLsof = () => Promise<string>;

/**
 * One `lsof` run, never blocking the event loop. A timeout kill (a signal
 * exit) yields "" — no partial output is ever parsed — as does a missing
 * binary, a non-zero exit with no output, or any error. Deliberately NOT
 * `proc.killed`: on Bun for macOS it is true even after a clean exit.
 */
export function runLsofAt(path: string = LSOF_PATH, timeoutMs: number = LSOF_TIMEOUT_MS): Promise<string> {
  return (async () => {
    try {
      const proc = Bun.spawn([path, "-nP", "-iTCP@127.0.0.1", "-F", "pun"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      // Our own timer: Bun's `timeout` spawn option did not kill the process in testing.
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
      const outP = new Response(proc.stdout).text(); // read while it runs so a full pipe cannot block the exit
      // Outer deadline: a child that ignores even SIGKILL's reaping must not hold the queue.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        proc.exited,
        new Promise<null>((resolve) => { deadline = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs + 500); }),
      ]);
      clearTimeout(timer);
      clearTimeout(deadline);
      if (timedOut || proc.signalCode || code === null) return "";
      const out = await outP;
      return code === 0 || out.length > 0 ? out : "";
    } catch {
      return "";
    }
  })();
}
export const runLsof: RunLsof = () => runLsofAt();

export interface LsofPeerUidDeps {
  run?: RunLsof;
  now?: () => number;
}

/**
 * macOS owner lookup for one socket: async, single-flight per 4-tuple, runs
 * one `lsof` at a time, caches only positive answers for about a second, and
 * refuses (null) when too many lookups are already waiting.
 */
export function createLsofPeerUid(deps: LsofPeerUidDeps = {}): (client: SocketEndpoint, server: SocketEndpoint) => Promise<number | null> {
  const run = deps.run ?? runLsof;
  const now = deps.now ?? (() => performance.now()); // monotonic: a wall-clock step must not extend a cached answer
  const cache = new Map<string, { uid: number; at: number }>();
  const inflight = new Map<string, Promise<number | null>>();
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return (client, server) => {
    const key = `${client.address}:${client.port}>${server.address}:${server.port}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < POSITIVE_TTL_MS) return Promise.resolve(hit.uid);
    const previous = hit?.uid;
    cache.delete(key);
    const shared = inflight.get(key);
    if (shared) return shared;
    if (pending >= MAX_PENDING_LSOF) return Promise.resolve(null);
    pending++;
    const p = queue
      .then(() => run())
      .then((out) => {
        const uid = peerUidOf(lsofToProcNetTcp(out), client, server);
        // A different owner for the same 4-tuple than we just saw is not an answer.
        if (uid !== null && previous !== undefined && previous !== uid) return null;
        if (uid !== null) {
          for (const [k, v] of cache) if (now() - v.at >= POSITIVE_TTL_MS) cache.delete(k);
          cache.set(key, { uid, at: now() });
        }
        return uid;
      })
      .catch(() => null)
      .finally(() => {
        pending--;
        inflight.delete(key);
      });
    queue = p;
    inflight.set(key, p);
    return p;
  };
}

const lsofPeerUid = createLsofPeerUid();

export interface PeerUidCheckDeps {
  /** This daemon's own listening address+port — the REMOTE endpoint on the caller's own socket row. */
  server: SocketEndpoint;
  read?: ReadProcNetTcp;
  /** This process's own uid — injectable for tests; defaults to `process.getuid?.()`. */
  ownUid?: () => number | undefined;
}

/**
 * True only when `client` (the caller's own TCP endpoint, as seen by this
 * daemon — `server.requestIP(request)`) resolves to a socket owned by THIS
 * process's own uid. Fails closed (`false`) on anything that can't be
 * resolved: no `ownUid`, no matching `/proc/net/tcp` row (address OR port
 * mismatch on either side), a read failure.
 */
export function isSameUidPeer(client: SocketEndpoint, deps: PeerUidCheckDeps): boolean {
  const ownUid = (deps.ownUid ?? (() => process.getuid?.()))();
  if (ownUid === undefined) return false;
  const table = (deps.read ?? readProcNetTcp)();
  const peerUid = peerUidOf(table, client, deps.server);
  return peerUid !== null && peerUid === ownUid;
}

/**
 * The check the daemon's routes use. Linux (and any injected `read`) is the
 * synchronous `isSameUidPeer`; macOS resolves the owner with the async,
 * non-blocking `lsof` lookup above. Fails closed the same way.
 */
export async function isSameUidPeerAsync(client: SocketEndpoint, deps: PeerUidCheckDeps & { darwin?: boolean; lookup?: typeof lsofPeerUid }): Promise<boolean> {
  if (deps.read || !(deps.darwin ?? process.platform === "darwin")) return isSameUidPeer(client, deps);
  const ownUid = (deps.ownUid ?? (() => process.getuid?.()))();
  if (ownUid === undefined) return false;
  const peerUid = await (deps.lookup ?? lsofPeerUid)(client, deps.server);
  return peerUid !== null && peerUid === ownUid;
}
