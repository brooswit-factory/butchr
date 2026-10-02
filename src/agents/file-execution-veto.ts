/**
 * FACTORY-638 (FACTORY-636): a cheap tripwire against a file-executing
 * command whose FILE CONTENTS are destructive even though the visible
 * command line looks benign — `bun test <file>`, `sh <file>`, `python
 * <file>`, a here-doc, a `-c` body. On 2026-10-02 18:26Z this class of
 * command wiped `~/.claude` and `~/.codex` on codey: a payload sat inside a
 * test file and `autoAnswerPermissions` approved `bun test <that file>` on
 * the visible command line alone — see this module's own call site
 * (`permission-answer-loop.ts`'s pre-scan) for how the result narrows the
 * pane set `autoAnswerPermissions` is ever handed.
 *
 * THIS IS A TRIPWIRE, NOT A SANDBOX. Known, deliberate gaps — see this
 * repo's PR description for FACTORY-638 for the full list: obfuscation
 * (base64/eval/string building), content fetched or generated at run time,
 * content that changes between this read and actual execution (TOCTOU,
 * unavoidable without a real sandbox), indirect execution via a package
 * script or Makefile, an unreadable file (fails safe — see below, it is
 * never treated as benign), a runner/interpreter not on the short list this
 * module recognises, obfuscated or multi-level quoting this module's cheap
 * regexes don't unwrap, and — FACTORY-640 — a bare `bun test`/`bun run
 * <script>` (see below): it is APPROVED without its suite/script-list
 * content ever being read.
 *
 * Every verdict here is binary and fails CLOSED: `approve` only when this
 * module is confident nothing destructive is involved; `block` for
 * everything else, whether that is "destructive pattern matched" or "could
 * not verify" (unreadable, oversized, outside the workspace, no cwd to
 * resolve against, a dynamic/unknowable target like `xargs sh`). The caller
 * never distinguishes the two at the control-flow level — both leave the
 * pane unanswered — but `reason` always says which it was, for the audit
 * trail and the human who has to look.
 *
 * FACTORY-640 (round 2 of FACTORY-636's review): a bare `bun test`/`bun run
 * <script>` — no explicit file argument — is deliberately APPROVED, not
 * vetoed, despite running MORE unreviewed content than one named file, not
 * less. FACTORY-625's fail-closed fallback clause is scoped to a path
 * OUTSIDE the workspace; the workspace's own suite/scripts are never that.
 * And there is no `[butchr:blocked]` ANSWER-protocol escalation for this
 * dialog class (only the much slower `[butchr:unresponsive]` alarm), so
 * vetoing the fleet's single most common command would convert this tripwire
 * into routine frozen panes — the same incident class BUTCHR-124 exists to
 * prevent, at larger scale. `dynamic` (fail-closed) stays reserved for a
 * genuinely unknowable target like `xargs sh`.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** First 256 KB of a candidate file is read; anything larger is refused outright (never partially read then matched — a truncated read could miss or misreport a pattern straddling the cut). */
export const MAX_FILE_READ_BYTES = 256 * 1024;

export interface FileExecutionVetoRequest {
  /** The dialog's visible command/body (`PermissionPrompt.request`). */
  request: string;
  /** The pending permission's own `cwd` (`PendingPermission.cwd`) — relative file targets resolve against this, never `process.cwd()`. */
  cwd: string | undefined;
}

export type FileExecutionVerdict =
  | { approve: true }
  | { approve: false; reason: string; file?: string; pattern?: string };

