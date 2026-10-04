#!/usr/bin/env python3
"""butchr file-execution veto — a PreToolUse(Bash) tripwire. FACTORY-625.

USAGE (replay gate — one command per invocation, nothing is executed):
    echo 'bun test foo.ts' | python3 file-execution-veto.py --print
    exit 0 = allow, 2 = block; the reason is printed on stderr.
    Add --cwd DIR to resolve relative file arguments; defaults to $PWD.
    Reads EITHER a bare command line on stdin, OR Claude Code's PreToolUse
    hook JSON (auto-detected). No daemon, no network, python3 stdlib only.

WHY THIS EXISTS: on 2026-10-02 a benign-looking `bun <file>` wiped ~/.claude
and ~/.codex on codey, because the destructive payload sat INSIDE the file.
This reads the command text Claude is about to run (not a rendered screen),
resolves any file a runner would execute, and inspects that file's contents.

THIS IS A TRIPWIRE, NOT A SANDBOX. It cannot catch: obfuscation (base64 /
eval / string building), content fetched or generated at run time, content
changed between this read and execution (TOCTOU), indirect execution via a
package script or Makefile, or an interpreter not on the short list below.

FAILS OPEN BY DESIGN. Any internal error, timeout, or unparseable input
ALLOWS and records a `fail-open` audit line. A hook that blocked on its own
failure would wedge every worker on every Bash call — a worse and far likelier
outcome than the narrow payload this catches. Fail-opens are counted, and
crossing the hourly threshold emits its own audit line so "fails open" can
never quietly become "always open".

BLOCKS ONLY ON POSITIVE EVIDENCE: a destructive pattern in the command text
or in a resolved file's contents, or a file that exists but cannot be read.
When no file target can be identified at all, it APPROVES — that is
deliberate, and is what keeps the false-block rate at zero.

MODE: audit-only unless --mode-file names a file whose contents start with
"enforce". Audit-only still decides, prints and audits; it just always exits
0. Read at RUN time, not install time, because Claude snapshots hooks at
session start — a switch in settings.json could not be flipped without
relaunching every agent.
"""
import json
import os
import re
import sys
import time

MAX_FILE_READ_BYTES = 256 * 1024
SELF_TIMEOUT_SECONDS = 4
FAIL_OPEN_HOURLY_THRESHOLD = 10

# ---------------------------------------------------------------- dangerous roots

_USER_HOME_RE = re.compile(r"^/home/[^/]+/?\*?$")
_TILDE_USER_RE = re.compile(r"^~[A-Za-z_][A-Za-z0-9_-]*/?\*?$")
_HOME_VAR_RE = re.compile(r"^\$\{?HOME\}?(/.*)?$")

# Paths that must never be the target of a recursive delete / chmod / chown.
# `$HOME/<anything>` counts: ~/.claude and ~/.codex are exactly what was lost.
def is_dangerous_root(token):
    t = strip_delimiters(token)
    if not t:
        return False
    if t in ("~", "/", "*", "~/", "/*", "~/*"):
        return True
    if _HOME_VAR_RE.match(t):          # $HOME, ${HOME}, $HOME/.claude, ...
        return True
    if t.startswith("~/"):             # ~/.claude, ~/.ssh, ~/anything
        return True
    if _USER_HOME_RE.match(t):         # /home/brooswit, /home/brooswit/*
        return True
    if _TILDE_USER_RE.match(t):        # ~brooswit
        return True
    return False


def strip_delimiters(tok):
    """Shell/source syntax clinging to a token: quotes, brackets, a trailing `;`.

    The real incident shape is `rm` inside source code — a bun `$` template
    (await $`x; rm -rf ~`), a quoted exec string (exec("rm -rf $HOME")), or a
    trailing paren. Each leaves a delimiter stuck to the token, and an exact
    match against `~` then silently misses it.
    """
    return tok.strip("`'\"({[)}];,\n\t ")


SEGMENT_SPLIT_RE = re.compile(r";|\n|&&|\|\|")


def shell_segments(text):
    return SEGMENT_SPLIT_RE.split(text)


def normalize(text):
    return text.replace("\r\n", "\n")


# ---------------------------------------------------------------- destructive patterns

