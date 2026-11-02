/**
 * BUTCHR-413 (story BUTCHR-395, epic BUTCHR-391) — the Codex stopgap wake
 * path for any `channel: true` MCP server binding (`Rule.mcpServers`,
 * BUTCHR-411/src/rules/rules.ts), concretely Rocket.Chat's `rocketr`.
 *
 * THE CLAIM THIS FILE EXISTS TO CLOSE: a Claude agent bound to a channel
 * server needs no code here at all — its own CLI opens the notification
 * stream directly (BUTCHR-411's `--dangerously-load-development-channels`
 * wiring) and renders a push as a `<channel>` frame natively. A Codex agent
 * never does this: it has no development-channel concept, and even its
 * ordinary MCP tool connection to a bound server never opens a notification
 * stream (see `notifyAgent`/`notifyIssue`'s own `!["codex","agy"].includes(...)`
 * filter, src/daemon/app.ts — the daemon's own butchr server already treats
 * a Codex connection as one that will never read a push). So a Codex agent
 * bound to a channel server would otherwise receive NOTHING for it — not
 * even the polling fallback the Jira-tracked rule loop gets from
 * `herd.nudge`, because nothing there is watching this SECOND, non-butchr
 * server at all.
 *
 * THE FIX: this daemon process itself opens the notification stream that
 * would otherwise go unwatched — one `@brooswit/drovr` `keepChannelSource`
 * connection per (codex issue, channel binding) — and turns every push into
 * one `herd.nudge()` prompt turn, exactly the same proven, event-driven
 * PTY-prompt transport every provider already falls back to for Jira-tracked
 * updates. No polling of the channel server or the agent's pane is involved
 * anywhere in this path: the daemon's connection is itself a live stream: a
 * push arrives, `onMessage` fires, `nudge()` is called, done.
 *
 * WHY DROVR'S OWN TRANSPORT (`keepChannelSource`/`renderInboxTurn`), BUT NOT
 * ITS `InboxRelay` QUEUE: `@brooswit/drovr`'s `inbox-relay` module is
 * documented for exactly this shape — "a relay holds the notification stream
 * in the agent's place and delivers each message as a turn through the
 * host's own API" — and this file reuses its connection/reconnect/backoff
 * primitive (`keepChannelSource`) and its channel-frame renderer
 * (`renderInboxTurn`, via the same `deliver(text, message)` shape). It does
 * NOT reuse `InboxRelay` itself: pinned `@brooswit/drovr` 0.11.1's
 * `InboxRelay.push()` has a confirmed race — `this.draining ??=
 * this.drain().finally(() => { this.draining = undefined })` clears
 * `draining` in a callback scheduled ONE MICROTASK AFTER `drain()`'s own
 * async body returns, not as part of that body's own synchronous
 * continuation. A `push()` landing in that gap (reproduced deterministically
 * here by pushing two messages back to back with no delay — see this
 * ticket's own test file) sees `draining` still truthy, skips starting a new
 * drain, and the just-queued message sits in `queue` forever: `pending`
 * stays `1` with nothing left running to ever drain it. Filed upstream
 * (see BUTCHR-413's `file_where_it_belongs` call for the exact destination);
 * NOT fixed here, since Drovr owns that module. `sequentialDeliver` below is
 * this file's own minimal replacement for JUST the queue/drain loop
 * (~20 lines, `finally` INSIDE the async function so clearing is part of its
 * own synchronous continuation, closing exactly this gap) — retry/backoff/
 * maxAttempts policy is otherwise the same shape `InboxRelay` documents.
 * This also sharpens the BUTCHR-359 ownership boundary rather than blurring
 * it: connection transport stays Drovr's; queue/retry/dedup POLICY, which
 * this file owns regardless, is now fully in Butchr's own code, not silently
 * delegated to a dependency with an open defect.
 *
 * WHAT BUTCHR-359 SHOULD REPLACE, EXACTLY: this entire file, plus its wiring
 * in `src/daemon/index.ts` (the `createCodexChannelRelayPool` construction
 * and its poll-loop `reconcile()` call) — once that epic lands a real,
 * production-correct Codex wake path (with proper reconcile-on-restart,
 * observed-delivery proof, etc.), THIS module's whole job — "make a
 * channel-bound Codex agent receive channel pushes at all" — is subsumed by
 * it. Nothing outside this file and its one wiring block needs to change to
 * remove it: `createCodexChannelRelayPool` and `startCodexChannelRelay` are
 * the seam (see each export's own doc comment), never called from anywhere
 * else.
 */
