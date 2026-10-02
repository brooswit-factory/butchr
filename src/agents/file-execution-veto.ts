/**
 * FACTORY-638 (FACTORY-636): a cheap tripwire against a file-executing
 * command whose FILE CONTENTS are destructive even though the visible
 * command line looks benign — `bun test <file>`, `sh <file>`, `python
 * <file>`, a here-doc, a `-c` body. On 2026-10-02 18:26Z this class of
 * command wiped `~/.claude` and `~/.codex` on codey: a payload `x; rm -rf ~`
 * sat inside a test file and `autoAnswerPermissions` approved `bun test
 * <that file>` on the visible command line alone — see this module's own
 * call site (`permission-answer-loop.ts`'s pre-scan) for how the result
 * narrows the pane set `autoAnswerPermissions` is ever handed.
 *
 * THIS IS A TRIPWIRE, NOT A SANDBOX. Known, deliberate gaps — see this
 * repo's PR description for FACTORY-638 for the full list: obfuscation
 * (base64/eval/string building), content fetched or generated at run time,
 * content that changes between this read and actual execution (TOCTOU,
 * unavoidable without a real sandbox), indirect execution via a package
 * script or Makefile, an unreadable file (fails safe — see below, it is
 * never treated as benign), a runner/interpreter not on the short list this
 * module recognises, and obfuscated or multi-level quoting this module's
 * cheap regexes don't unwrap.
 *
 * Every verdict here is binary and fails CLOSED: `approve` only when this
 * module is confident nothing destructive is involved; `block` for
 * everything else, whether that is "destructive pattern matched" or "could
 * not verify" (unreadable, oversized, outside the workspace, no cwd to
 * resolve against, a dynamic/unknowable target like `xargs sh`). The caller
 * never distinguishes the two at the control-flow level — both leave the
 * pane unanswered — but `reason` always says which it was, for the audit
 * trail and the human who has to look.
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

function stripQuotes(tok: string): string {
  if (tok.length >= 2) {
    const first = tok[0];
    const last = tok[tok.length - 1];
    if ((first === "\"" || first === "'") && first === last) return tok.slice(1, -1);
  }
  return tok;
}

/** `~`, `$HOME`, `${HOME}`, `/`, bare `*`, or any of those with a trailing `/*` glob — the destructive `rm`/`chmod`/`chown` roots item 3 of the ticket names. */
function isDangerousRoot(tok: string): boolean {
  const t = stripQuotes(tok);
  if (t === "~" || t === "/" || t === "*") return true;
  if (/^~\/\*?$/.test(t)) return true;
  if (/^\$\{?HOME\}?\/?\*?$/.test(t)) return true;
  if (/^\/\*$/.test(t)) return true;
  return false;
}

/**
 * One `rm`/`chmod`/`chown`-shaped shell segment at a time (split on the
 * cheap shell separators `;`, `&&`, `||`, `|`, newline — never a real
 * parser, per the ticket's own "narrow cheap regex, don't parse the
 * language" instruction), tokenised on whitespace. Returns the first
 * segment whose option tokens carry both of `wantFlags` (checked
 * char-by-char against short option tokens, or matched against the long
 * option names) and whose non-option tokens include a dangerous root.
 */