def _flagged_command(content, verb_re, want_flags, long_flags):
    """A `verb` segment carrying every wanted flag AND a dangerous-root target."""
    for raw in shell_segments(content):
        segment = raw.strip()
        if not verb_re.search(segment):
            continue
        after = verb_re.sub("", segment, count=1)
        have, targets = set(), []
        for tok in after.split():
            if tok.startswith("--"):
                if tok in long_flags:
                    have.add(want_flags[long_flags.index(tok)])
            elif tok.startswith("-") and len(tok) > 1:
                for f in want_flags:
                    if f in tok:
                        have.add(f)
            elif tok:
                targets.append(tok)
        if all(f in have for f in want_flags) and any(is_dangerous_root(t) for t in targets):
            return segment
    return None


def _find_delete(content):
    """`find ~ ... -delete` / `-exec rm`: a recursive delete that never says `rm -rf`."""
    for raw in shell_segments(content):
        seg = raw.strip()
        m = re.search(r"\bfind\b\s+(\S+)", seg)
        if not m or not is_dangerous_root(m.group(1)):
            continue
        if re.search(r"-delete\b", seg) or re.search(r"-exec\s+rm\b", seg):
            return seg
    return None


# A quoted argument to one of these is DATA (a pattern/string), never a
# command being run — unlike `eval "dd ..."` or `ssh host "dd ..."`, where
# the quoted text genuinely is executed. Scoping the allowance to exactly
# these verbs (rather than "inside any quotes") is deliberate: an unbalanced
# quote earlier in the line (`it's dd if=... of=/dev/sda`) must never swallow
# a real invocation into a false "this is quoted data" span, and `eval`/`ssh`
# must still block — only a *fully-closed* quote right after one of these
# verbs counts as data.
_DATA_ARG_RE = re.compile(
    r"\b(?:grep|egrep|fgrep|rg|echo)\b[^'\"\n;]*(['\"])((?:\\.|(?!\1).)*)\1",
    re.I,
)


def _data_argument_spans(text):
    return [(m.start(2), m.end(2)) for m in _DATA_ARG_RE.finditer(text)]


def _inside_data_argument(pos, spans):
    return any(start <= pos < end for start, end in spans)


def _dd_target(content):
    """`dd ... of=<dangerous-path>`, wherever `dd` is actually being run.

    A plain substring search (not anchored to a verb, a segment start, or
    any particular wrapper) so `sudo -n dd ...`, `nice dd ...`, `env X=1 dd
    ...`, `/bin/dd ...`, `xargs dd ...`, `ls | dd of=...`, `(dd ...)`,
    `if true; then dd ...; fi`, `eval "dd ..."` and `ssh host "dd ..."` all
    still match exactly as before. The ONLY thing excluded is a match that
    falls inside a quoted argument to grep/rg/echo — pattern-string DATA,
    never a `dd` invocation.
    """
    spans = _data_argument_spans(content)
    for m in re.finditer(r"\bdd\b[^;\n]*\bof=(['\"]?)([^\s;'\"]+)\1", content, re.I):
        if _inside_data_argument(m.start(), spans):
            continue
        target = strip_delimiters(m.group(2))
        if re.match(r"^/dev/(sd|nvme|hd)", target) or re.match(r"^/(etc|boot)(/|$)", target):
            return m.group(0)
    return None


def _mkfs_command(content):
    """Same substring search as `_dd_target`, same data-argument exclusion."""
    spans = _data_argument_spans(content)
    for m in re.finditer(r"\bmkfs(\.\w+)?\b[^;\n]*", content, re.I):
        if _inside_data_argument(m.start(), spans):
            continue
        return m.group(0)
    return None


SENSITIVE_REDIRECT_RE = re.compile(
    r"(>>?|\btee\b)\s*(-a\s+)?(['\"]?)"
    r"((?:~|\$\{?HOME\}?)/\.(?:ssh|claude|codex|config)\S*|/etc/\S+|/boot/\S+|/dev/(?:sd|nvme)\S*)",
    re.I,
)

# Appends (never an overwrite) to an agent's own memory file: allowed.
MEMORY_MD_ALLOW_RE = re.compile(r"^(?:~|\$\{?HOME\}?)/\.claude/projects/[^/]+/memory/[^/]+\.md$", re.I)
# Appends (never an overwrite) to the managed-sessions env file: allowed.
MANAGED_SESSIONS_ALLOW_RE = re.compile(r"^(?:~|\$\{?HOME\}?)/\.config/butchr-new/managed-sessions\.env$", re.I)
# A script allowed to append to one specific sensitive path, by its own basename —
# never a general allowance for that path from any other command.
SCRIPT_REDIRECT_ALLOWLIST = {
    "add-rocketr-account.sh": re.compile(r"^(?:~|\$\{?HOME\}?)/\.config/rocketchat/secrets\.env$", re.I),
}


