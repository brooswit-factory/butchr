/**
 * FACTORY-64: pure, idempotent editing of WSL's `/etc/wsl.conf` — the file
 * that must carry `[boot] systemd=true` before a systemd user unit (this
 * story's `butchr.service`/`herdr.service`) can run inside the distro at
 * all, and optionally `[user] default=<name>` so the distro boots into the
 * account the units are meant to run as.
 *
 * Kept separate from `cli.ts` (which does the real file read/write, gated
 * on root) so the actual line-editing logic — the part that must never
 * duplicate a key or clobber an unrelated line on a second run — is
 * testable with plain strings, no filesystem or privilege needed. Mirrors
 * this repo's `scripts/deploy/rollback-decision.ts` split.
 */

export interface WslConfDesired {
  /** Set `[boot] systemd=true`. Always true for this story's purposes, but kept a field rather than a constant so a future caller (or a test) can ask for a no-op edit and see `changed: false`. */
  systemd: boolean;
  /** Optional `[user] default=<name>` — the login user the distro boots into. Omit to leave any existing `[user]` section untouched. */
  defaultUser?: string;
}

export interface WslConfEditResult {
  content: string;
  changed: boolean;
}

interface ParsedLine {
  raw: string;
  section: string | null; // the section this line belongs to, or null for content before any section header
  key: string | null; // lowercased key, for a `key=value` line; null otherwise
}

function parse(content: string): ParsedLine[] {
  let section: string | null = null;
  return content.split("\n").map((raw) => {
    const trimmed = raw.trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1]!.toLowerCase();
      return { raw, section, key: null };
    }
    const kv = /^([^#;=\s][^=]*?)\s*=/.exec(trimmed);
    return { raw, section, key: kv ? kv[1]!.toLowerCase() : null };
  });
}

/**
 * Ensure `section` contains `key=value` exactly once, with that value.
 * - An existing `key=` line in that section is rewritten in place (whatever
 *   its current value, so re-running never leaves a stale duplicate).
 * - A missing section is appended, with a blank-line separator if the file
 *   already has content.
 * - A section that exists but lacks the key gets the line appended at the
 *   end of that section's own block (before the next section header, or
 *   end of file).
 * Returns `changed: false` untouched (byte-identical) when the file
 * already reads this way — the idempotency property `cli.ts` relies on to
 * avoid rewriting (and so needlessly touching the mtime/perms of) a file
 * that's already correct.
 */
function upsertIniValue(content: string, section: string, key: string, value: string): WslConfEditResult {
  const wantSection = section.toLowerCase();
  const wantKey = key.toLowerCase();
  const lines = parse(content);

  const existingIdx = lines.findIndex((l) => l.section === wantSection && l.key === wantKey);
  if (existingIdx !== -1) {
    const wantLine = `${key}=${value}`;
    if (lines[existingIdx]!.raw === wantLine) return { content, changed: false };
    const out = lines.map((l) => l.raw);
    out[existingIdx] = wantLine;
    return { content: out.join("\n"), changed: true };
  }

  const sectionHeaderIdx = lines.findIndex((l) => l.section === wantSection && /^\s*\[[^\]]+\]\s*$/.test(l.raw));
  if (sectionHeaderIdx !== -1) {
    // Insert right after the last line still belonging to this section.
    let insertAt = sectionHeaderIdx + 1;
    while (insertAt < lines.length && lines[insertAt]!.section === wantSection) insertAt++;
    const out = lines.map((l) => l.raw);
    out.splice(insertAt, 0, `${key}=${value}`);
    return { content: out.join("\n"), changed: true };
  }

  // No such section at all — append one.
  const trimmedEnd = content.replace(/\n+$/, "");
  const sep = trimmedEnd.length === 0 ? "" : "\n\n";
  return { content: `${trimmedEnd}${sep}[${section}]\n${key}=${value}\n`, changed: true };
}

/** Apply every field of `desired` to `existing`, one idempotent upsert per field, in a fixed order so the result is deterministic regardless of call order. */
export function ensureWslConf(existing: string, desired: WslConfDesired): WslConfEditResult {
  let content = existing;
  let changed = false;

  if (desired.systemd) {
    const r = upsertIniValue(content, "boot", "systemd", "true");
    content = r.content;
    changed = changed || r.changed;
  }
  if (desired.defaultUser !== undefined) {
    const r = upsertIniValue(content, "user", "default", desired.defaultUser);
    content = r.content;
    changed = changed || r.changed;
  }

  return { content, changed };
}
