import {DrovrClient} from '@brooswit/drovr';
import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerRollout, configuredWorkerRollout, daemonWorkerClient, nativeSessionHash, type CanaryPermit } from '../../src/control-panel/worker-rollout.js';
import type { WorkerChange } from '../../src/control-panel/worker-reconciliation.js';
const authority = { serverId: '00000000-0000-4000-8000-000000000001', authorizationId: '00000000-0000-4000-8000-000000000002', deploymentId: '00000000-0000-4000-8000-000000000003' };
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'worker-canary-')), path = join(directory, 'permit.json');
    mkdirSync(join(directory,'work'));
    const source = { pane_id: 'old', cwd: join(directory, 'work'), agent: 'codex', agent_status: 'idle', interactive_ready: true, agent_session: { agent: 'codex', kind: 'id', value: 'synthetic-source-session' } };
    const rows = new Map<string, any>([['old', source], ['reviewer', { ...source, pane_id: 'reviewer', cwd: join(directory, 'reviewer') }], ['human', { pane_id: 'human', cwd: directory }]]), effects: string[] = [];
    const permit: CanaryPermit = { version: 1, permitId: '00000000-0000-4000-8000-000000000004', workerKey: 'jira-work:tasks:FIXTURE-1', authority, desiredToken: 'a'.repeat(64), targetProvider: 'claude', expiresAt: new Date(Date.now() + 600000).toISOString(), source: { paneId: 'old', cwd: source.cwd, provider: 'codex', sessionHash: nativeSessionHash(source.agent_session)! }, holdClearance: { notHeld: true, paneId: 'old', sessionHash: nativeSessionHash(source.agent_session)!, expiresAt: new Date(Date.now() + 600000).toISOString() } };
    function save() { writeFileSync(path, JSON.stringify(permit), { mode: 0o600 }); }
    save();
    const raw = { agent: { list: async () => ({ agents: [...rows.values()] }), get: async (id: string) => ({ agent: rows.get(id) }), start: async (p: any) => { effects.push('start:' + p.kind); rows.set(p.pane_id, { ...source, pane_id: p.pane_id, agent: p.kind, agent_session: { agent: p.kind, kind: 'id', value: 'synthetic-target-session' } }); }, stop: async () => { effects.push('stop'); }, prompt: async (p: any) => { effects.push('prompt:' + p.target); } }, workspace: { create: async (_p: any) => { effects.push('create'); rows.set('target', { pane_id: 'target', cwd: source.cwd }); return { root_pane: 'target' }; }, close: async () => effects.push('workspace-close') }, pane: { list: async () => ({ panes: [...rows.keys()].map(pane_id => ({ pane_id })) }), close: async (id: string) => { effects.push('close:' + id); rows.delete(id); }, sendKeys: async () => effects.push('keys'), sendText: async () => effects.push('text') } };
    const change: WorkerChange = { id: permit.workerKey, token: permit.desiredToken, spec: { key: permit.workerKey, issuetype: 'Task', summary: 'Synthetic canary', parent: null, agents: [{ harness: 'claude', model: 'synthetic' }] }, authority };
    const gate = createWorkerRollout(path, directory), client = gate.wrap(raw);
    let committed: {
        paneId: string;
        provider: string;
    } | undefined;
    let current = true, held = false;
    const run = (action: () => Promise<any>, c = change) => gate.run(raw, c, () => current, async () => { if (held)
        throw Error('held'); }, action, () => committed);
    async function create() { await client.workspace.create({ cwd: source.cwd }); await client.agent.start({ kind: 'claude', pane_id: 'target' }); }
    async function success() { await create(); committed = { paneId: 'target', provider: 'claude' }; await client.pane.close('old'); await client.agent.prompt({ target: 'target', text: 'synthetic kickoff' }); return { status: 'applied' as const, current: { paneId: 'target', provider: 'claude' } }; }
    return { directory, path, permit, source, rows, effects, raw, client, gate, change, run, create, success, save, setCurrent: (v: boolean) => current = v, setHeld: (v: boolean) => held = v, setCommitted: () => committed = { paneId: 'target', provider: 'claude' }, close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('one acknowledged exact task handoff, durable consume, reviewer/human untouched', async () => { const f = fixture(); try {
    expect(await f.run(f.success)).toMatchObject({ status: 'applied' });
    expect(f.effects).toEqual(['create', 'start:claude', 'close:old', 'prompt:target']);
    expect(f.rows.has('reviewer')).toBe(true);
    expect(f.rows.has('human')).toBe(true);
    await expect(f.run(f.success)).rejects.toThrow('consumed');
    const restarted = createWorkerRollout(f.path, f.directory);
    await expect(restarted.run(f.raw, f.change, () => true, async () => { }, f.success, () => undefined)).rejects.toThrow('consumed');
    expect(() => configuredWorkerRollout(undefined, f.directory)).toThrow('latched');
}
finally {
    f.close();
} });
test('all alternate replacement/keyboard paths and other task/reviewer identities fail before effects', async () => { const f = fixture(); try {
    for (const effect of [() => f.client.agent.start({ kind: 'codex' }), () => f.client.agent.stop(), () => f.client.workspace.create({ cwd: f.source.cwd }), () => f.client.workspace.close(), () => f.client.pane.close('human'), () => f.client.pane.sendKeys(), () => f.client.pane.sendText()])
        await expect(effect()).rejects.toThrow('observational');
    for (const id of ['jira-work:tasks:FIXTURE-2', 'jira-work:reviewers:FIXTURE-1', 'human'])
        await expect(f.run(f.success, { ...f.change, id })).rejects.toThrow('outside');
    expect(f.effects).toEqual([]);
    expect(f.gate.summary().status).toBe('pending');
    await f.client.agent.prompt({ target: 'reviewer', text: 'ordinary synthetic notice' });
    expect(f.effects).toEqual(['prompt:reviewer']);
}
finally {
    f.close();
} });
for (const kind of ['held', 'pane', 'session', 'busy', 'authority', 'provider', 'superseded'] as const)
    test('reject and consume ' + kind + ' canary attempt', async () => { const f = fixture(); try {
        if (kind === 'held')
            f.setHeld(true);
        if (kind === 'pane')
            f.source.pane_id = 'replacement';
        if (kind === 'session')
            f.source.agent_session.value = 'different';
        if (kind === 'busy')
            f.source.agent_status = 'working';
        if (kind === 'authority')
            f.change.authority = { ...authority, deploymentId: '00000000-0000-4000-8000-000000000099' };
        if (kind === 'provider')
            f.change.spec.agents = [{ harness: 'codex' }];
        if (kind === 'superseded')
            f.setCurrent(false);
        expect(await f.run(f.success)).toMatchObject({ status: 'blocked' });
        expect(f.effects).toEqual([]);
        await expect(f.run(f.success)).rejects.toThrow('consumed');
    }
    finally {
        f.close();
    } });
test('authoritative OFF/supersession invalidates even unused permit, identical later ON cannot revive it', async () => { for (const enabled of [false, true]) {
    const f = fixture();
    try {
        f.gate.observe({ enabled, token: enabled ? 'b'.repeat(64) : f.change.token, authority });
        f.gate.observe({ enabled: true, token: f.change.token, authority });
        await expect(f.run(f.success)).rejects.toThrow('consumed');
        expect(f.effects).toEqual([]);
        expect(readFileSync(f.gate.summary().receipt, 'utf8')).toContain('invalidated');
    }
    finally {
        f.close();
    }
} });
test('source cannot retire before acknowledged commit; a target remains a partial receipt', async () => { const f = fixture(); try {
    expect(await f.run(async () => { await f.create(); await f.client.pane.close('old'); return { status: 'applied' }; })).toMatchObject({ status: 'blocked', partial: true });
    expect(f.rows.has('old')).toBe(true);
    expect(f.effects).toEqual(['create', 'start:claude']);
}
finally {
    f.close();
} });
test('failure, supersession after create, and uncertain RPC return each consume one attempt', async () => { for (const kind of ['create-error', 'superseded', 'partial-close']) {
    const f = fixture();
    try {
        if (kind === 'create-error')
            f.raw.workspace.create = async () => { f.effects.push('uncertain-create'); throw Error('timeout'); };
        if (kind === 'partial-close')
            f.raw.pane.close = async () => { throw Error('retirement error'); };
        const result = await f.run(async () => { await f.create(); if (kind === 'superseded')
            f.setCurrent(false); f.setCommitted(); await f.client.pane.close('old'); return { status: 'applied', current: { paneId: 'target', provider: 'claude' } }; });
        expect(result).toMatchObject({ status: 'blocked', partial: true });
        await expect(f.run(f.success)).rejects.toThrow('consumed');
        expect(f.effects.filter(x => x.startsWith('start')).length).toBeLessThanOrEqual(1);
    }
    finally {
        f.close();
    }
} });
test('no fallback provider, no second create/start, no foreign pane closure', async () => { for (const kind of ['provider', 'create', 'start', 'human']) {
    const f = fixture();
    try {
        const result = await f.run(async () => { await f.create(); if (kind === 'provider')
            await f.client.agent.start({ kind: 'codex', pane_id: 'target' }); if (kind === 'create')
            await f.client.workspace.create({ cwd: f.source.cwd }); if (kind === 'start')
            await f.client.agent.start({ kind: 'claude', pane_id: 'target' }); if (kind === 'human')
            await f.client.pane.close('human'); return { status: 'applied' }; });
        expect(result).toMatchObject({ status: 'blocked', partial: true });
        expect(f.effects).toEqual(['create', 'start:claude']);
        expect(f.rows.has('human')).toBe(true);
    }
    finally {
        f.close();
    }
} });
test('present malformed/empty config never becomes unrestricted; clean absent mode is normal', () => { const f = fixture(); try {
    expect(() => configuredWorkerRollout('', f.directory)).toThrow();
    const clean = mkdtempSync(join(tmpdir(), 'canary-absent-'));
    try {
        expect(configuredWorkerRollout(undefined, clean)).toBeUndefined();
    }
    finally {
        rmSync(clean, { recursive: true, force: true });
    }
    chmodSync(f.path, 0o644);
    expect(() => createWorkerRollout(f.path, f.directory)).toThrow('private');
}
finally {
    f.close();
} });
test('common daemon client fences direct watcher/keyboard and generic RPC routes without double counting', async () => { const f = fixture(); try {
    const common = daemonWorkerClient({ ...f.raw, call: async (_method:string,_params:unknown) => { f.effects.push('raw-call'); } }, f.gate);
    expect(f.gate.wrap(common)).toBe(common);
    await expect(common.pane.sendKeys()).rejects.toThrow('observational');
    await expect(common.pane.sendText()).rejects.toThrow('observational');
    expect(() => common.call('agent.start', {})).toThrow('bypass');
    expect(() => Reflect.get(common, 'inner')).toThrow('internals');
    expect(f.effects).toEqual([]);
    const index = readFileSync(new URL('../../src/daemon/index.ts', import.meta.url), 'utf8');
    expect(index).toContain('const herdr = daemonWorkerClient(new DrovrClient(');
    expect(index.match(/new DrovrClient\(/g)?.length).toBe(1);
}
finally {
    f.close();
} });
for (const phase of ['before-close', 'reply-lost', 'receipt-fails'])
    test('post-ACK physical identity survives ' + phase, async () => {
        const f = fixture();
        let restore: (() => void) | undefined;
        try {
            if (phase === 'before-close')
                f.raw.pane.close = async () => { throw Error('close refused'); };
            if (phase === 'reply-lost')
                f.raw.pane.close = async (id: string) => { f.rows.delete(id); throw Error('close reply lost'); };
            if (phase === 'receipt-fails') {
                const real = fs.writeSync;
                const spy = spyOn(fs, 'writeSync').mockImplementation(((...args: any[]) => { if (!f.rows.has('old'))
                    throw Error('receipt write failed after physical close'); return (real as any)(...args); }) as any);
                restore = () => spy.mockRestore();
            }
            const result = await f.run(f.success);
            expect(result).toMatchObject({ status: 'blocked', partial: true, current: { paneId: 'target', provider: 'claude' } });
            if (phase === 'before-close')
                expect(f.rows.has('old')).toBe(true);
            else
                expect(f.rows.has('old')).toBe(false);
            await expect(f.run(f.success)).rejects.toThrow('consumed');
        }
        finally {
            restore?.();
            f.close();
        }
    });

test('pinned Drovr raw and permission-watcher agent keyboard aliases use the same fence',async()=>{
 const f=fixture();try{
  const inner={...f.raw,agent:{...f.raw.agent,sendKeys:async()=>f.effects.push('agent-keys')},pane:{...f.raw.pane,sendInput:async()=>f.effects.push('pane-input')},call:async()=>{f.effects.push('generic-call');},tab:{close:async()=>f.effects.push('tab-close')},server:{liveHandoff:async()=>f.effects.push('server-handoff')}};
  const pinned=new DrovrClient({herdr:inner as any,corrections:{}});const common=daemonWorkerClient(pinned,f.gate);
  expect(f.gate.wrap(common)).toBe(common);expect(common.raw.raw).toBe(common.raw);
  await expect(common.raw.agent.start({kind:'codex',pane_id:'human'} as any)).rejects.toThrow('observational');
  await expect(common.agent.sendKeys({target:'human',keys:['enter']} as any)).rejects.toThrow('observational');
  await expect(common.raw.agent.sendKeys({target:'human',keys:['enter']} as any)).rejects.toThrow('observational');
  await expect(common.pane.sendInput({pane_id:'human',data:'x'} as any)).rejects.toThrow('observational');
  await expect(common.raw.pane.sendInput({pane_id:'human',data:'x'} as any)).rejects.toThrow('observational');
  await expect(common.tab.close({tab_id:'human'} as any)).rejects.toThrow('observational');
  await expect(common.server.liveHandoff({} as any)).rejects.toThrow('observational');expect(f.effects).toEqual([]);expect((await common.agent.list()).agents.length).toBe(3);
 }finally{f.close();}
});

test('permit edit or a newly held source during asynchronous identity lookup fails before effects',async()=>{
 for(const kind of ['permit','hold']){const f=fixture();try{const original=f.raw.agent.get;f.raw.agent.get=async(id:string)=>{const row=await original(id);if(kind==='permit'){f.permit.expiresAt=new Date(Date.now()+300000).toISOString();f.save();}else f.setHeld(true);return row;};expect(await f.run(f.success)).toMatchObject({status:'blocked'});expect(f.effects).toEqual([]);await expect(f.run(f.success)).rejects.toThrow('consumed');}finally{f.close();}}
});

test('target lookup cannot launder later hold, OFF or edited permit into prompt/source-close/cleanup effects',async()=>{
 for(const operation of ['prompt','source-close','target-cleanup'])for(const mutation of ['hold','OFF','permit']){
  const f=fixture();try{const result=await f.run(async()=>{await f.create();if(operation==='source-close')f.setCommitted();const original=f.raw.agent.get;f.raw.agent.get=async(id:string)=>{const row=await original(id);if(id==='target'){if(mutation==='hold')f.setHeld(true);if(mutation==='OFF')f.setCurrent(false);if(mutation==='permit'){f.permit.expiresAt=new Date(Date.now()+300000).toISOString();f.save();}}return row;};if(operation==='prompt')await f.client.agent.prompt({target:'target',text:'synthetic'});else await f.client.pane.close(operation==='source-close'?'old':'target');return {status:'applied',current:{paneId:'target',provider:'claude'}};});expect(result).toMatchObject({status:'blocked',partial:true});expect(f.effects).toEqual(['create','start:claude']);expect(f.rows.has('old')).toBe(true);expect(f.rows.has('target')).toBe(true);}finally{f.close();}
 }
});
test('census wait rechecks permit/hold/intent before handing control to production action',async()=>{
 for(const mutation of ['hold','OFF','permit']){const f=fixture();let invoked=false;try{const original=f.raw.pane.list;f.raw.pane.list=async()=>{const rows=await original();if(mutation==='hold')f.setHeld(true);if(mutation==='OFF')f.setCurrent(false);if(mutation==='permit'){f.permit.expiresAt=new Date(Date.now()+300000).toISOString();f.save();}return rows;};expect(await f.run(async()=>{invoked=true;return f.success();})).toMatchObject({status:'blocked'});expect(invoked).toBe(false);expect(f.effects).toEqual([]);}finally{f.close();}}
});