def _sensitive_redirect(content, script_allow_re=None):
    for m in SENSITIVE_REDIRECT_RE.finditer(content):
        operator, append_flag, _quote, target_raw = m.group(1), m.group(2), m.group(3), m.group(4)
        target = strip_delimiters(target_raw)
        is_append = operator == ">>" or (operator.lower() == "tee" and bool(append_flag))
        if MEMORY_MD_ALLOW_RE.match(target) and is_append:
            continue
        if MANAGED_SESSIONS_ALLOW_RE.match(target) and is_append:
            continue
        if script_allow_re and script_allow_re.match(target) and is_append:
            continue
        return m.group(0)
    return None


DESTRUCTIVE_CHECKS = (
    ("rm -rf against $HOME/root/wildcard",
     lambda c, _a: _flagged_command(c, re.compile(r"\brm\b"), ["r", "f"], ["--recursive", "--force"])),
    ("find on $HOME or / with -delete/-exec rm", lambda c, _a: _find_delete(c)),
    ("chmod -R on $HOME or /",
     lambda c, _a: _flagged_command(c, re.compile(r"\bchmod\b"), ["R"], ["--recursive"])),
    ("chown -R on $HOME or /",
     lambda c, _a: _flagged_command(c, re.compile(r"\bchown\b"), ["R"], ["--recursive"])),
    ("dd targeting a device/system path", lambda c, _a: _dd_target(c)),
    ("mkfs", lambda c, _a: _mkfs_command(c)),
    ("redirect/tee onto a sensitive path", _sensitive_redirect),
    ("curl/wget piped into a shell",
     lambda c, _a: (m.group(0) if (m := re.search(
         r"\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b", c, re.I)) else None)),
    ("fork bomb", lambda c, _a: ":(){ ... }" if re.search(r":\s*\(\s*\)\s*\{", c) else None),
)


def match_destructive(content, context_path=None):
    """First destructive pattern in `content`, as (name, excerpt), or None.

    `context_path` is the resolved file this content came from, if any — it is
    what lets a narrowly-scoped allowance (see `SCRIPT_REDIRECT_ALLOWLIST`)
    key off the script's own basename rather than the command text.
    """
    text = normalize(content)
    script_allow_re = SCRIPT_REDIRECT_ALLOWLIST.get(os.path.basename(context_path)) if context_path else None
    for name, check in DESTRUCTIVE_CHECKS:
        hit = check(text, script_allow_re)
        if hit:
            return name, str(hit)[:200]
    return None


# ---------------------------------------------------------------- inline bodies

HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\b")
DASH_C_RE = re.compile(r"\b(?:sh|bash|zsh)\s+-c\s+(['\"])([\s\S]*?)\1")
NODE_EVAL_RE = re.compile(r"\bnode\s+(?:-e|-p|--eval|--print)\s+(['\"])([\s\S]*?)\1")
PY_C_RE = re.compile(r"\bpython3?\s+-c\s+(['\"])([\s\S]*?)\1")


def inline_bodies(command):
    """Script bodies carried in the command itself — no file to read.

    These are inspected DELIBERATELY. In an earlier screen-based draft
    `node -e '<payload>'` was blocked only by accident, because `-e` failed to
    stat as a filename; fixing the filename handling without this would have
    turned that accident into an approval.
    """
    bodies = [m.group(3) for m in HEREDOC_RE.finditer(command)]
    for rx in (DASH_C_RE, NODE_EVAL_RE, PY_C_RE):
        bodies.extend(m.group(2) for m in rx.finditer(command))
    return bodies


# ---------------------------------------------------------------- runner targets

# Never a filename: stdin, and the flags whose operand is inline code.
NON_FILE_TOKENS = {"-", "-c", "-e", "-s", "-p", "--eval", "--print", "-m", "-l", "-i"}

INLINE_CODE_FLAGS = {"-c", "-e", "-p", "--eval", "--print"}


def looks_like_path(tok):
    """Permissive positive filter — a cheap shape test, not a path grammar."""
    if not tok or tok in NON_FILE_TOKENS or tok.startswith("-"):
        return False
    return "/" in tok or "." in tok or tok.startswith("~")


