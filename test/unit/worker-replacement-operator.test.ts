import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerRollout, nativeSessionHash, type CanaryPermit, type CanaryReplacementRequest } from '../../src/control-panel/worker-rollout.js';
import { prepareReplacementWorkerOperator, REPLACEMENT_HISTORY_LIMITS, type ReplacementHistoryIO } from '../../src/control-panel/worker-replacement-operator.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture(payload = 'Synthetic previous work') {
    const directory = mkdtempSync(join(tmpdir(), 'replacement-operator-')); mkdirSync(join(directory, 'work'));
    const cwd = join(directory, 'work'), path = join(cwd, 'synthetic.jsonl'), text = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: payload }] } }) + '\n'; writeFileSync(path, text, { mode: 0o600 });
    const session = { agent: 'codex', kind: 'path', value: path }; let now = Date.now();
    const permit: CanaryPermit = { version: 1, permitId: '00000000-0000-4000-8000-000000000001', workerKey: 'jira-work:tasks:FIXTURE-1', authority: { serverId: '00000000-0000-4000-8000-000000000002', authorizationId: '00000000-0000-4000-8000-000000000003', deploymentId: '00000000-0000-4000-8000-000000000004' }, desiredToken: 'a'.repeat(64), targetProvider: 'claude', expiresAt: new Date(now - 1).toISOString(), source: { paneId: 'old', cwd, provider: 'codex', sessionHash: nativeSessionHash(session)! }, holdClearance: { notHeld: true, paneId: 'old', sessionHash: nativeSessionHash(session)!, expiresAt: new Date(now - 1).toISOString() } };
    const previousPath = join(directory, 'old.json'), nextPath = join(directory, 'new.json'); writeFileSync(previousPath, JSON.stringify(permit), { mode: 0o600 }); createWorkerRollout(previousPath, directory, () => now);
    const oldText = readFileSync(previousPath, 'utf8'), receipt = [{ at: new Date(now - 2).toISOString(), status: 'claimed', permitId: permit.permitId, workerKey: permit.workerKey, permitHash: hash(oldText) }, { at: new Date(now - 1).toISOString(), status: 'terminal', result: { status: 'blocked', reason: 'Synthetic bound failure', partial: false }, retired: false, target: null }].map(x => JSON.stringify(x)).join('\n') + '\n';
    const claim = join(directory, 'worker-canary-attempts', permit.permitId + '.jsonl'); writeFileSync(claim, receipt, { mode: 0o600 });
    const next = structuredClone(permit); next.permitId = '00000000-0000-4000-8000-000000000005'; next.expiresAt = new Date(now + 60_000).toISOString(); next.holdClearance.expiresAt = next.expiresAt;
    let inspections = 0, stops = 0, reads = 0;
    const request: CanaryReplacementRequest = { previousPath, nextPath, stateDirectory: directory, next, previousPermitSHA256: hash(oldText), previousReceiptSHA256: hash(receipt), approvalReference: 'synthetic-approved-new-budget', assertStopped: async () => { stops++; }, inspect: async () => { inspections++; return { checkedAt: now, enabled: true, notHeld: true, desiredToken: permit.desiredToken, targetProvider: permit.targetProvider, authority: structuredClone(permit.authority), source: structuredClone(permit.source) }; } };
    const agent = { pane_id: 'old', cwd, agent: 'codex', agent_status: 'idle', interactive_ready: true, agent_session: session };
    const io: ReplacementHistoryIO = { getAgent: async () => { reads++; return structuredClone(agent); } };
    return { directory, nextPath, request, io, agent, text, claim, receipt, now: () => now, advance: (ms:number) => now += ms, counts: () => ({ inspections, stops, reads }), close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('operator construction is inert; exact synthetic full history fits before any new budget', async () => {
    const f = fixture('界😀'.repeat(2 * 1024 * 1024));
    try {
        const operator = prepareReplacementWorkerOperator(f.request, f.io, f.now); expect(f.counts()).toEqual({ inspections: 0, stops: 0, reads: 0 }); expect(operator.historyFit()).toBeUndefined();
        const proof = await operator.inspectOnly(); expect(proof.enabled).toBe(true); expect(existsSync(f.nextPath)).toBe(false);
        expect(operator.historyFit()).toMatchObject({ bytes: Buffer.byteLength(f.text), chars: f.text.length, sha256: hash(f.text), ...REPLACEMENT_HISTORY_LIMITS });
        const result = await operator.issueOnlyWhenApproved(); expect(result.attemptBudget).toBe(1); expect(existsSync(f.nextPath)).toBe(true); expect(readFileSync(f.claim, 'utf8')).toBe(f.receipt);
    } finally { f.close(); }
});
for (const kind of ['oversized-bytes', 'oversized-chars', 'empty', 'empty-array', 'source', 'session', 'working', 'held', 'disabled', 'stale', 'stopped'] as const) test('operator does not issue a budget on failed preflight: ' + kind, async () => {
    const f = fixture();
    try {
        let transcriptReads = 0;
        if (kind === 'source') f.agent.pane_id = 'foreign'; if (kind === 'session') f.agent.agent_session.value = 'different'; if (kind === 'working') f.agent.agent_status = 'working';
        const inspect = f.request.inspect; f.request.inspect = async () => { const s = await inspect(); if (kind === 'held') s.notHeld = false; if (kind === 'disabled') s.enabled = false; if (kind === 'stale') s.checkedAt -= 5001; return s; };
        if (kind === 'stopped') f.request.assertStopped = async () => { throw Error('Unknown daemon state'); };
        f.io.readTranscript = async () => { transcriptReads++; if (kind === 'oversized-bytes') return '界'.repeat(23 * 1024 * 1024); if (kind === 'oversized-chars') return 'x'.repeat(64 * 1024 * 1024 + 1); if (kind === 'empty') return ' \n'; if (kind === 'empty-array') return '[]'; return f.text; };
        const operator = prepareReplacementWorkerOperator(f.request, f.io, f.now);
        await expect(operator.inspectOnly()).rejects.toThrow(); expect(operator.historyFit()).toBeUndefined();
        await expect(operator.issueOnlyWhenApproved()).rejects.toThrow(); expect(existsSync(f.nextPath)).toBe(false); expect(readFileSync(f.claim, 'utf8')).toBe(f.receipt);
        if (['held', 'disabled', 'stale', 'stopped', 'source', 'session', 'working'].includes(kind)) expect(transcriptReads).toBe(0);
    } finally { f.close(); }
});
test('late policy failure clears prior successful fit and retains old grant', async () => {
    const f = fixture();
    try {
        const operator = prepareReplacementWorkerOperator(f.request, f.io, f.now); await operator.inspectOnly(); expect(operator.historyFit()).toBeDefined();
        f.agent.agent_status = 'working'; await expect(operator.issueOnlyWhenApproved()).rejects.toThrow(); expect(operator.historyFit()).toBeUndefined(); expect(existsSync(f.nextPath)).toBe(false);
    } finally { f.close(); }
});
test('an earlier successful fit is not reported as evidence for a rejected new grant', async () => {
    const f = fixture();
    try {
        const operator = prepareReplacementWorkerOperator(f.request, f.io, f.now); await operator.inspectOnly(); expect(operator.historyFit()).toBeDefined();
        writeFileSync(f.claim, f.receipt + '\n'); await expect(operator.issueOnlyWhenApproved()).rejects.toThrow(); expect(operator.historyFit()).toBeUndefined(); expect(existsSync(f.nextPath)).toBe(false);
    } finally { f.close(); }
});
for (const delay of [1000, 6001]) test(`actual same-source reread renews observation after ${delay}ms checks without restamping`, async () => {
    const f = fixture();
    try {
        const inspect = f.request.inspect; let n = 0; const readTimes: number[] = [];
        f.request.inspect = async () => { if (++n % 2 === 0) f.advance(delay); return inspect(); };
        f.io.readTranscript = async () => { readTimes.push(f.now()); return f.text; };
        const operator = prepareReplacementWorkerOperator(f.request, f.io, f.now);
        await operator.inspectOnly(); expect(readTimes).toHaveLength(2); expect(readTimes[1]! - readTimes[0]!).toBe(delay);
        expect(operator.historyFit()!.observedAt).toBe(readTimes[1]!); expect(existsSync(f.nextPath)).toBe(false);
        const result = await operator.issueOnlyWhenApproved(); expect(result.attemptBudget).toBe(1); expect(readTimes).toHaveLength(6);
        expect(readFileSync(f.claim, 'utf8')).toBe(f.receipt);
    } finally { f.close(); }
});
test('post-inspection issuance uncertainty clears fit instead of reporting it as successful grant evidence', async () => {
    const f = fixture();
    try {
        const inspect = f.request.inspect; let n = 0;
        const archive = join(f.directory, 'worker-canary-replacements', JSON.parse(readFileSync(f.request.previousPath, 'utf8')).permitId + '-' + f.request.previousReceiptSHA256 + '.json');
        f.request.inspect = async () => { if (++n === 4) mkdirSync(archive + '.complete'); return inspect(); };
        const operator = prepareReplacementWorkerOperator(f.request, f.io, f.now);
        await expect(operator.issueOnlyWhenApproved()).rejects.toThrow(); expect(operator.historyFit()).toBeUndefined(); expect(existsSync(join(f.directory, 'worker-canary-control.lock'))).toBe(true); expect(readFileSync(f.claim, 'utf8')).toBe(f.receipt);
    } finally { f.close(); }
});

for (const kind of ['content', 'oversized', 'empty', 'reference', 'working', 'held', 'reader-error', 'stale-policy-after-read']) test('reread refuses drift or stale independent proof: ' + kind, async () => {
    const f = fixture();
    try {
        const inspect = f.request.inspect; let inspections = 0, reads = 0;
        f.request.inspect = async () => { const s = await inspect(); if (++inspections === 2) {
            if(kind === 'reference') f.agent.agent_session.value = 'different';
            if(kind === 'working') f.agent.agent_status = 'working';
            if(kind === 'held') s.notHeld = false;
        } return s; };
        f.io.readTranscript = async () => { if (++reads === 2) {
            if(kind === 'content') return f.text.replace('Synthetic', 'Different'); // equal lengths, different full hash
            if(kind === 'oversized') return 'x'.repeat(67108865);
            if(kind === 'empty') return '[]';
            if(kind === 'reader-error') throw Error('Synthetic reread failure');
            if(kind === 'stale-policy-after-read') f.advance(5001);
        } return f.text; };
        const operator = prepareReplacementWorkerOperator(f.request, f.io, f.now);
        await expect(operator.issueOnlyWhenApproved()).rejects.toThrow(); expect(operator.historyFit()).toBeUndefined();
        expect(existsSync(f.nextPath)).toBe(false); expect(readFileSync(f.claim,'utf8')).toBe(f.receipt);
        expect(reads).toBe(['reference','working','held'].includes(kind)?1:2);
    } finally { f.close(); }
});