import { keepChannelSource, renderInboxTurn, type InboxMessage, type DeliveryOutcome, type ChannelSourceStatus, type KeepChannelSourceOptions } from "@brooswit/drovr";
import type { McpServerBinding } from "../rules/rules.js";
import { resolveAccountHeader, resolveMcpServerHeaders } from "../agents/workspace.js";

/**
 * A corrected, minimal stand-in for `@brooswit/drovr`'s `InboxRelay` queue —
 * see this file's own top comment for the exact race in the original this
 * avoids. Same delivery semantics: one message at a time, in arrival order;
 * `"failed"` retries up to `maxAttempts` (default 20) waiting `retryMs`
 * (default 5s) between attempts; `"rejected"` or exhausted attempts drops
 * the message (reported via `onEvent`); `"delivered"` moves to the next.
 */
function sequentialDeliver(options: {
  deliver: (text: string, message: InboxMessage) => Promise<DeliveryOutcome>;
  onEvent?: (event: { kind: "delivered"; message: InboxMessage } | { kind: "dropped"; message: InboxMessage; reason: string }) => void;
  retryMs?: number;
  maxAttempts?: number;
  maxQueue?: number;
  wait?: (ms: number) => Promise<void>;
}): { push: (message: InboxMessage) => void; stop: () => void } {
  const retryMs = options.retryMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 20;
  const maxQueue = options.maxQueue ?? 200;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const queue: InboxMessage[] = [];
  let draining: Promise<void> | null = null;
  let stopped = false;

  async function drain() {
    try {
      let failures = 0;
      while (!stopped && queue.length > 0) {
        const message = queue[0]!;
        let outcome: DeliveryOutcome;
        try { outcome = await options.deliver(renderInboxTurn(message), message); }
        catch (e) { outcome = { status: "failed", detail: e instanceof Error ? e.message : String(e) }; }
        if (outcome.status === "delivered") {
          queue.shift();
          failures = 0;
          options.onEvent?.({ kind: "delivered", message });
          continue;
        }
        if (outcome.status === "failed") failures++;
        const permanent = outcome.status === "rejected";
        if (permanent || failures >= maxAttempts) {
          queue.shift();
          failures = 0;
          options.onEvent?.({ kind: "dropped", message, reason: outcome.status === "rejected" ? `rejected: ${outcome.detail}` : `failed ${maxAttempts} times` });
          continue;
        }
        await wait(retryMs);
      }
    } finally {
      // Cleared as part of THIS function's own synchronous continuation
      // (a `finally` inside the async body, not a `.finally()` chained onto
      // the promise it returns) — no gap where a concurrent `push()` could
      // observe a stale truthy `draining` after the loop has already ended.
      draining = null;
    }
  }

  return {
    push(message) {
      if (stopped) return;
      queue.push(message);
      while (queue.length > maxQueue) {
        const dropped = queue.shift()!;
        options.onEvent?.({ kind: "dropped", message: dropped, reason: `queue over ${maxQueue}` });
      }
      draining ??= drain();
    },
    stop() { stopped = true; },
  };
}

/** Deliver rendered turn text to a resident agent; `herd.nudge`'s own shape, narrowed to what this module needs. */
export interface RelayNudge {
  (issue: string, text: string): Promise<{ delivered: boolean }>;
}

export interface CodexChannelRelayDeps {
  nudge: RelayNudge;
  /** Defaults to a no-op. Every line is prefixed `[notify] codex channel relay:` and always names the real provider (codex) and server — never a hard-coded Claude label. */
  log?: (line: string) => void;
  now?: () => number;
  /** Injection seam for tests; defaults to `@brooswit/drovr`'s `keepChannelSource`. */
  connect?: (options: KeepChannelSourceOptions) => { stop: () => Promise<void> };
  /** How long a delivered message's dedup key is remembered before an identical repeat is treated as new. Default 5 minutes. */
  dedupWindowMs?: number;
  /**
   * This issue's own non-secret Rocket.Chat account name
   * (`spec.mcpAccountName`'s own source, `rcUsernameFor(issue)` —
   * src/accounts/identity.ts — gated on the issue's rule actually granting
   * an account), or undefined for none (an `account: "none"` rule, e.g.
   * Candlestix's MUD players, or no Rocket.Chat configured at all). Passed
   * straight into `resolveMcpServerHeaders` alongside `binding` below, so
   * this daemon's OWN connection identifies as the SAME account
   * `boundCodexServers` (src/agents/argv.ts) puts in Codex's own bound-server
   * headers for the reply path — review finding 2: a shared, rule-level-only
   * credential could not route a DM to one agent; this is what fixes that.
   * Defaults to a no-op (no per-agent identity for anyone); the real daemon
   * wiring (src/daemon/index.ts) passes the SAME `accountNameOf` function
   * `HerdrHerd` uses, so the two can never name a different account for the
   * same issue.
   */
  accountNameOf?: (issue: string) => string | undefined;
}

