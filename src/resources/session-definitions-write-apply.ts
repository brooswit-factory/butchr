/**
 * FACTORY-667 — builds the next session-definition document text for a
 * web-UI field edit. Unlike `../rules/rules-write-apply.ts` (one rule among
 * many in a shared array, targeted by id), a session-definition file is
 * its OWN document — no array index to resolve, no "did someone else's
 * element shift" concern. Full `JSON.parse`/rebuild/`JSON.stringify`
 * round-trip, same discipline as the rules write path, for the same
 * reason: `assertOnlyChanged` (`./write-json-file.ts`) diffs PARSED values,
 * never text, so a reformatted-but-identical document reports zero diffs.
 */
export class SessionDefinitionWriteApplyError extends Error {}

/**
 * The ONLY fields a web-UI write may ever touch. `modelPower`/`effort` are
 * low-risk (plain write contract); `permissionMode`/`lizardMode` are
 * risky-capable (confirm-gated server-side — see
 * `./session-definitions-write.ts`'s own `RISKY_SESSION_PERMISSION_MODES`).
 * Everything else a definition can name — `workingDirectory`, `brief`,
 * `vendor`, `tier`, `execution`, `account`, `role`, `frozen` (its own
 * dedicated freeze/unfreeze operation, never this generic patch route),
 * `mcpServers`, `freezeControllers`, `unfreezeControllers`,
 * `linkedEventingProjects` — is deliberately absent: the ticket's own v1
 * scope refuses every field that names a command/path/URL executed or
 * loaded at agent launch, server-side, not merely hidden in the UI.
 */
export const EDITABLE_SESSION_DEFINITION_FIELDS = ["modelPower", "effort", "permissionMode", "lizardMode"] as const;
export type EditableSessionDefinitionField = (typeof EDITABLE_SESSION_DEFINITION_FIELDS)[number];
const EDITABLE_FIELD_SET: ReadonlySet<string> = new Set(EDITABLE_SESSION_DEFINITION_FIELDS);

export interface SessionDefinitionFieldPatch {
  modelPower?: number;
  effort?: number;
  permissionMode?: string;
  lizardMode?: boolean;
}

/** Every key in `patch` (a raw, untrusted request body) that is not in the server-side allowlist — `[]` means the patch is fully allowlisted. Checked BEFORE any field is even looked at individually, so an operator-actionable message always names every offending field, not just the first. */
export function disallowedPatchFields(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => !EDITABLE_FIELD_SET.has(k));
}

function parseDoc(currentText: string | undefined, path: string): Record<string, unknown> {
  if (currentText === undefined) throw new SessionDefinitionWriteApplyError(`${path}: no such session definition`);
  let doc: unknown;
  try {
    doc = JSON.parse(currentText);
  } catch (e) {
    throw new SessionDefinitionWriteApplyError(`${path}: invalid JSON: ${(e as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new SessionDefinitionWriteApplyError(`${path} must be a JSON object`);
  return doc as Record<string, unknown>;
}

/** The current document's own raw fields (never the parsed/defaulted `SessionDefinition`) — for building a confirm-gate preview's "old value" without materializing any field's default. Throws `SessionDefinitionWriteApplyError` if `path` has no file or isn't a JSON object. */
export function readSessionDefinitionDoc(currentText: string | undefined, path: string): Record<string, unknown> {
  return parseDoc(currentText, path);
}

/** Rewrites ONLY the patched fields, preserving every other field by a plain value copy — never the normalized/defaulted `SessionDefinition` (which would expand `~` in `workingDirectory` and materialize every optional field's default). */
export function applySessionDefinitionFieldPatch(currentText: string | undefined, path: string, patch: SessionDefinitionFieldPatch): string {
  const doc = parseDoc(currentText, path);
  const next: Record<string, unknown> = { ...doc };
  if (patch.modelPower !== undefined) next.modelPower = patch.modelPower;
  if (patch.effort !== undefined) next.effort = patch.effort;
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
  if (patch.lizardMode !== undefined) next.lizardMode = patch.lizardMode;
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** The allowlist paths (`assertOnlyChanged`, `./write-json-file.ts`) for whichever of `EDITABLE_SESSION_DEFINITION_FIELDS` is actually present in `patch` — an absent field in the patch never earns an allowed path for itself, so a patch that only touches `modelPower` can never be used to smuggle a change elsewhere even if the allowlist constant above later grows. */
export function buildSessionDefinitionFieldsAllowedPaths(patch: SessionDefinitionFieldPatch): string[] {
  const patchRecord = patch as unknown as Record<string, unknown>;
  return EDITABLE_SESSION_DEFINITION_FIELDS.filter((f) => patchRecord[f] !== undefined);
}