/** Normalises CRLF and collapses runs of horizontal whitespace, so a pattern written for one space never misses a payload formatted with tabs or repeated spaces. Never touches newlines — several patterns below are deliberately per-line or care about shell separators that include `\n`. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
}

/**
 * FACTORY-638 review (round 1): the real incident shape is `rm` sitting
 * INSIDE source code — a bun `$` shell template (`` await $`x; rm -rf ~`; ``),
 * a quoted `exec`/`spawn` string (`exec("rm -rf $HOME")`), or just a
 * trailing `)`/`;` from surrounding syntax (`rm -rf ~)`) — never the bare
 * shell string the first pass's fixture pretended it was. Every one of
 * those leaves a stray delimiter stuck to the token a naive tokeniser reads
 * as the `rm` target, and an EXACT match against `~`/`$HOME`/`/` then
 * silently misses it. Strip any such delimiter running off either end
 * before comparing — never equality-match a raw, unstripped token against a
 * dangerous root.
 */
function stripDelimiters(tok: string): string {
  return tok.replace(/^[`'"({[]+/, "").replace(/[`'")}\];,]+$/, "");
}

/** `~`, `$HOME`, `${HOME}`, `/`, bare `*`, or any of those with a trailing `/*` glob — the destructive `rm`/`chmod`/`chown` roots item 3 of the ticket names. */
function isDangerousRoot(tok: string): boolean {
  const t = stripDelimiters(tok);
  if (t === "~" || t === "/" || t === "*") return true;
  if (/^~\/\*?$/.test(t)) return true;
  if (/^\$\{?HOME\}?\/?\*?$/.test(t)) return true;
  if (/^\/\*$/.test(t)) return true;
  return false;
}

/** The cheap shell/source-line separators this whole module treats a compound command as made of — never a real parser. Shared by destructive-pattern matching and runner-target extraction so both see the exact same segments. */
function splitShellSegments(content: string): string[] {
  return content.split(/[;\n]|&&|\|\|/);
}

/**
 * One `rm`/`chmod`/`chown`-shaped shell segment at a time, tokenised on
 * whitespace. Returns the first segment whose option tokens carry both of
 * `wantFlags` (checked char-by-char against short option tokens, or matched
 * against the long option names) and whose non-option tokens include a
 * dangerous root (delimiter-stripped — see `isDangerousRoot`).
 */
function findFlaggedCommand(content: string, verb: RegExp, wantFlags: readonly string[], longFlags: readonly string[]): string | null {
  for (const raw of splitShellSegments(content)) {
    const segment = raw.trim();
    if (!verb.test(segment)) continue;
    const afterVerb = segment.replace(verb, "");
    const tokens = afterVerb.trim().split(/\s+/).filter(Boolean);
    const have = new Set<string>();
    const targets: string[] = [];
    for (const tok of tokens) {
      if (tok.startsWith("--")) {
        if (longFlags.includes(tok)) {
          const idx = longFlags.indexOf(tok);
          have.add(wantFlags[idx]!);
        }
      } else if (tok.startsWith("-") && tok.length > 1) {
        for (const f of wantFlags) if (tok.includes(f)) have.add(f);
      } else if (tok.length > 0) {
        targets.push(tok);
      }
    }
    if (wantFlags.every((f) => have.has(f)) && targets.some(isDangerousRoot)) return segment;
  }
  return null;
}

const DESTRUCTIVE_CHECKS: ReadonlyArray<{ name: string; test: (content: string) => string | null }> = [
  {
    name: "rm -rf against $HOME/root/wildcard",
    test: (c) => findFlaggedCommand(c, /\brm\b/, ["r", "f"], ["--recursive", "--force"]),
  },
  {
    name: "chmod -R on $HOME or /",
    test: (c) => findFlaggedCommand(c, /\bchmod\b/, ["R"], ["--recursive"]),
  },
  {
    name: "chown -R on $HOME or /",
    test: (c) => findFlaggedCommand(c, /\bchown\b/, ["R"], ["--recursive"]),
  },
  {
    // The target here is matched by PREFIX (`/^\/dev\//` etc.), never
    // exact-equality, so a trailing delimiter pulled in by `[^\s;"]+`
    // (e.g. from a surrounding JS string: `exec('dd of=/etc/passwd')`)
    // can't defeat it the way it could an exact match — stripped anyway,
    // for a clean audit excerpt.
    name: "dd targeting a device/system path",
    test: (c) => {
      const m = /\bdd\b[^;\n]*\bof=(['"]?)([^\s;'"]+)\1/i.exec(c);
      if (!m) return null;
      const target = stripDelimiters(m[2]!);
      return /^\/dev\/(sd|nvme|hd)/.test(target) || /^\/(etc|boot)(\/|$)/.test(target) ? m[0] : null;
    },
  },
  {
    name: "mkfs",
    test: (c) => (/\bmkfs(\.\w+)?\b/i.test(c) ? c.match(/\bmkfs(\.\w+)?\b[^;\n]*/i)?.[0] ?? "mkfs" : null),
  },
  {
    // Same PREFIX-match reasoning as `dd` above: the alternation anchors at
    // the start of the captured group, so a trailing delimiter inside the
    // greedy `\S*` never changes whether it matches.
    name: "redirect/tee onto a sensitive path",
    test: (c) => {
      const m = /(>>?|\btee\b)\s*(-a\s+)?(['"]?)(~\/\.(?:ssh|claude|codex|config)\S*|\/etc\/\S*|\/boot\/\S*|\/dev\/(?:sd|nvme)\S*)\3/i.exec(c);
      return m ? m[0] : null;
    },
  },
  {
    name: "curl/wget piped into a shell",
    test: (c) => {
      const m = /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i.exec(c);
      return m ? m[0] : null;
    },
  },
  {
    name: "fork bomb",
    test: (c) => (/:\s*\(\s*\)\s*\{/.test(c) ? ":(){ ... }" : null),
  },
];

/** The first destructive pattern `content` matches, or `null`. Cheap regex over text, never a language parser — see this module's own header for the gaps that leaves. */
export function matchDestructivePattern(content: string): { name: string; excerpt: string } | null {
  const normalized = normalizeWhitespace(content);
  for (const check of DESTRUCTIVE_CHECKS) {
    const excerpt = check.test(normalized);
    if (excerpt) return { name: check.name, excerpt: excerpt.slice(0, 200) };
  }
  return null;
}

/**
 * A heredoc body (`<<'EOF' ... EOF`, `<<-EOF ... EOF`, quoted or not), a
 * `sh -c`/`bash -c`/`zsh -c` quoted body, a `node -e`/`--eval`/`-p`/`--print`
 * quoted body, or a `python`/`python3 -c` quoted body — content already
 * fully visible on the dialog's own screen, so reading nothing more is
 * needed to inspect it. FACTORY-640 (round 2 of FACTORY-636's review): these
 * `node`/`python` inline forms previously blocked only BY ACCIDENT, because
 * the flag token itself failed to `stat` as a file — routing them here
 * means they are vetoed deliberately, for the inline-body reason, same as a
 * here-doc.
 */
export function extractInlineBodies(command: string): string[] {
  const bodies: string[] = [];
  const heredocRe = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\b/g;
  let m: RegExpExecArray | null;
  while ((m = heredocRe.exec(command))) bodies.push(m[3]!);
  const dashCRe = /\b(?:sh|bash|zsh)\s+-c\s+(['"])([\s\S]*?)\1/g;
  while ((m = dashCRe.exec(command))) bodies.push(m[2]!);
  const nodeInlineRe = /\bnode\s+(?:-\S+\s+)*?(?:-e|--eval|-p|--print)\s+(['"])([\s\S]*?)\1/g;
  while ((m = nodeInlineRe.exec(command))) bodies.push(m[2]!);
  const pyInlineRe = /\bpython3?\s+(?:-\S+\s+)*?-c\s+(['"])([\s\S]*?)\1/g;
  while ((m = pyInlineRe.exec(command))) bodies.push(m[2]!);
  return bodies;
}

export type RunnerFileTarget =
  | { kind: "file"; path: string }
  /** A runner whose executed content cannot be pinned to a single static file, and is genuinely unknowable rather than deliberately approved (`xargs sh`; a `-c`/`-e`/`-p` inline body is handled separately, by `extractInlineBodies`, and a bare `bun test`/`bun run` is handled separately too — see this module's header for why that one is APPROVED, not `dynamic`) — never treated as benign; see this module's header. */
  | { kind: "dynamic"; detail: string };

/** A runner argument token that actually looks like a path, not a bare word (a flag, an option's own non-path value like a module/package name, or — FACTORY-638 review round 1 — a word from the NEXT line of a multi-line description bleeding in). Deliberately permissive (contains `.` or `/`, or starts with `~`): a cheap positive filter, not a path grammar. */
function looksLikeFilePath(tok: string): boolean {
  return tok.includes("/") || tok.includes(".") || tok.startsWith("~");
}

/**
 * FACTORY-640 (round 2 of FACTORY-636's review): the first non-flag,
 * path-shaped token among `tokens` — every runner branch below (`bun
 * test`/`run`, `node`, `python`, `sh|bash|zsh`, `source`) uses this SAME
 * narrowing, so an option token (`--version`, `-v`, `-m`) is never mistaken
 * for the file being executed. A flag's own non-path VALUE (`-m pytest`'s
 * `pytest`) is never specially skipped — it simply never passes
 * `looksLikeFilePath`, so it is skipped by the same filter, not a separate
 * rule. Returns `undefined` when no such operand exists: the invocation is
 * then either flag-only (`node --version`) or its content is already fully
 * covered by `extractInlineBodies` (`node -e`, `python -c`, `sh -c`), which
 * runs earlier in `classifyFileExecutionRisk` — never treat "no operand
 * found here" as "nothing to inspect" on its own.
 */
function findPathShapedOperand(tokens: string[]): string | undefined {
  return tokens.find((t) => !t.startsWith("-") && looksLikeFilePath(t));
}

/**
 * One segment (already split by `splitShellSegments` — a single shell
 * "line", never spanning a `;`/`&&`/`||`/newline) at a time. FACTORY-638
 * review round 1: operating per-segment, rather than over the whole
 * multi-line command the first pass used, is what stops a `bun test`
 * invocation's own trailing description line (`"bun test\nRun the new
 * test"`) from being read as its file argument — `\s+` can no longer walk
 * across a line this function never sees joined to the next.
 */
function extractSingleRunnerFileTarget(segment: string): RunnerFileTarget | undefined {
  if (/\bxargs\b[^|]*\b(sh|bash|zsh)\b/i.test(segment)) return { kind: "dynamic", detail: "xargs piping into a shell — executed content is not a single static file" };

  // FACTORY-640: an option token (`bash -l deploy.sh`'s `-l`) is no longer
  // mistaken for the file — `findPathShapedOperand` skips it and keeps
  // looking, so `deploy.sh` is still found and still inspected.
  const shDashC = /\b(sh|bash|zsh)\s+-c\b/i.test(segment);
  if (!shDashC) {
    const shMatch = /\b(sh|bash|zsh)\s+(.*)$/i.exec(segment);
    if (shMatch) {
      const tokens = shMatch[2]!.trim().split(/\s+/).filter(Boolean);
      const fileTok = findPathShapedOperand(tokens);
      if (fileTok) return { kind: "file", path: stripDelimiters(fileTok) };
    }
  }

  // FACTORY-640 (round 2 of FACTORY-636's review): a bare `bun test`/`bun
  // run <script>` — no explicit file argument — runs the workspace's OWN
  // suite/script list, which FACTORY-625's fail-closed fallback clause
  // (scoped to a path OUTSIDE the workspace) never authorized vetoing, and
  // which freezes a pane with no `[butchr:blocked]` ANSWER escalation
  // available for this dialog class. Approve it (fall through to "no
  // target recognised" below) rather than returning `dynamic`; a bare `bun
  // test`/`bun run` still cannot see what the suite/scripts contain — that
  // uninspected-content gap is stated in this PR's limitations, not hidden
  // here.
  const bunTestOrRun = /\bbun\s+(test|run)\b/i.exec(segment);
  if (bunTestOrRun) {
    const rest = segment.slice(bunTestOrRun.index + bunTestOrRun[0].length).trim();
    const tokens = rest.split(/\s+/).filter(Boolean);
    const fileTok = findPathShapedOperand(tokens);
    if (fileTok) return { kind: "file", path: stripDelimiters(fileTok) };
    return undefined;
  }

  // FACTORY-640: `node -e`/`--eval`/`-p`/`--print` and `python`/`python3
  // -c` execute an INLINE body, not a file — that body is already routed
  // through `extractInlineBodies` (run earlier in
  // `classifyFileExecutionRisk`, straight off the visible command text), so
  // reporting a "file target" here would be redundant at best and wrong at
  // worst (there is no file to stat). Recognising the flag here only to
  // skip it, rather than never recognising `node`/`python` at all, is what
  // stops `node -e '<payload>'` from falling through to "no runner
  // recognised" and being approved by accident — the exact trap named in
  // FACTORY-636's review.
  const nodeMatch = /\bnode\s+(.*)$/i.exec(segment);
  if (nodeMatch) {
    const tokens = nodeMatch[1]!.trim().split(/\s+/).filter(Boolean);
    if (tokens.some((t) => t === "-e" || t === "--eval" || t === "-p" || t === "--print")) return undefined;
    const fileTok = findPathShapedOperand(tokens);
    if (fileTok) return { kind: "file", path: stripDelimiters(fileTok) };
    return undefined;
  }

  const pyMatch = /\bpython3?\s+(.*)$/i.exec(segment);
  if (pyMatch) {
    const tokens = pyMatch[1]!.trim().split(/\s+/).filter(Boolean);
    if (tokens.some((t) => t === "-c")) return undefined;
    const fileTok = findPathShapedOperand(tokens);
    if (fileTok) return { kind: "file", path: stripDelimiters(fileTok) };
    return undefined;
  }

  const sourceMatch = /\bsource\s+(.*)$/i.exec(segment);
  if (sourceMatch) {
    const tokens = sourceMatch[1]!.trim().split(/\s+/).filter(Boolean);
    const fileTok = findPathShapedOperand(tokens);
    if (fileTok) return { kind: "file", path: stripDelimiters(fileTok) };
    return undefined;
  }

  const dotSlash = /(^|\s)(\.\/\S+)/.exec(segment);
  if (dotSlash) return { kind: "file", path: stripDelimiters(dotSlash[2]!) };

  return undefined;
}

/**
 * Every file-executing runner invocation in `command` — the SAME narrow
 * list the ticket names: `bun test`/`bun run`, `node`, `python`,
 * `sh`/`bash`/`zsh <file>`, `source`, `./file`, `xargs sh`. FACTORY-638
 * review round 1: a COMPOUND command (`sh ok.sh; sh evil.sh`) is split
 * into its shell segments first and EVERY segment's own runner is
 * reported, not just the first match in the whole string — a caller that
 * only inspected the first target would wave the second straight through.
 * A `-c` body is never reported here — `extractInlineBodies` already
 * inspects it directly, from the screen, with no file read needed.
 */
export function extractRunnerFileTargets(command: string): RunnerFileTarget[] {
  const targets: RunnerFileTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const t = extractSingleRunnerFileTarget(segment);
    if (t) targets.push(t);
  }
  return targets;
}

/** `resolved` (already `path.resolve`d) is `cwd` itself or strictly nested under it — never an upward `..` escape or an absolute path elsewhere. */
function isWithinWorkspace(resolved: string, cwd: string): boolean {
  const root = resolve(cwd);
  return resolved === root || resolved.startsWith(root + sep);
}

/** One recognised file target, resolved/read/matched — the per-target half of `classifyFileExecutionRisk`, called once per entry `extractRunnerFileTargets` returns. */
async function classifyFileTarget(target: Extract<RunnerFileTarget, { kind: "file" }>, cwd: string | undefined): Promise<FileExecutionVerdict> {
  if (!cwd) return { approve: false, reason: `runner names file "${target.path}" but no cwd was available to resolve it against`, file: target.path };
  const resolved = resolve(cwd, target.path);
  if (!isWithinWorkspace(resolved, cwd)) return { approve: false, reason: `file target is outside the workspace (resolved ${resolved}, cwd ${cwd})`, file: resolved };

  let st;
  try {
    st = await stat(resolved);
  } catch (e) {
    return { approve: false, reason: `file target is unreadable: ${(e as Error)?.message ?? e}`, file: resolved };
  }
  if (!st.isFile()) return { approve: false, reason: `file target is not a regular file`, file: resolved };
  if (st.size > MAX_FILE_READ_BYTES) return { approve: false, reason: `file target is oversized (${st.size} bytes > ${MAX_FILE_READ_BYTES})`, file: resolved };

  let content: string;
  try {
    content = await readFile(resolved, "utf8");
  } catch (e) {
    return { approve: false, reason: `file target is unreadable: ${(e as Error)?.message ?? e}`, file: resolved };
  }
  const hit = matchDestructivePattern(content);
  if (hit) return { approve: false, reason: `file content matches ${hit.name}: "${hit.excerpt}"`, pattern: hit.name, file: resolved };
  return { approve: true };
}

/**
 * The single entry point `permission-answer-loop.ts`'s pre-scan calls per
 * pending permission. Checks, in order: (1) any heredoc/`-c` body already
 * visible on screen, against the full destructive-pattern set; (2) the
 * visible command text itself, but ONLY against the two patterns whose
 * danger is inherent to the command line regardless of any file —
 * `curl/wget | sh` (content fetched at run time, nothing to read) and a
 * fork bomb (no file, no pipe — the command IS the payload); (3) EVERY
 * recognised file-executing runner's target (FACTORY-638 review round 1:
 * not just the first one in a compound command), read from disk (bounded,
 * resolved against `req.cwd`, refused outside it) and checked the same way
 * — the first target that doesn't verify as safe ends the scan immediately
 * (fail closed, no need to read the rest). Every other destructive pattern
 * (bare `rm -rf /` typed directly, with no file or pipe involved) is
 * deliberately NOT matched against the visible command here — out of scope
 * for this ticket (see its own "do not change" list) and a different,
 * already-separately-handled problem (Claude's own too-complex-command
 * classifier denial, per `@brooswit/drovr`'s own `permission-approval.ts`
 * header).
 */
export async function classifyFileExecutionRisk(req: FileExecutionVetoRequest): Promise<FileExecutionVerdict> {
  for (const body of extractInlineBodies(req.request)) {
    const hit = matchDestructivePattern(body);
    if (hit) return { approve: false, reason: `an inline script body matches ${hit.name}: "${hit.excerpt}"`, pattern: hit.name };
  }

  const visibleHit = matchDestructivePattern(req.request);
  if (visibleHit && (visibleHit.name === "curl/wget piped into a shell" || visibleHit.name === "fork bomb")) {
    return { approve: false, reason: `the visible command matches ${visibleHit.name}: "${visibleHit.excerpt}"`, pattern: visibleHit.name };
  }

  for (const target of extractRunnerFileTargets(req.request)) {
    const verdict = target.kind === "dynamic" ? ({ approve: false, reason: target.detail } as const) : await classifyFileTarget(target, req.cwd);
    if (!verdict.approve) return verdict;
  }
  return { approve: true };
}