def _first_path_operand(tokens):
    """First path-shaped operand, skipping flags and anything after inline-code flags."""
    skip_next = False
    for tok in tokens:
        if skip_next:
            skip_next = False
            continue
        if tok in INLINE_CODE_FLAGS:
            return None          # the operand is code, handled by inline_bodies
        if tok.startswith("-"):
            if tok in ("-m", "--module"):
                skip_next = True
            continue
        if looks_like_path(tok):
            return strip_delimiters(tok)
    return None


# `sh file` / `bash file` — anchored at a word start so `a.sh` and
# `cp a.sh b.sh` never match the interpreter itself. Everything after the
# interpreter is handed to `_first_path_operand`, not just the next token, so
# `bash -l deploy.sh` still inspects deploy.sh instead of giving up at `-l`.
SH_RUNNER_RE = re.compile(r"(?:^|[\s;|&])(?:sh|bash|zsh|dash)\s+(?!-c\b)(.*)$")
RUNNERS = (
    re.compile(r"(?:^|[\s;|&])(?:bun)\s+(?:test|run|x)?\s*(.*)$"),
    re.compile(r"(?:^|[\s;|&])(?:node|deno\s+run|tsx|ts-node)\s+(.*)$"),
    re.compile(r"(?:^|[\s;|&])(?:python3?)\s+(.*)$"),
    re.compile(r"(?:^|[\s;|&])(?:source|\.)\s+(\S+)$"),
)


def runner_targets(command):
    """Every file a recognised runner would execute, per shell segment.

    Returns a list of path strings. A runner with no identifiable file
    (`bun test` with no argument, `node --version`, `python3 -m pytest`) yields
    NOTHING — it is approved, not treated as dangerous. That is the correction
    that matters: treating unresolvable targets as suspicious withheld 787 of
    4,507 real benign commands in the measured review of the previous design.
    """
    out = []
    for raw in shell_segments(command):
        seg = raw.strip()
        if not seg:
            continue
        m = SH_RUNNER_RE.search(seg)
        if m:
            tok = _first_path_operand(m.group(1).split())
            if tok:
                out.append(tok)
        for rx in RUNNERS:
            m = rx.search(seg)
            if not m:
                continue
            rest = m.group(1) or ""
            tok = _first_path_operand(rest.split())
            if tok:
                out.append(tok)
            break
        m = re.search(r"(?:^|\s)(\./\S+)", seg)
        if m:
            out.append(strip_delimiters(m.group(1)))
    return out


CD_RE = re.compile(r"(?:^|[\s;&])cd\s+(\S+)")


def resolve_candidates(command, cwd):
    """Each runner target resolved against the `cd` target in the same command, then cwd."""
    bases = [cwd]
    m = CD_RE.search(command)
    if m:
        cd_target = os.path.expanduser(strip_delimiters(m.group(1)))
        bases.insert(0, cd_target if os.path.isabs(cd_target) else os.path.join(cwd, cd_target))
    resolved = []
    for target in runner_targets(command):
        expanded = os.path.expanduser(target)
        if os.path.isabs(expanded):
            resolved.append(expanded)
            continue
        for base in bases:
            candidate = os.path.normpath(os.path.join(base, expanded))
            if os.path.exists(candidate):
                resolved.append(candidate)
                break
        else:
            resolved.append(os.path.normpath(os.path.join(bases[0], expanded)))
    return resolved


# ---------------------------------------------------------------- the decision

class Verdict:
    def __init__(self, block, reason="", pattern=None, path=None):
        self.block = block
        self.reason = reason
        self.pattern = pattern
        self.path = path


def decide(command, cwd):
    """Allow or block. Positive evidence only; anything unidentifiable allows."""
    for body in inline_bodies(command):
        hit = match_destructive(body)
        if hit:
            return Verdict(True, "an inline script body matches %s: %r" % hit, hit[0])

    hit = match_destructive(command)
    if hit:
        return Verdict(True, "the command itself matches %s: %r" % hit, hit[0])

    for path in resolve_candidates(command, cwd):
        if not os.path.exists(path):
            continue                      # not a file we can judge — allow
        if not os.path.isfile(path):
            continue
        try:
            if os.path.getsize(path) > MAX_FILE_READ_BYTES:
                continue                  # too large to judge cheaply — allow
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read(MAX_FILE_READ_BYTES)
        except OSError as e:
            # Exists but unreadable is the ONE "could not verify" case that
            # blocks, per the ticket: something is being executed and we are
            # structurally unable to look at it.
            return Verdict(True, "file exists but cannot be read: %s (%s)" % (path, e), "unreadable-file", path)
        hit = match_destructive(content, context_path=path)
        if hit:
            return Verdict(True, "%s matches %s: %r" % (path, hit[0], hit[1]), hit[0], path)
    return Verdict(False)