export interface CodexChannelRelayHandle {
  stop(): Promise<void>;
}

/**
 * A message's identity for "no duplicate delivery" (BUTCHR-413's own DoD):
 * `meta.id`/`meta.messageId` when the channel server sends one (Rocket.Chat
 * messages carry a stable id; a real `rocketr` is expected to forward it),
 * else the content itself — so a channel server that sends no id still gets
 * exact-repeat suppression, just not "same id, edited content" suppression.
 * Scoped to `source` (the binding name) because the same underlying RC
 * message reaching this agent over two different bound routes (e.g. a
 * channel binding and a separate DM binding) must still land once.
 */
const dedupKeyOf = (m: InboxMessage): string => `${m.source} ${m.meta.id ?? m.meta.messageId ?? m.content}`;

/**
 * One live relay for one (Codex issue, channel binding) pair. Exported
 * directly only for `createCodexChannelRelayPool`'s own `start` injection
 * seam (tests swap it there) — every other caller goes through the pool.
 */
export function startCodexChannelRelay(issue: string, binding: McpServerBinding, deps: CodexChannelRelayDeps): CodexChannelRelayHandle {
  const log = deps.log ?? (() => {});
  const connect = deps.connect ?? keepChannelSource;
  const now = deps.now ?? (() => Date.now());
  const dedupWindowMs = deps.dedupWindowMs ?? 5 * 60_000;
  const delivered = new Map<string, number>();

  const relay = sequentialDeliver({
    deliver: async (text, message): Promise<DeliveryOutcome> => {
      const key = dedupKeyOf(message);
      const last = delivered.get(key);
      if (last !== undefined && now() - last < dedupWindowMs) return { status: "rejected", detail: "duplicate of an already-delivered message" };
      const outcome = await deps.nudge(issue, text).catch((e): { delivered: boolean } => {
        log(`  [notify] codex channel relay: ${issue} ← ${binding.name}: nudge threw: ${e instanceof Error ? e.message : String(e)}`);
        return { delivered: false };
      });
      if (outcome.delivered) {
        delivered.set(key, now());
        log(`  [notify] codex channel relay: ${issue} ← ${binding.name}: codex prompt delivered`);
        return { status: "delivered" };
      }
      log(`  [notify] codex channel relay: ${issue} ← ${binding.name}: codex prompt refused/absent, will retry`);
      return { status: "failed", detail: "herd.nudge reported delivered:false" };
    },
    onEvent: (event) => {
      if (event.kind === "dropped") log(`  [notify] codex channel relay: ${issue} ← ${binding.name}: message dropped (${event.reason})`);
    },
  });

  // Review finding 2 (corrected against the rocketr design): a shared,
  // rule-level-only credential (`headersEnvVar`) can't let a channel server
  // route a message to "this agent alone" — every Codex agent sharing that
  // rule's connection would look identical to it. This daemon's OWN
  // connection now carries the SAME per-agent, non-secret account name
  // (`binding.accountHeader`, `McpServerBinding`'s own doc comment,
  // src/rules/rules.ts) that reaches Codex's own bound-server config for the
  // reply path (`boundCodexServers`, src/agents/argv.ts) — one account
  // identity, two consumers, via the SAME `resolveAccountHeader`
  // (src/agents/workspace.ts) both call, never two mechanisms.
  // `resolveMcpServerHeaders`'s own `headersEnvVar` resolution is ALSO used
  // here, merged with it: THIS process is the daemon itself, never a
  // launched child whose argv another local user can read, so a
  // `headersEnvVar`-resolved shared secret is exactly as safe here as it
  // already is for Claude's own direct connection (`buildWorkspace`'s own
  // mcp.json write does the identical merge). Header NAME assumed to match
  // Rocket.Chat's own convention when no `accountHeader` is configured
  // (`src/resources/rocketchat.ts`'s client uses the same pair) —
  // unverified against a real `rocketr`, which does not exist in this repo;
  // see docs/codex-channel-relay.md.
  const accountNameOf = deps.accountNameOf ?? (() => undefined);
  const envHeaders = resolveMcpServerHeaders(binding, undefined, log);
  const accountHeaders = resolveAccountHeader(binding, accountNameOf(issue));
  const headers = envHeaders || accountHeaders ? { ...envHeaders, ...accountHeaders } : undefined;
  const source = connect({
    name: binding.name,
    url: binding.url,
    ...(headers ? { headers } : {}),
    onMessage: (message) => relay.push(message),
    onStatus: (status: ChannelSourceStatus) => {
      if (status.kind === "disconnected") log(`  [notify] codex channel relay: ${issue} ← ${binding.name}: disconnected (${status.reason})`);
    },
  });

  return {
    async stop() {
      relay.stop();
      await source.stop();
    },
  };
}

