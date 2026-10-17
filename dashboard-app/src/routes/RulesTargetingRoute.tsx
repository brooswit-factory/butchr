/**
 * local/ui — the Rules page: it opens on the list of rules, "Add rule" adds one
 * that opens right there for editing, any rule can be edited inline, and
 * nothing is written until Review and save, which shows what every change
 * will do before saving them all. butchr's rules all apply independently,
 * so this is a plain list with no evaluation order.
 *
 * State: the page owns ONE draft (`view-model/rules-draft.ts`). While it's
 * clean the draft follows the poll; once anything is changed, polls never
 * overwrite it — a newer server version shows a banner instead, with the
 * choice to update (keeping the person's edits) or discard. Live staffing
 * status always comes from the latest poll, since it isn't part of the
 * draft.
 *
 * Writes go through the same `RulesApi` calls (and the same server-side
 * plan-then-confirm gates) as the original Rules page did; see
 * `view-model/rules-save.ts`.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert, AlertText, Button, Heading, Text } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import { rulesApi, type BuiltinBrief, type RuleDto, type RuleFormCatalogEntry, type RulesApi } from "../api/rules.js";
import { useRules } from "../hooks/use-rules.js";
import { RulePreviewDialog } from "../components/RulePreviewDialog.js";
import { AddRuleMenu } from "../components/rules-targeting/AddRuleMenu.js";
import { DiscardModal } from "../components/rules-targeting/DiscardModal.js";
import { ReviewSaveModal } from "../components/rules-targeting/ReviewSaveModal.js";
import { RuleCard, type RuleCardMode } from "../components/rules-targeting/RuleCard.js";
import { ruleAnchorId } from "../view-model/config-links.js";
import type { QueryTestResult } from "../components/rules-targeting/RuleEditor.js";
import { SaveBar } from "../components/rules-targeting/SaveBar.js";
import {
  buildCreateDraft,
  computeRuleChanges,
  initialDraftState,
  isValidRuleId,
  newDraftKey,
  rulesDraftReducer,
  summarizeDraft,
  type DraftSummary,
  type RuleChange,
  type RuleRowState,
  type RulesDraftAction,
  type RulesDraftState,
} from "../view-model/rules-draft.js";
import { canPreview } from "../view-model/rule-providers.js";
import { changeTitle, describeError, savedBriefs, type SaveOutcome } from "../view-model/rules-save.js";
import "../components/rules-targeting/RulesTargeting.css";

export interface RulesTargetingRouteProps {
  api?: RulesApi;
}

export interface RulesPageState {
  draft: RulesDraftState;
  /** A newer server snapshot that arrived while the draft had unsaved changes. */
  serverAhead: { rules: readonly RuleDto[]; etag: string } | null;
  /** What a save just wrote (created ids, briefs), applied when its follow-up reload arrives. */
  pendingSave: { created: Record<string, string>; briefs: Record<string, string> } | null;
}

export type RulesPageAction =
  | { type: "server"; rules: readonly RuleDto[]; etag: string }
  | { type: "draft"; action: RulesDraftAction }
  | { type: "accept-server" }
  | { type: "saved"; created: Record<string, string>; briefs: Record<string, string> };

export function rulesPageReducer(state: RulesPageState | null, action: RulesPageAction): RulesPageState | null {
  if (action.type === "server") {
    if (!state) return { draft: initialDraftState(action.rules, action.etag), serverAhead: null, pendingSave: null };
    if (action.etag === state.draft.baseEtag) return state.serverAhead ? { ...state, serverAhead: null } : state;
    // Our own save just landed, or nothing is being edited: move onto the new snapshot.
    if (state.pendingSave || !summarizeDraft(state.draft).dirty) {
      const pending = state.pendingSave;
      const draft = rulesDraftReducer(state.draft, { type: "rebase", rules: action.rules, etag: action.etag, created: pending?.created ?? {}, briefs: pending?.briefs ?? {} });
      return { draft, serverAhead: null, pendingSave: null };
    }
    return { ...state, serverAhead: { rules: action.rules, etag: action.etag } };
  }
  if (!state) return state;
  switch (action.type) {
    case "draft":
      return { ...state, draft: rulesDraftReducer(state.draft, action.action) };
    case "accept-server":
      if (!state.serverAhead) return state;
      return { ...state, draft: rulesDraftReducer(state.draft, { type: "rebase", rules: state.serverAhead.rules, etag: state.serverAhead.etag }), serverAhead: null };
    case "saved":
      return { ...state, pendingSave: { created: action.created, briefs: action.briefs } };
  }
}

