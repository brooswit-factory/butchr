import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerRollout, issueReplacementWorkerPermit, renewExpiredWorkerPermit, type CanaryPermit, type CanaryReplacementRequest } from '../../src/control-panel/worker-rollout.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'canary-new-budget-'));
    mkdirSync(join(directory, 'work'));
    const previousPath = join(directory, 'old.json'), nextPath = join(directory, 'new.json');
    let clock = Date.now(), stops = 0, inspections = 0;
    const permit: CanaryPermit = { version: 1, permitId: '00000000-0000-4000-8000-000000000001', workerKey: 'jira-work:tasks:FIXTURE-1', authority: { serverId: '00000000-0000-4000-8000-000000000002', authorizationId: '00000000-0000-4000-8000-000000000003', deploymentId: '00000000-0000-4000-8000-000000000004' }, desiredToken: 'a'.repeat(64), targetProvider: 'claude', expiresAt: new Date(clock - 1).toISOString(), source: { paneId: 'old', cwd: join(directory, 'work'), provider: 'codex', sessionHash: 'b'.repeat(64) }, holdClearance: { notHeld: true, paneId: 'old', sessionHash: 'b'.repeat(64), expiresAt: new Date(clock - 1).toISOString() } };
    writeFileSync(previousPath, JSON.stringify(permit), { mode: 0o600 });
    const oldGate = createWorkerRollout(previousPath, directory, () => clock), latch = join(directory, 'worker-canary-mode.json'), claim = join(directory, 'worker-canary-attempts', permit.permitId + '.jsonl'), lock = join(directory, 'worker-canary-control.lock');
    const oldText = readFileSync(previousPath, 'utf8'), oldLatch = readFileSync(latch, 'utf8');
    const events: any[] = [{ at: new Date(clock - 2).toISOString(), status: 'claimed', permitId: permit.permitId, workerKey: permit.workerKey, permitHash: hash(oldText) }, { at: new Date(clock - 1).toISOString(), status: 'terminal', result: { status: 'blocked', reason: 'Synthetic pre-target history bound', current: { paneId: 'old', provider: 'codex' }, partial: false }, retired: false, target: null }];
    const receipt = () => events.map(x => JSON.stringify(x)).join('\n') + '\n';
    writeFileSync(claim, receipt(), { mode: 0o600 });
    const next = structuredClone(permit); next.permitId = '00000000-0000-4000-8000-000000000005'; next.expiresAt = new Date(clock + 60_000).toISOString(); next.holdClearance.expiresAt = next.expiresAt;
    const request: CanaryReplacementRequest = { previousPath, nextPath, stateDirectory: directory, next, previousPermitSHA256: hash(oldText), previousReceiptSHA256: hash(receipt()), approvalReference: 'synthetic-new-budget-approval', assertStopped: async () => { stops++; }, inspect: async () => { inspections++; return { checkedAt: clock, enabled: true, notHeld: true, desiredToken: permit.desiredToken, targetProvider: permit.targetProvider, authority: structuredClone(permit.authority), source: structuredClone(permit.source) }; } };
    return { directory, permit, next, previousPath, nextPath, oldGate, oldText, oldLatch, latch, claim, lock, events, receipt, request, now: () => clock, advance: (n: number) => clock += n, counts: () => ({ stops, inspections }), rewriteReceipt: () => { const text = receipt(); writeFileSync(claim, text); request.previousReceiptSHA256 = hash(text); }, close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('explicit successor archives exact spent evidence, keeps latch continuously fenced, grants only distinct ID once', async () => {
    const f = fixture();
    try {
        const originalReceipt = readFileSync(f.claim, 'utf8');
        const result = await issueReplacementWorkerPermit(f.request, f.now);
        expect(result).toMatchObject({ previousPermitId: f.permit.permitId, permitId: f.next.permitId, attemptBudget: 1, fenceLatched: true });
        expect(readFileSync(f.claim, 'utf8')).toBe(originalReceipt); expect(readFileSync(f.previousPath, 'utf8')).toBe(f.oldText);
        const archive = JSON.parse(readFileSync(result.archive, 'utf8'));
        expect(archive).toMatchObject({ kind: 'explicit-new-budget', previousPermit: f.oldText, previousReceipt: originalReceipt, previousLatch: f.oldLatch, approvalReference: f.request.approvalReference, nextPermit: readFileSync(f.nextPath, 'utf8') });
        expect(existsSync(result.archive + '.complete')).toBe(true); expect(existsSync(f.lock)).toBe(false); expect(f.counts()).toEqual({ stops: 2, inspections: 2 });
        expect(() => f.oldGate.observe(undefined)).toThrow('stale');
        const fresh = createWorkerRollout(f.nextPath, f.directory, f.now); expect(fresh.summary().status).toBe('pending'); expect(() => fresh.assertOrdinaryAllowed()).toThrow('fences');
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow();
        const client = { agent: { list: async () => ({ agents: [] }), get: async () => ({ agent: { pane_id: 'wrong' } }) }, pane: { list: async () => ({ panes: [] }) } };
        const change = { id: f.permit.workerKey, token: f.permit.desiredToken, spec: { key: f.permit.workerKey, issuetype: 'Task', summary: 'Synthetic', parent: null, agents: [{ harness: 'claude' as const }] }, authority: f.permit.authority };
        const run = () => fresh.run(client, change, () => true, async () => {}, async () => ({ status: 'blocked' as const, reason: 'synthetic' }), () => undefined);
        expect((await run()).status).toBe('blocked'); await expect(run()).rejects.toThrow('consumed');
        expect(createWorkerRollout(f.nextPath, f.directory, f.now).summary().status).toBe('consumed-before-this-process');
        expect(readFileSync(f.claim, 'utf8')).toBe(originalReceipt);
        await expect(renewExpiredWorkerPermit(f.request, f.now)).rejects.toThrow();
    } finally { f.close(); }
});
for (const kind of ['claim-only', 'empty', 'extra-rpc', 'partial', 'target', 'retired', 'wrong-current', 'wrong-key', 'wrong-hash', 'unknown-result', 'no-newline', 'bad-json', 'future', 'unordered'] as const) test('new budget refuses uncertain prior receipt: ' + kind, async () => {
    const f = fixture();
    try {
        if (kind === 'claim-only') f.events.pop(); if (kind === 'extra-rpc') f.events.splice(1, 0, { status: 'rpc-attempt', group: 'workspace', method: 'create' });
        if (kind === 'partial') f.events[1].result.partial = true; if (kind === 'target') f.events[1].target = 'unproven'; if (kind === 'retired') f.events[1].retired = true;
        if (kind === 'wrong-current') f.events[1].result.current.paneId = 'different'; if (kind === 'wrong-key') f.events[0].workerKey = 'jira-work:tasks:OTHER-2'; if (kind === 'wrong-hash') f.events[0].permitHash = 'd'.repeat(64);
        if (kind === 'unknown-result') f.events[1].result.uncertain = true; if (kind === 'future') f.events[1].at = new Date(f.now() + 1).toISOString(); if (kind === 'unordered') f.events.reverse();
        let text = f.receipt(); if (kind === 'empty') text = ''; if (kind === 'no-newline') text = text.trimEnd(); if (kind === 'bad-json') text = '{invalid}\n';
        writeFileSync(f.claim, text); f.request.previousReceiptSHA256 = hash(text);
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow();
        expect(readFileSync(f.latch, 'utf8')).toBe(f.oldLatch); expect(readFileSync(f.claim, 'utf8')).toBe(text); expect(existsSync(f.nextPath)).toBe(false); expect(existsSync(f.lock)).toBe(false);
    } finally { f.close(); }
});
for (const kind of ['source', 'intent', 'authority', 'provider', 'worker', 'same-id', 'unknown-field', 'permit-hash', 'receipt-hash', 'approval', 'expired', 'expired-hold', 'unbounded', 'hold-after-permit'] as const) test('new budget preserves exact approval binding: ' + kind, async () => {
    const f = fixture();
    try {
        if (kind === 'source') f.next.source.sessionHash = 'c'.repeat(64); if (kind === 'intent') f.next.desiredToken = 'c'.repeat(64); if (kind === 'authority') f.next.authority.deploymentId = f.next.permitId;
        if (kind === 'provider') f.next.targetProvider = 'codex'; if (kind === 'worker') f.next.workerKey = 'jira-work:tasks:OTHER-2'; if (kind === 'same-id') f.next.permitId = f.permit.permitId;
        if (kind === 'unknown-field') (f.next as any).skipHold = true; if (kind === 'permit-hash') f.request.previousPermitSHA256 = 'c'.repeat(64); if (kind === 'receipt-hash') f.request.previousReceiptSHA256 = 'c'.repeat(64); if (kind === 'approval') f.request.approvalReference = '';
        if (kind === 'expired') f.next.expiresAt = f.permit.expiresAt; if (kind === 'expired-hold') f.next.holdClearance.expiresAt = f.permit.expiresAt; if (kind === 'unbounded') f.next.expiresAt = new Date(f.now() + 21 * 60_000).toISOString(); if (kind === 'hold-after-permit') f.next.holdClearance.expiresAt = new Date(f.now() + 61_000).toISOString();
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow(); expect(readFileSync(f.latch, 'utf8')).toBe(f.oldLatch); expect(existsSync(f.nextPath)).toBe(false);
    } finally { f.close(); }
});
for (const kind of ['held', 'disabled', 'stale', 'source', 'intent', 'stopped-unknown'] as const) test('new budget requires independent fresh proof: ' + kind, async () => {
    const f = fixture();
    try {
        const inspect = f.request.inspect; f.request.inspect = async () => { const s = await inspect(); if (kind === 'held') s.notHeld = false; if (kind === 'disabled') s.enabled = false; if (kind === 'stale') s.checkedAt -= 5001; if (kind === 'source') s.source.paneId = 'foreign'; if (kind === 'intent') s.desiredToken = 'c'.repeat(64); return s; };
        if (kind === 'stopped-unknown') f.request.assertStopped = async () => { throw Error('Unknown process state'); };
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow(); expect(readFileSync(f.latch, 'utf8')).toBe(f.oldLatch); expect(existsSync(f.nextPath)).toBe(false);
    } finally { f.close(); }
});
for (const kind of ['old-claim-alias', 'old-claim-hardlink', 'existing-output', 'existing-new-claim'] as const) test('new budget refuses conflicting file ownership: ' + kind, async () => {
    const f = fixture();
    try {
        if (kind === 'old-claim-alias') { const target = join(f.directory, 'claim-copy'); writeFileSync(target, f.receipt(), { mode: 0o600 }); rmSync(f.claim); symlinkSync(target, f.claim); }
        if (kind === 'old-claim-hardlink') linkSync(f.claim, join(f.directory, 'foreign-link'));
        if (kind === 'existing-output') writeFileSync(f.nextPath, 'foreign', { mode: 0o600 });
        if (kind === 'existing-new-claim') writeFileSync(join(f.directory, 'worker-canary-attempts', f.next.permitId + '.jsonl'), 'uncertain', { mode: 0o600 });
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow(); expect(readFileSync(f.latch, 'utf8')).toBe(f.oldLatch);
    } finally { f.close(); }
});
test('concurrent new grants and old claims share the same exclusion lock', async () => {
    const f = fixture(); let proceed!: () => void;
    try {
        let entered = false; const wait = new Promise<void>(r => proceed = r), inspect = f.request.inspect;
        f.request.inspect = async () => { entered = true; await wait; return inspect(); };
        const first = issueReplacementWorkerPermit(f.request, f.now); while (!entered) await Bun.sleep(1);
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow(); expect(() => f.oldGate.observe(undefined)).toThrow();
        proceed(); await first; expect(readFileSync(f.claim, 'utf8')).toBe(f.receipt());
    } finally { proceed?.(); f.close(); }
});
for (const kind of ['hold', 'receipt-drift', 'permit-drift', 'latch-drift', 'new-claim', 'expiry'] as const) test('late uncertainty preserves archive/new file/control barrier: ' + kind, async () => {
    const f = fixture();
    try {
        const inspect = f.request.inspect; let n = 0;
        f.request.inspect = async () => { const s = await inspect(); if (++n === 2) { if (kind === 'hold') s.notHeld = false; if (kind === 'receipt-drift') writeFileSync(f.claim, f.receipt() + '\n'); if (kind === 'permit-drift') writeFileSync(f.previousPath, f.oldText + '\n'); if (kind === 'latch-drift') writeFileSync(f.latch, f.oldLatch + '\n'); if (kind === 'new-claim') writeFileSync(join(f.directory, 'worker-canary-attempts', f.next.permitId + '.jsonl'), 'uncertain', { mode: 0o600 }); if (kind === 'expiry') f.advance(61_000); } return s; };
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow(); expect(existsSync(f.lock)).toBe(true); expect(existsSync(f.nextPath)).toBe(true); expect(readFileSync(f.latch, 'utf8')).toMatch(kind === 'latch-drift' ? f.oldLatch + '\n' : f.oldLatch);
        expect(() => f.oldGate.observe(undefined)).toThrow();
    } finally { f.close(); }
});

test('post-commit completion failure keeps new fence and durable exclusion barrier', async () => {
    const f = fixture();
    try {
        const inspect = f.request.inspect; let n = 0;
        const archive = join(f.directory, 'worker-canary-replacements', f.permit.permitId + '-' + f.request.previousReceiptSHA256 + '.json');
        f.request.inspect = async () => { const s = await inspect(); if (++n === 2) mkdirSync(archive + '.complete'); return s; };
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow();
        expect(existsSync(f.lock)).toBe(true); expect(JSON.parse(readFileSync(f.latch, 'utf8')).permitId).toBe(f.next.permitId);
        expect(readFileSync(f.claim, 'utf8')).toBe(f.receipt()); expect(readFileSync(f.previousPath, 'utf8')).toBe(f.oldText);
        const gate = createWorkerRollout(f.nextPath, f.directory, f.now); expect(() => gate.observe(undefined)).toThrow();
        expect(() => gate.assertOrdinaryAllowed()).toThrow();
        await expect(issueReplacementWorkerPermit(f.request, f.now)).rejects.toThrow();
    } finally { f.close(); }
});
test('captured successor cannot be changed while asynchronous inspection is pending', async () => {
    const f = fixture();
    try {
        const inspect = f.request.inspect;
        f.request.inspect = async () => { f.next.source.paneId = 'foreign'; f.request.approvalReference = 'different'; return inspect(); };
        const r = await issueReplacementWorkerPermit(f.request, f.now);
        expect(JSON.parse(readFileSync(f.nextPath, 'utf8')).source.paneId).toBe('old');
        expect(JSON.parse(readFileSync(r.archive, 'utf8')).approvalReference).toBe('synthetic-new-budget-approval');
    } finally { f.close(); }
});
test('unrelated prior permit and receipts survive explicit successor issuance', async () => {
    const f = fixture();
    try {
        const sentinel = join(f.directory, 'worker-canary-attempts', 'foreign.jsonl'); writeFileSync(sentinel, 'foreign owner', { mode: 0o600 });
        const ancestor = join(f.directory, 'initial-approved.json'); writeFileSync(ancestor, 'initial approved permit', { mode: 0o600 });
        await issueReplacementWorkerPermit(f.request, f.now);
        expect(readFileSync(sentinel, 'utf8')).toBe('foreign owner'); expect(readFileSync(ancestor, 'utf8')).toBe('initial approved permit');
    } finally { f.close(); }
});
test('a missing receipt, nonfinite clock and different permit directory are refused before writes', async () => {
    for (const kind of ['missing', 'clock', 'directory']) {
        const f = fixture();
        try {
            if (kind === 'missing') rmSync(f.claim);
            if (kind === 'directory') { mkdirSync(join(f.directory, 'other')); f.request.nextPath = join(f.directory, 'other/new.json'); }
            await expect(issueReplacementWorkerPermit(f.request, kind === 'clock' ? () => NaN : f.now)).rejects.toThrow();
            expect(readFileSync(f.latch, 'utf8')).toBe(f.oldLatch); expect(existsSync(f.nextPath)).toBe(false); expect(existsSync(f.lock)).toBe(false);
        } finally { f.close(); }
    }
});

function frozenFixture() {
 const f=fixture(),identity={paneId:'wOwned:p1',workspaceId:'wOwned',terminalId:'term_owned',cwd:f.permit.source.cwd,bootId:'00000000-0000-4000-8000-000000000010',pid:4242,startTicks:'1234',executableSHA256:'c'.repeat(64)};
 f.events.splice(1,0,{at:new Date(f.now()-2).toISOString(),status:'rpc-attempt',group:'workspace',method:'create'},{at:new Date(f.now()-2).toISOString(),status:'target-created',pane:identity.paneId},{at:new Date(f.now()-1).toISOString(),status:'rpc-attempt',group:'agent',method:'start'});f.events[4].result.partial=true;f.events[4].target=identity.paneId;f.rewriteReceipt();
 const ancestor=join(f.directory,'worker-canary-attempts','00000000-0000-4000-8000-000000000009.jsonl');writeFileSync(ancestor,'immutable first spent receipt\n',{mode:0o600});
 const proof={checkedAt:f.now(),identity:structuredClone(identity),allThreadsStopped:true,noChildren:true,soleProcessGroupMember:true,noRegisteredAgent:true,blankVisiblePane:true,noUnaccountedLaunch:true};let checks=0;
 f.request.preservedPartialTarget={identity,ancestorReceipts:[{path:ancestor,sha256:hash(readFileSync(ancestor,'utf8'))}],inspect:async()=>{checks++;return structuredClone(proof);}};
 return {...f,identity,proof,ancestor,proofChecks:()=>checks};
}
test('frozen partial successor preserves both receipts and archives exact proof',async()=>{const f=frozenFixture();try{const spent=readFileSync(f.claim,'utf8'),ancestor=readFileSync(f.ancestor,'utf8');const r=await issueReplacementWorkerPermit(f.request,f.now);expect(f.proofChecks()).toBe(3);expect(readFileSync(f.claim,'utf8')).toBe(spent);expect(readFileSync(f.ancestor,'utf8')).toBe(ancestor);expect(JSON.parse(readFileSync(r.archive,'utf8'))).toMatchObject({preservedTarget:f.identity,preservedProof:f.proof,ancestorReceipts:[{path:f.ancestor,text:ancestor}]});expect(existsSync(f.lock)).toBe(false);const gate=createWorkerRollout(f.nextPath,f.directory,f.now);expect(()=>gate.assertOrdinaryAllowed()).toThrow();await expect(issueReplacementWorkerPermit(f.request,f.now)).rejects.toThrow();}finally{f.close();}});
for(const key of ['allThreadsStopped','noChildren','soleProcessGroupMember','noRegisteredAgent','blankVisiblePane','noUnaccountedLaunch'] as const)test('partial successor refuses missing isolation: '+key,async()=>{const f=frozenFixture();try{f.proof[key]=false;await expect(issueReplacementWorkerPermit(f.request,f.now)).rejects.toThrow();expect(readFileSync(f.latch,'utf8')).toBe(f.oldLatch);expect(existsSync(f.nextPath)).toBe(false);}finally{f.close();}});
for(const kind of ['missing-capability','wrong-pane','extra-prompt','ack-event','wrong-current','missing-current','stale','future','generation','ancestor-drift','ancestor-alias'] as const)test('partial successor rejects uncertain '+kind,async()=>{const f=frozenFixture();try{
 if(kind==='missing-capability')delete f.request.preservedPartialTarget;if(kind==='wrong-pane')f.events[2].pane='wForeign:p1';
 if(kind==='extra-prompt')f.events.splice(4,0,{at:new Date(f.now()-1).toISOString(),status:'rpc-attempt',group:'agent',method:'prompt'});if(kind==='ack-event')f.events.splice(4,0,{at:new Date(f.now()-1).toISOString(),status:'acknowledged-source-close-attempt',pane:'old'});
 if(kind==='wrong-current')f.events[4].result.current.paneId='new';if(kind==='missing-current')delete f.events[4].result.current;if(kind==='stale')f.proof.checkedAt-=5001;if(kind==='future')f.proof.checkedAt++;if(kind==='generation')f.proof.identity.startTicks='999';
 if(kind==='ancestor-drift')writeFileSync(f.ancestor,'changed');if(kind==='ancestor-alias'){const other=join(f.directory,'ancestor-copy');writeFileSync(other,readFileSync(f.ancestor),{mode:0o600});rmSync(f.ancestor);symlinkSync(other,f.ancestor);}f.rewriteReceipt();await expect(issueReplacementWorkerPermit(f.request,f.now)).rejects.toThrow();expect(readFileSync(f.latch,'utf8')).toBe(f.oldLatch);expect(existsSync(f.nextPath)).toBe(false);
 }finally{f.close();}});
test('late thaw leaves old fence and durable exclusion barrier',async()=>{const f=frozenFixture();try{let n=0;f.request.preservedPartialTarget!.inspect=async()=>({...structuredClone(f.proof),allThreadsStopped:++n<3});await expect(issueReplacementWorkerPermit(f.request,f.now)).rejects.toThrow();expect(existsSync(f.nextPath)).toBe(true);expect(existsSync(f.lock)).toBe(true);expect(readFileSync(f.latch,'utf8')).toBe(f.oldLatch);}finally{f.close();}});