export interface CodexChannelRelayPoolDeps extends CodexChannelRelayDeps {
  /** A running issue's rule's current MCP server bindings, or undefined for none — `src/daemon/index.ts`'s own `mcpBindingsOf` seam (BUTCHR-411), reused as-is. */
  bindingsOf: (issue: string) => readonly McpServerBinding[] | undefined;
  /** The issue's ACTUALLY OBSERVED provider right now, or null — `Herd.providerOf` (BUTCHR-413). Never a static config guess: ordered provider fallback (docs/agent-providers.md) can move an issue off Codex without this daemon being told. */
  providerOf: (issue: string) => Promise<string | null>;
  /** Every issue with a running butchr-managed agent right now — `Herd.runningIssues`. */
  runningIssues: () => Promise<string[]>;
  /** Injection seam for tests; defaults to `startCodexChannelRelay`. */
  start?: typeof startCodexChannelRelay;
}

/**
 * THE SEAM: the one thing `src/daemon/index.ts` calls, and the one thing
 * BUTCHR-359 needs to replace to subsume this stopgap — see this file's own
 * top comment. Any object satisfying this interface can stand in for
 * `createCodexChannelRelayPool`'s own return value with no change at the
 * call site (`reconcile()` on the same poll cadence as the rule loop,
 * `stopAll()` at shutdown) — a test builds an alternate implementation to
 * demonstrate exactly that.
 */
export interface CodexChannelRelayPool {
  /** Start relays for every (codex issue, channel binding) pair now running that lacks one; stop every relay whose issue/binding no longer applies. Idempotent — safe to call every poll. */
  reconcile(): Promise<void>;
  /** Stop every relay. Daemon shutdown / test teardown. */
  stopAll(): Promise<void>;
  readonly size: number;
}

/**
 * Reconciles live relays against currently-running Codex agents' channel
 * bindings — mirrors the shape of every other reconcile loop in this
 * codebase (compute desired, diff against actual, start/stop the delta) but
 * owns no admission/spawn decision of its own: it only ever attaches to an
 * agent `herd` already decided to run.
 */
export function createCodexChannelRelayPool(deps: CodexChannelRelayPoolDeps): CodexChannelRelayPool {
  const start = deps.start ?? startCodexChannelRelay;
  const active = new Map<string, CodexChannelRelayHandle>();
  const keyOf = (issue: string, binding: McpServerBinding) => `${issue} ${binding.name}`;
  return {
    async reconcile() {
      const issues = await deps.runningIssues();
      const wanted = new Set<string>();
      for (const issue of issues) {
        const bindings = (deps.bindingsOf(issue) ?? []).filter((b) => b.channel);
        if (bindings.length === 0) continue;
        // Checked per issue, only once a channel binding exists to act on:
        // an issue with no bindings never needs a provider lookup at all.
        const provider = await deps.providerOf(issue);
        // Review finding 3: `null` means "can't be determined right now"
        // (a herdr hiccup, a starting shell, a pane blocked on a dialog —
        // see `Herd.providerOf`'s own doc comment), NOT "not codex". Tearing
        // a relay down on a transient `null` would close its connection and
        // discard its queue/dedup state, then rebuild a poll later — any
        // push arriving in that gap is lost. So `null` only ever PRESERVES
        // an already-running relay; it never starts a new one (this daemon
        // isn't sure this issue is even Codex yet) and never tears one down.
        if (provider === null) {
          for (const binding of bindings) {
            const key = keyOf(issue, binding);
            if (active.has(key)) wanted.add(key);
          }
          continue;
        }
        if (provider !== "codex") continue; // OBSERVED as something else — a real signal, safe to tear down
        for (const binding of bindings) {
          const key = keyOf(issue, binding);
          wanted.add(key);
          if (!active.has(key)) {
            deps.log?.(`  [notify] codex channel relay: starting for ${issue} ← ${binding.name}`);
            active.set(key, start(issue, binding, deps));
          }
        }
      }
      for (const [key, handle] of [...active]) {
        if (wanted.has(key)) continue;
        active.delete(key);
        const [issue, name] = key.split(" ");
        deps.log?.(`  [notify] codex channel relay: stopping for ${issue} ← ${name} (no longer a codex agent with this binding)`);
        await handle.stop();
      }
    },
    async stopAll() {
      for (const [, handle] of active) await handle.stop();
      active.clear();
    },
    get size() { return active.size; },
  };
}