# ---------------------------------------------------------------- plumbing

def read_input(raw):
    """(command, cwd_or_None, healthy). Hook JSON or a bare command line."""
    stripped = raw.strip()
    if stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
        except ValueError:
            return stripped, None, False
        tool_input = payload.get("tool_input") or {}
        command = tool_input.get("command")
        # Self-check: the contract is hook_event_name/tool_name/tool_input.command
        # (verified against Claude Code 2.1.287). A missing field must never be
        # read as "nothing to inspect" — that would leave the guard silently
        # inert while looking installed.
        healthy = bool(command) and payload.get("hook_event_name") == "PreToolUse"
        return command or "", payload.get("cwd"), healthy
    return stripped, None, True


def audit(path, record):
    if not path:
        return
    try:
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except OSError:
        pass          # audit must never change the verdict


def count_fail_open(state_path, audit_path):
    """Rolling-hour fail-open counter; emits its own audit line past the threshold."""
    if not state_path:
        return
    now = time.time()
    try:
        recent = []
        if os.path.exists(state_path):
            with open(state_path, "r", encoding="utf-8") as fh:
                recent = [t for t in json.load(fh) if now - t < 3600]
        recent.append(now)
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(recent, fh)
        if len(recent) > FAIL_OPEN_HOURLY_THRESHOLD:
            audit(audit_path, {"ts": now, "outcome": "fail-open-threshold-exceeded",
                               "count_last_hour": len(recent),
                               "threshold": FAIL_OPEN_HOURLY_THRESHOLD})
    except (OSError, ValueError):
        pass


def enforcing(mode_file):
    """True only when the flag file exists and says `enforce`. Default: audit-only."""
    if not mode_file:
        return False
    try:
        with open(mode_file, "r", encoding="utf-8") as fh:
            return fh.read().strip().lower().startswith("enforce")
    except OSError:
        return False


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else default


def main():
    mode_file = arg("--mode-file")
    audit_path = arg("--audit")
    state_path = arg("--fail-open-state")
    cwd_arg = arg("--cwd")
    show = "--print" in sys.argv

    try:
        if hasattr(__import__("signal"), "SIGALRM"):
            import signal

            def _bail(_signum, _frame):
                raise TimeoutError("self-timeout")

            signal.signal(signal.SIGALRM, _bail)
            signal.alarm(SELF_TIMEOUT_SECONDS)
    except (OSError, ValueError, AttributeError):
        pass

    try:
        raw = sys.stdin.read()
        command, hook_cwd, healthy = read_input(raw)
        cwd = cwd_arg or hook_cwd or os.getcwd()
        if not healthy:
            raise ValueError("hook stdin did not carry the expected PreToolUse fields")
        if not command.strip():
            print("allow: empty command", file=sys.stderr) if show else None
            return 0
        verdict = decide(command, cwd)
    except BaseException as e:                      # noqa: BLE001 — fail open on ANYTHING
        sys.stderr.write("butchr veto FAILED OPEN (allowing): %s: %s\n" % (type(e).__name__, e))
        audit(audit_path, {"ts": time.time(), "outcome": "fail-open", "error": "%s: %s" % (type(e).__name__, e)})
        count_fail_open(state_path, audit_path)
        return 0

    if not verdict.block:
        if show:
            print("allow", file=sys.stderr)
        return 0

    mode = "enforce" if enforcing(mode_file) else "audit-only"
    sys.stderr.write("butchr veto: %s [%s]\n" % (verdict.reason, mode))
    audit(audit_path, {"ts": time.time(), "outcome": "blocked" if mode == "enforce" else "would-block",
                       "mode": mode, "pattern": verdict.pattern, "file": verdict.path,
                       "command": command[:500], "cwd": cwd})
    return 2 if mode == "enforce" else 0


if __name__ == "__main__":
    sys.exit(main())