/**
 * An unsaved draft outlives this page while the app stays open. Going to
 * another page (the nav, or Back/Forward) unmounts this route, and the draft
 * would otherwise go with it. Keyed by the rules API it was made against, so
 * each test, and each reload, starts clean. Kept only while there are unsaved
 * changes, with the cards that were open.
 *
 * The leave-page (beforeunload) warning lives here too, for as long as any
 * kept draft is unsaved, so a reload or closing the tab from another page
 * still warns; saving or discarding the draft removes it.
 */
const keptDrafts = new Map<RulesApi, { page: RulesPageState; modes: Record<string, RuleCardMode> }>();

function warnBeforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = "";
}

function keepDraft(api: RulesApi, kept: { page: RulesPageState; modes: Record<string, RuleCardMode> } | null): void {
  if (kept) keptDrafts.set(api, kept);
  else keptDrafts.delete(api);
  if (typeof window === "undefined") return;
  // Adding the same listener twice is a no-op, so this stays at one.
  if (keptDrafts.size > 0) window.addEventListener("beforeunload", warnBeforeUnload);
  else window.removeEventListener("beforeunload", warnBeforeUnload);
}

/** For tests: forget every kept draft, and with them the leave-page warning. */
export function forgetKeptRulesDrafts(): void {
  for (const api of [...keptDrafts.keys()]) keepDraft(api, null);
}

/** Why Review and save can't be pressed right now, or `null`. */
export function saveBlockedReason(summary: DraftSummary, opts: { canWrite: boolean; reloadPending: boolean }): string | null {
  if (!summary.dirty) return "Make a change to save.";
  if (!opts.canWrite) return "This butchr isn't accepting changes from the dashboard right now.";
  if (opts.reloadPending) return "Wait for butchr to reload the rules file.";
  if (summary.validity === "invalid") return "Fix the errors in the highlighted rules to save.";
  if (summary.validity === "incomplete") return "Complete the highlighted rules to save.";
  return null;
}

/** A dry-run id for testing a brand-new rule's query before it has a valid id of its own. */
const QUERY_TEST_ID = "butchr-query-test";

interface ReviewRequest {
  changes: RuleChange[];
  rows: RuleRowState[];
  baseEtag: string;
}

function ResultBanner({ outcome, onDismiss }: { outcome: SaveOutcome; onDismiss: () => void }) {
  const saved = outcome.steps.filter((s) => s.status === "saved");
  const failed = outcome.steps.find((s) => s.status === "failed");
  const createdIds = Object.values(outcome.created);
  if (outcome.allSaved) {
    return (
      <Alert status="success" isDismissable onDismiss={onDismiss} className="rt-banner" data-testid="rules-save-result">
        <AlertText>
          Saved {saved.length} change{saved.length === 1 ? "" : "s"}.
          {createdIds.length > 0 && ` ${createdIds.join(", ")} ${createdIds.length === 1 ? "was" : "were"} created off; turn ${createdIds.length === 1 ? "it" : "them"} on when you're ready.`}
        </AlertText>
      </Alert>
    );
  }
  return (
    <Alert status="warning" isDismissable onDismiss={onDismiss} className="rt-banner" data-testid="rules-save-result">
      <AlertText>
        Saved {saved.length} of {outcome.steps.length} changes. {failed ? `${changeTitle(failed.change)} failed: ${failed.error ?? "unknown error"}` : ""} Everything that wasn't saved is still in your draft.
      </AlertText>
    </Alert>
  );
}