function findFlaggedCommand(content: string, verb: RegExp, wantFlags: readonly string[], longFlags: readonly string[]): string | null {
  const segments = content.split(/[;\n]|&&|\|\|/);
  for (const raw of segments) {
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
    name: "dd targeting a device/system path",
    test: (c) => {
      const m = /\bdd\b[^;\n]*\bof=("?)([^\s;"]+)\1/i.exec(c);
      if (!m) return null;
      const target = m[2]!;
      return /^\/dev\/(sd|nvme|hd)/.test(target) || /^\/(etc|boot)(\/|$)/.test(target) ? m[0] : null;
    },
  },
  {
    name: "mkfs",
    test: (c) => (/\bmkfs(\.\w+)?\b/i.test(c) ? c.match(/\bmkfs(\.\w+)?\b[^;\n]*/i)?.[0] ?? "mkfs" : null),
  },
  {
    name: "redirect/tee onto a sensitive path",
    test: (c) => {
      const m = /(>>?|\btee\b)\s*(-a\s+)?("?)(~\/\.(?:ssh|claude|codex|config)\S*|\/etc\/\S*|\/boot\/\S*|\/dev\/(?:sd|nvme)\S*)\3/i.exec(c);
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

/** A heredoc body (`<<'EOF' ... EOF`, `<<-EOF ... EOF`, quoted or not) or a `sh -c`/`bash -c`/`zsh -c` quoted body — content already fully visible on the dialog's own screen, so reading nothing more is needed to inspect it. */
export function extractInlineBodies(command: string): string[] {
  const bodies: string[] = [];
  const heredocRe = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\b/g;
  let m: RegExpExecArray | null;
  while ((m = heredocRe.exec(command))) bodies.push(m[3]!);
  const dashCRe = /\b(?:sh|bash|zsh)\s+-c\s+(['"])([\s\S]*?)\1/g;
  while ((m = dashCRe.exec(command))) bodies.push(m[2]!);
  return bodies;
}

export type RunnerFileTarget =
  | { kind: "file"; path: string }
  /** A runner whose executed content cannot be pinned to a single static file (`xargs sh`, a `-c` body already handled by `extractInlineBodies`) — never treated as benign; see this module's header. */
  | { kind: "dynamic"; detail: string }
  | { kind: "none" };

const FILE_RUNNER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bbun\s+test\s+(?:--?\S+\s+)*(\S+)/i,
  /\bbun\s+run\s+(?:--?\S+\s+)*(\S+)/i,
  /\bnode\s+(?:--\S+\s+)*(\S+)/i,
  /\bpython3?\s+(?:-\S+\s+)*(\S+)/i,
  /\bsource\s+(\S+)/i,
];

/** Which file (if any) a recognised runner invocation would execute — the SAME narrow list the ticket names: `bun test`/`bun run`, `node`, `python`, `sh`/`bash`/`zsh <file>`, `source`, `./file`, `xargs sh`. A `-c` body is never reported here — `extractInlineBodies` already inspects it directly, from the screen, with no file read needed. */
export function extractRunnerFileTarget(command: string): RunnerFileTarget {
  if (/\bxargs\b[^|\n]*\b(sh|bash|zsh)\b/i.test(command)) return { kind: "dynamic", detail: "xargs piping into a shell — executed content is not a single static file" };
  const shDashC = /\b(sh|bash|zsh)\s+-c\b/i.test(command);
  if (!shDashC) {
    const shMatch = /\b(?:sh|bash|zsh)\s+(\S+)/i.exec(command);
    if (shMatch) return { kind: "file", path: stripQuotes(shMatch[1]!) };
  }
  for (const re of FILE_RUNNER_PATTERNS) {
    const m = re.exec(command);
    if (m) return { kind: "file", path: stripQuotes(m[1]!) };
  }
  const dotSlash = /(^|\s)(\.\/\S+)/.exec(command);
  if (dotSlash) return { kind: "file", path: stripQuotes(dotSlash[2]!) };
  return { kind: "none" };
}

/** `resolved` (already `path.resolve`d) is `cwd` itself or strictly nested under it — never an upward `..` escape or an absolute path elsewhere. */
function isWithinWorkspace(resolved: string, cwd: string): boolean {
  const root = resolve(cwd);
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * The single entry point `permission-answer-loop.ts`'s pre-scan calls per
 * pending permission. Checks, in order: (1) any heredoc/`-c` body already
 * visible on screen, against the full destructive-pattern set; (2) a
 * recognised file-executing runner's target file, read from disk (bounded,
 * resolved against `req.cwd`, refused outside it) and checked the same way;
 * (3) the visible command text itself, but ONLY against the two patterns
 * whose danger is inherent to the command line regardless of any file —
 * `curl/wget | sh` (content fetched at run time, nothing to read) and a
 * fork bomb (no file, no pipe — the command IS the payload). Every other
 * destructive pattern (bare `rm -rf /` typed directly, with no file or pipe
 * involved) is deliberately NOT matched against the visible command here —
 * out of scope for this ticket (see its own "do not change" list) and a
 * different, already-separately-handled problem (Claude's own
 * too-complex-command classifier denial, per `@brooswit/drovr`'s own
 * `permission-approval.ts` header).
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

  const target = extractRunnerFileTarget(req.request);
  if (target.kind === "none") return { approve: true };
  if (target.kind === "dynamic") return { approve: false, reason: target.detail };

  if (!req.cwd) return { approve: false, reason: `runner names file "${target.path}" but no cwd was available to resolve it against`, file: target.path };
  const resolved = resolve(req.cwd, target.path);
  if (!isWithinWorkspace(resolved, req.cwd)) return { approve: false, reason: `file target is outside the workspace (resolved ${resolved}, cwd ${req.cwd})`, file: resolved };

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
