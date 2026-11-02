import { createHash } from 'node:crypto';
import { readNativeTranscript, type NativeTranscriptOptions } from '@brooswit/drovr';
import { issueReplacementWorkerPermit, nativeSessionHash, type CanaryRenewalSnapshot, type CanaryReplacementRequest } from './worker-rollout.js';

export const REPLACEMENT_HISTORY_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxChars: 64 * 1024 * 1024 });
export interface ReplacementHistoryFit { observedAt: number; bytes: number; chars: number; sha256: string; maxBytes: number; maxChars: number; }
export interface ReplacementHistoryIO {
    getAgent: (pane: string) => Promise<{ pane_id: string; cwd: string; agent: string; agent_status: string; interactive_ready?: boolean; agent_session?: { agent?: string; kind?: string | null; value?: unknown } | null }>;
    readTranscript?: (options: NativeTranscriptOptions) => Promise<string>;
}
/** Operator-only assembly. Construction performs no I/O and grants no budget.
 * Both independent physical/policy checks and complete-history checks run BEFORE
 * the new-budget transaction, and again inside its exclusion lock. No transcript
 * is returned, persisted or logged; only bounded nonsecret fit metadata is exposed.
 */
export function prepareReplacementWorkerOperator(request: CanaryReplacementRequest, io: ReplacementHistoryIO, now = () => Date.now()) {
    const captured = { ...request, next: structuredClone(request.next), ...(request.preservedPartialTarget ? {preservedPartialTarget:{...request.preservedPartialTarget,identity:structuredClone(request.preservedPartialTarget.identity),ancestorReceipts:structuredClone(request.preservedPartialTarget.ancestorReceipts)}} : {}) };
    const source = structuredClone(request.next.source), getAgent = io.getAgent, reader = io.readTranscript ?? readNativeTranscript;
    let fit: ReplacementHistoryFit | undefined;
    const exactAgent = async () => {
        const a = await getAgent(source.paneId);
        if (!a || a.pane_id !== source.paneId || a.cwd !== source.cwd || a.agent !== source.provider || !['idle', 'done'].includes(a.agent_status) || a.interactive_ready !== true || nativeSessionHash(a.agent_session) !== source.sessionHash || a.agent_session?.agent !== source.provider || !['id', 'path'].includes(a.agent_session?.kind ?? '') || typeof a.agent_session?.value !== 'string') throw Error('Complete-history preflight source identity/status is uncertain');
        return { kind: a.agent_session.kind as 'id' | 'path', value: a.agent_session.value };
    };
    const requireProof = (snapshot: CanaryRenewalSnapshot) => {
        if (!snapshot || !Number.isFinite(now()) || !Number.isFinite(snapshot.checkedAt) || snapshot.checkedAt > now() || now() - snapshot.checkedAt > 5000 || snapshot.enabled !== true || snapshot.notHeld !== true || snapshot.desiredToken !== captured.next.desiredToken || snapshot.targetProvider !== captured.next.targetProvider || JSON.stringify(snapshot.authority) !== JSON.stringify(captured.next.authority) || JSON.stringify(snapshot.source) !== JSON.stringify(source)) throw Error('Independent history preflight proof is stale, held or mismatched');
    };
    const inspect = async (): Promise<CanaryRenewalSnapshot> => {
        fit = undefined;
        await captured.assertStopped();
        requireProof(await captured.inspect());
        if (!['claude', 'codex', 'agy'].includes(source.provider)) throw Error('Unsupported source provider');
        const session = await exactAgent();
        const readFit = async () => {
            const text = await reader({ provider: source.provider as NativeTranscriptOptions['provider'], cwd: source.cwd, session, maxBytes: REPLACEMENT_HISTORY_LIMITS.maxBytes });
            if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > REPLACEMENT_HISTORY_LIMITS.maxBytes || text.length > REPLACEMENT_HISTORY_LIMITS.maxChars || !text.trim() || text.trim() === "[]") throw Error('Complete history does not fit both finite recovery limits; refusing truncation');
            const observedAt = now();
            return { observedAt, bytes: Buffer.byteLength(text, 'utf8'), chars: text.length, sha256: createHash('sha256').update(text).digest('hex') };
        };
        const first = await readFit();
        const after = await exactAgent();
        if (JSON.stringify(after) !== JSON.stringify(session)) throw Error('Native history reference changed during preflight');
        await captured.assertStopped();
        const snapshot = structuredClone(await captured.inspect());
        requireProof(snapshot);
        // Slow independent inspection may age the first observation. Actually reread
        // the SAME pinned source; never refresh the timestamp of the earlier bytes.
        const beforeReread = await exactAgent();
        if (JSON.stringify(beforeReread) !== JSON.stringify(session)) throw Error('Native history reference changed before reread');
        const final = await readFit();
        const afterReread = await exactAgent();
        if (JSON.stringify(afterReread) !== JSON.stringify(session)) throw Error('Native history reference changed during reread');
        if (first.bytes !== final.bytes || first.chars !== final.chars || first.sha256 !== final.sha256) throw Error('Native history content changed during independent inspection');
        requireProof(snapshot); // A slow reread cannot restamp the independent proof either.
        if (!Number.isFinite(final.observedAt) || final.observedAt > now() || now() - final.observedAt > 5000) throw Error('Complete-history observation expired after reread');
        fit = { ...final, ...REPLACEMENT_HISTORY_LIMITS };
        return snapshot;
    };
    return {
        inspectOnly: inspect,
        historyFit: () => fit ? { ...fit } : undefined,
        issueOnlyWhenApproved: async () => { fit = undefined; try { return await issueReplacementWorkerPermit({ ...captured, inspect }, now); } catch (error) { fit = undefined; throw error; } },
    };
}