export function RulesTargetingRoute({ api = rulesApi }: RulesTargetingRouteProps) {
  const poll = useRules(api);
  const [capabilitiesChecked, setCapabilitiesChecked] = useState(false);
  const [catalog, setCatalog] = useState<readonly RuleFormCatalogEntry[] | null>(null);
  const [page, dispatchPage] = useReducer(rulesPageReducer, null, () => keptDrafts.get(api)?.page ?? null);
  const [modes, setModes] = useState<Record<string, RuleCardMode>>(() => keptDrafts.get(api)?.modes ?? {});
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [discardKey, setDiscardKey] = useState<string | null>(null);
  const [discardAllOpen, setDiscardAllOpen] = useState(false);
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [result, setResult] = useState<SaveOutcome | null>(null);
  const [preview, setPreview] = useState<{ ruleId: string; provider: string } | null>(null);
  // local/ui: the #anchor an agent row's "config" link came in with, read once when the page opens.
  const [targetAnchor] = useState(() => (typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1))));
  const [builtinBriefs, setBuiltinBriefs] = useState<readonly BuiltinBrief[] | null>(null);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [ruleDetails, setRuleDetails] = useState<Record<string, Record<string, unknown>>>({});
  const detailRequests = useRef(new Map<string, Promise<string | null>>());

  // Same capability probe as the original Rules page: `realRulesApi` starts read-only until `GET /api/session` answers.
  useEffect(() => {
    let cancelled = false;
    void api.refreshCapabilities().finally(() => {
      if (!cancelled) setCapabilitiesChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api
      .getCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    if (!api.getBriefs) return;
    api
      .getBriefs()
      .then((b) => {
        if (!cancelled) setBuiltinBriefs(b);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const data = poll.kind === "loaded" || poll.kind === "stale" ? poll.data : null;
  useEffect(() => {
    if (data) dispatchPage({ type: "server", rules: data.rules, etag: data.sourceEtag });
  }, [data]);

  const summary = useMemo(() => (page ? summarizeDraft(page.draft) : null), [page]);
  const dirty = summary?.dirty ?? false;

  // Kept (with the leave-page warning) while unsaved; never cleared on unmount, so it survives going to another page.
  useEffect(() => {
    keepDraft(api, page && dirty ? { page, modes } : null);
  }, [api, page, modes, dirty]);

  const canWrite = capabilitiesChecked && api.capabilities.write;
  const reloadPending = data?.stale ?? false;
  const editDisabled = !canWrite || reloadPending;
  const liveById = new Map((data?.rules ?? []).map((r) => [r.id, r]));
  const baseById = new Map((page?.draft.base ?? []).map((r) => [r.id, r]));

  const draftDispatch = (action: RulesDraftAction) => dispatchPage({ type: "draft", action });

  /**
   * A saved rule's full definition, loaded once on demand: the brief goes
   * into the draft (the rules list only carries an excerpt), the other
   * fields feed the editor's read-only "not editable here yet" list.
   * Resolves to the brief, or `null` if it couldn't be loaded.
   */
  function ensureDetails(ruleId: string): Promise<string | null> {
    const known = page?.draft.briefs[ruleId];
    if (known !== undefined && ruleDetails[ruleId] !== undefined) return Promise.resolve(known);
    const inFlight = detailRequests.current.get(ruleId);
    if (inFlight) return inFlight;
    if (!api.getRuleDetails) {
      setDetailErrors((e) => ({ ...e, [ruleId]: "this butchr doesn't serve rule details" }));
      return Promise.resolve(null);
    }
    const request = api
      .getRuleDetails(ruleId)
      .then(({ brief, fields }) => {
        setRuleDetails((d) => ({ ...d, [ruleId]: fields }));
        draftDispatch({ type: "brief-loaded", id: ruleId, brief });
        return brief;
      })
      .catch((e: unknown) => {
        setDetailErrors((errs) => ({ ...errs, [ruleId]: describeError(e) }));
        return null;
      })
      .finally(() => detailRequests.current.delete(ruleId));
    detailRequests.current.set(ruleId, request);
    return request;
  }
  const setMode = (key: string, mode: RuleCardMode) => setModes((m) => ({ ...m, [key]: mode }));
  const modeOf = (row: RuleRowState): RuleCardMode => modes[row.draft.key] ?? (row.draft.isNew ? "editing" : allCollapsed ? "collapsed" : "viewing");

  // Load the full definition of any saved rule that's open for editing.
  const needDetails = (summary?.rows ?? [])
    .filter((r) => !r.draft.isNew && modes[r.draft.key] === "editing" && (r.draft.brief === null || ruleDetails[r.draft.id] === undefined) && detailErrors[r.draft.id] === undefined)
    .map((r) => r.draft.id);
  const needDetailsKey = needDetails.join("\n");
  useEffect(() => {
    for (const id of needDetails) void ensureDetails(id);
    // `needDetailsKey` captures `needDetails`; `ensureDetails` dedupes in-flight requests itself.
  }, [needDetailsKey]);

  function addRule(provider: RuleDto["resourceProvider"]) {
    if (!page) return;
    setJustAdded(newDraftKey(page.draft.nextDraftNo));
    setResult(null);
    draftDispatch({ type: "add", resourceProvider: provider });
  }

  async function duplicateRule(row: RuleRowState) {
    if (!page) return;
    // The copy needs the source's real brief, not a guess.
    if (!row.draft.isNew && row.draft.brief === null && (await ensureDetails(row.draft.id)) === null) return;
    const copyKey = newDraftKey(page.draft.nextDraftNo);
    setJustAdded(copyKey);
    draftDispatch({ type: "duplicate", key: row.draft.key });
    setMode(copyKey, "editing");
  }

  function requestDiscard(row: RuleRowState) {
    const hasContent = row.draft.isNew ? row.draft.id.trim() !== "" || row.draft.query.trim() !== "" : row.dirty;
    if (hasContent) {
      setDiscardKey(row.draft.key);
      return;
    }
    if (row.draft.isNew) draftDispatch({ type: "remove", key: row.draft.key });
    else setMode(row.draft.key, "viewing");
  }

  function confirmDiscard() {
    if (discardKey === null) return;
    draftDispatch({ type: "restore", key: discardKey });
    setMode(discardKey, "viewing");
    setDiscardKey(null);
  }

  function requestDelete(row: RuleRowState) {
    if (row.draft.isNew) requestDiscard(row);
    else draftDispatch({ type: "remove", key: row.draft.key });
  }

  async function testQuery(row: RuleRowState): Promise<QueryTestResult> {
    const { draft } = row;
    if (!draft.isNew) {
      const res = await api.previewRule(draft.id, undefined, draft.query);
      return { kind: "keys", total: res.total, keys: res.tickets.slice(0, 10).map((t) => t.key) };
    }
    const create = buildCreateDraft(draft);
    const outcome = await api.createRule(isValidRuleId(create.id) ? create : { ...create, id: QUERY_TEST_ID }, false);
    if (outcome.kind === "needs-confirm") return { kind: "count", total: outcome.plan.scope, unmeasurable: outcome.plan.scopeUnmeasurable === true };
    if (outcome.kind === "refused") return { kind: "error", message: outcome.error };
    return { kind: "error", message: "unexpected answer from the dry run" };
  }

  function openReview() {
    if (!page || !summary) return;
    setResult(null);
    setReview({ changes: computeRuleChanges(page.draft), rows: summary.rows.filter((r) => r.dirty), baseEtag: page.draft.baseEtag });
  }

  function onSaved(outcome: SaveOutcome) {
    setReview(null);
    setResult(outcome);
    if (outcome.steps.some((s) => s.status === "saved")) dispatchPage({ type: "saved", created: outcome.created, briefs: savedBriefs(outcome) });
    if (outcome.allSaved) setModes({});
    void api
      .listRules()
      .then((fresh) => dispatchPage({ type: "server", rules: fresh.rules, etag: fresh.sourceEtag }))
      .catch(() => undefined); // the next poll catches up
  }

  const discardRow = discardKey !== null ? summary?.rows.find((r) => r.draft.key === discardKey) : undefined;

  return (
    <section className="rt-page" aria-labelledby="rules-page-title">
      <header className="bt-page-header">
        <Heading id="rules-page-title" level={1} className="bt-page-header__title">
          Rules
        </Heading>
        <div className="bt-page-header__actions">
          {summary && summary.rows.length > 1 && (
            <Button
              size="small"
              variant="minimal"
              onPress={() => {
                setAllCollapsed((c) => !c);
                // Cards someone is editing stay open; everything else follows the toggle.
                setModes((m) => Object.fromEntries(Object.entries(m).filter(([, mode]) => mode === "editing")));
              }}
              data-testid="rules-collapse-all"
            >
              <Icon name={allCollapsed ? "chevrons-out" : "chevrons-in"} size="small" />
              {allCollapsed ? "Expand all" : "Collapse all"}
            </Button>
          )}
          {page && <AddRuleMenu disabled={editDisabled} onAdd={addRule} />}
        </div>
      </header>
      <Text elementType="p" className="bt-page-intro">
        Rules decide which tickets butchr staffs with agents. Change anything here, then review and save it all at once.
      </Text>

      {poll.kind === "error" && (
        <Alert status="error" className="rt-banner">
          <AlertText>Couldn't load the rules: {poll.error}</AlertText>
        </Alert>
      )}
      {poll.kind === "stale" && (
        <Alert status="warning" className="rt-banner">
          <AlertText>Couldn't refresh the rules ({poll.error}). Showing what butchr reported earlier.</AlertText>
        </Alert>
      )}
      {data && data.errors.length > 0 && (
        <Alert status="error" className="rt-banner" data-testid="rules-file-errors">
          <AlertText>
            {data.errors.map((e) => (
              <Text elementType="div" size="small" key={`${e.path}:${e.message}`}>
                {e.path}: {e.message}
              </Text>
            ))}
          </AlertText>
        </Alert>
      )}
      {reloadPending && (
        <Alert status="warning" className="rt-banner" data-testid="rules-reload-pending">
          <AlertText>The rules file changed on disk and butchr hasn't reloaded it yet. Editing is paused until it does.</AlertText>
        </Alert>
      )}
      {capabilitiesChecked && !api.capabilities.write && (
        <Alert status="info" className="rt-banner" data-testid="rules-read-only">
          <AlertText>Read-only: this butchr isn't accepting changes from the dashboard right now.</AlertText>
        </Alert>
      )}
      {page?.serverAhead && (
        <Alert status="warning" className="rt-banner" data-testid="rules-server-ahead">
          <AlertText>
            The rules changed on the server while you were editing.{" "}
            <Button size="small" onPress={() => dispatchPage({ type: "accept-server" })}>
              Update and keep my edits
            </Button>{" "}
            <Button size="small" variant="minimal" onPress={() => setDiscardAllOpen(true)}>
              Discard my edits
            </Button>
          </AlertText>
        </Alert>
      )}
      {result && <ResultBanner outcome={result} onDismiss={() => setResult(null)} />}

      {page && summary ? (
        <>
          {summary.rows.length === 0 ? (
            <div className="rt-empty" data-testid="rules-empty">
              <Text bold>No rules yet</Text>
              <Text size="small" className="rt-muted">
                A rule names a query; butchr staffs an agent on what it matches. Use Add rule to make the first one.
              </Text>
            </div>
          ) : (
            <ol className="rt-rules" aria-label="rules" data-testid="rules-list">
              {summary.rows.map((row) => (
                <li key={row.draft.key} className="rt-rules__item">
                  <RuleCard
                    row={row}
                    live={liveById.get(row.draft.id)}
                    baseRule={row.draft.isNew ? undefined : baseById.get(row.draft.id)}
                    mode={modeOf(row)}
                    catalog={catalog}
                    disabled={editDisabled}
                    onEdit={(changes) => draftDispatch({ type: "edit", key: row.draft.key, changes })}
                    onModeChange={(mode) => setMode(row.draft.key, mode)}
                    onDiscard={() => requestDiscard(row)}
                    onDuplicate={() => void duplicateRule(row)}
                    onDelete={() => requestDelete(row)}
                    onRestore={() => draftDispatch({ type: "restore", key: row.draft.key })}
                    onPreview={() => setPreview({ ruleId: row.draft.id, provider: row.draft.resourceProvider })}
                    onTestQuery={row.draft.isNew || canPreview(row.draft.resourceProvider) ? () => testQuery(row) : undefined}
                    isJustAdded={justAdded === row.draft.key}
                    isTarget={targetAnchor !== "" && !row.draft.isNew && targetAnchor === ruleAnchorId(row.draft.resourceProvider, row.draft.id)}
                    builtinBriefs={builtinBriefs}
                    briefError={detailErrors[row.draft.id]}
                    details={ruleDetails[row.draft.id]}
                  />
                </li>
              ))}
            </ol>
          )}
          <SaveBar
            summary={summary}
            blockedReason={saveBlockedReason(summary, { canWrite, reloadPending })}
            busy={review !== null}
            onUndo={() => setDiscardAllOpen(true)}
            onReview={openReview}
          />
        </>
      ) : (
        poll.kind === "loading" && (
          <Text elementType="p" className="rt-muted">
            Loading rules…
          </Text>
        )
      )}

      {discardRow && (
        <DiscardModal
          title={discardRow.draft.isNew ? "Remove this new rule?" : `Discard changes to ${discardRow.draft.id}?`}
          rows={[discardRow]}
          confirmLabel={discardRow.draft.isNew ? "Remove rule" : "Discard changes"}
          onConfirm={confirmDiscard}
          onCancel={() => setDiscardKey(null)}
        />
      )}
      {discardAllOpen && summary && (
        <DiscardModal
          title="Discard all unsaved changes?"
          rows={summary.rows.filter((r) => r.dirty)}
          confirmLabel="Discard all"
          onConfirm={() => {
            draftDispatch({ type: "discard-all" });
            if (page?.serverAhead) dispatchPage({ type: "accept-server" });
            setModes({});
            setDiscardAllOpen(false);
          }}
          onCancel={() => setDiscardAllOpen(false)}
        />
      )}
      {review && (
        <ReviewSaveModal api={api} changes={review.changes} rows={review.rows} baseEtag={review.baseEtag} onSaved={onSaved} onClose={() => setReview(null)} />
      )}
      {preview && <RulePreviewDialog ruleId={preview.ruleId} resourceProvider={preview.provider} api={api} onClose={() => setPreview(null)} />}
    </section>
  );
}

