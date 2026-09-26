import { Elysia } from "elysia";
import { thatch } from "@brooswit/thatch";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { listenOptions } from "../src/daemon/listen.js";

/**
 * BUTCHR-411 — staged, MANUAL probe of whether a Claude session launched
 * with a bound, non-butchr MCP channel server (a rule's `mcpServers` entry
 * with `channel: true`) receives that server's push. Exercises the exact
 * wire mechanism butchr's own `server:butchr` already relies on
 * (`@brooswit/thatch`'s `sendAll`, `notifications/claude/channel` —
 * src/daemon/app.ts's `notifyIssue`/`notifyAgent`), just on a second,
 * independent MCP server named on `--dangerously-load-development-channels`
 * the same way `server:butchr` is — the transport-level piece this ticket's
 * argv/mcp.json wiring actually controls.
 *
 * NOT run by `bun run check`, NOT part of the unit suite: it spawns a real
 * `claude --bg` process and a real model turn (same "manual, not CI" shape
 * as scripts/verify-codex-config.ts). Touches no butchr daemon, no rule, no
 * live config — a throwaway local probe server plus a throwaway scratch
 * workspace. Run by hand: `bun run scripts/verify-channel-delivery.ts`.
 *
 * IMPORTANT CAVEAT (recorded here so a future reader doesn't re-discover it
 * the expensive way): `claude agents --json` shows every REAL butchr/herdr
 * agent as `"kind": "interactive"` — herdr launches and keeps Claude
 * resident in an actual PTY pane it continuously manages. `claude --bg` is
 * Claude Code's OWN, separate `"kind": "background"` session-residency
 * feature — not herdr's pane model. This script can only drive `--bg`
 * (there is no raw-CLI way to reproduce herdr's PTY residency from outside
 * butchr, and BUTCHR-368/this ticket forbid touching the live daemon), so a
 * negative result here does not, on its own, indict the argv/mcp.json
 * wiring this ticket adds — see docs/mcp-server-bindings.md's "what this
 * script could and couldn't verify" section for the full account, including
 * the first-hand confirmation (this task's own agent received a real
 * `server:butchr` push, unprompted, mid-turn, during THIS ticket's work).
 *
 * Bounded deliberately: `--tools ""` (no Bash/Edit/etc — a text-only
 * session), `--strict-mcp-config` (only this probe server, nothing else),
 * and the probe's own kickoff prompt asks for nothing but a short fixed
 * acknowledgement. Cleans up its background session and probe server on
 * every exit path.
 */
async function main() {
  const port = 39217 + Math.floor(Math.random() * 1000);
  const { plugin, mcp } = thatch({ serverInfo: { name: "channel-probe", version: "0" }, tools: {} });
  const app = new Elysia().use(plugin);
  app.listen(listenOptions(port));
  const url = `http://127.0.0.1:${port}/mcp`;
  console.log(`[probe] listening at ${url}`);

  const dir = mkdtempSync(join(tmpdir(), "butchr-channel-probe-"));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { probe: { type: "http", url } } }, null, 2));

  const PROBE_TOKEN = `probe-${Date.now()}`;
  const PUSH_INTERVAL_MS = 5000;
  const PUSH_COUNT = 8; // repeated, not a single shot — rules out a one-off timing race
  let transportDeliveries = 0;
  const pushTimer = setInterval(async () => {
    if (transportDeliveries >= PUSH_COUNT) { clearInterval(pushTimer); return; }
    const result = await mcp.sendAll({ content: `CHANNEL_PROBE:${PROBE_TOKEN}:${transportDeliveries + 1}`, meta: {} });
    if (result.sent.length > 0) transportDeliveries++;
    console.log(`[probe] push attempt -> sent=${JSON.stringify(result.sent)} refused=${JSON.stringify(result.refused)}`);
  }, PUSH_INTERVAL_MS);

  const prompt = `You are participating in an automated, bounded test fixture (BUTCHR-411). Do nothing and send no message. Do not use any tool. Wait quietly. When — and only when — you receive a channel message, reply with EXACTLY this text and nothing else: CHANNEL_RECEIVED:${PROBE_TOKEN}. Then stop.`;

  const args = [
    prompt, // kickoff positional MUST be first — argv.ts's own doc comment on why
    "--permission-mode", "bypassPermissions",
    "--mcp-config", join(dir, "mcp.json"),
    "--strict-mcp-config",
    "--tools", "",
    `--dangerously-load-development-channels=server:probe`,
    "--bg",
  ];
  console.log(`[probe] launching: claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  const launch = Bun.spawnSync(["claude", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const stdout = launch.stdout.toString();
  const stderr = launch.stderr.toString();
  console.log(`[probe] launch stdout: ${stdout.trim()}`);
  if (stderr.trim()) console.log(`[probe] launch stderr: ${stderr.trim()}`);
  // "backgrounded · <id>" — anchored on the literal label, not a bare
  // alphanumeric-run regex (which matched the word "backgrounded" itself in
  // an earlier version of this script, silently breaking cleanup and
  // orphaning a live background session).
  const idMatch = stdout.match(/backgrounded\s*[·:]\s*([a-zA-Z0-9_-]+)/);
  const id = idMatch?.[1];

  // The transcript JSONL is far more reliable to inspect than `claude logs`
  // (a raw ANSI terminal dump, redrawn character-by-character mid-stream).
  const transcriptPath = (): string | null => {
    if (!id) return null;
    const slug = dir.replace(/[\\/]/g, "-");
    try {
      const path = join(homedir(), ".claude", "projects", slug, `${id}.jsonl`);
      readFileSync(path, "utf8");
      return path;
    } catch { return null; }
  };

  let verdict = "UNKNOWN — could not determine a background session id from claude --bg's own output";
  try {
    if (!id) throw new Error("no id parsed");
    const deadline = Date.now() + PUSH_INTERVAL_MS * PUSH_COUNT + 15_000;
    let received = false;
    while (Date.now() < deadline) {
      const path = transcriptPath();
      if (path) {
        const text = readFileSync(path, "utf8");
        if (text.includes(`CHANNEL_RECEIVED:${PROBE_TOKEN}`)) { received = true; break; }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (received) verdict = `PASS — the background session's own reply contained CHANNEL_RECEIVED:${PROBE_TOKEN}, with no message sent to it beyond the initial kickoff`;
    else if (transportDeliveries === 0) verdict = "FAIL (transport) — the probe server never recorded a single successful sendAll delivery";
    else verdict = `INCONCLUSIVE — ${transportDeliveries} transport-level deliveries (thatch's own "C2: transport accepted" claim) were confirmed, but no corresponding reply ever appeared in the --bg session's transcript. See this script's own top-of-file caveat: --bg is Claude Code's own background-session feature, not herdr's PTY-pane residency — this result does not, by itself, indict the argv/mcp.json wiring.`;
  } finally {
    if (id) {
      Bun.spawnSync(["claude", "stop", id]);
      Bun.spawnSync(["claude", "rm", id]);
    }
    clearInterval(pushTimer);
    await mcp.closeAll();
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`[probe] VERDICT: ${verdict}`);
  if (!verdict.startsWith("PASS")) process.exitCode = 1;
}

if (import.meta.main) await main();
