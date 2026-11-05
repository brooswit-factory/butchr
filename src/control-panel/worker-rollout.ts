import {verifyValidationRetirement} from '../operator/validation-retirement.js';
import {assertClaudeTargetReady} from './worker-target-readiness.js';
import type {OwnedTargetContinuation,ContinuationProgress} from '@brooswit/drovr';
import type {ContinuationPolicyBinding,ContinuationPolicyProof} from './worker-continuation-policy.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { WorkerChange, WorkerChangeResult } from './worker-reconciliation.js';
export interface CanaryPermit {
    version: 1 | 2;
    permitId: string;
    continuation?: {
        kind:'owned-existing-target';issuedAt:string;operationDeadline:string;
        target:{paneId:string;workspaceId:string;terminalId:string;provider:'claude';cwd:string;sessionHash:string};
        snapshot:{sha256:string;bytes:number;chars:number;chunks:number};policy:ContinuationPolicyBinding;
    };
    workerKey: string;
    authority: {
        serverId: string;
        authorizationId: string;
        deploymentId: string;
    };
    desiredToken: string;
    targetProvider: 'claude' | 'codex' | 'agy';
    expiresAt: string;
    source: {
        paneId: string;
        cwd: string;
        provider: string;
        sessionHash: string;
    };
    holdClearance: {
        notHeld: true;
        paneId: string;
        sessionHash: string;
        expiresAt: string;
    };
}
export interface CanaryIntent {
    token: string;
    authority?: WorkerChange['authority'];
    enabled: boolean;
}
type Agent = {
    pane_id: string;
    workspace_id?:string;terminal_id?:string;
    cwd?: string | null | undefined;
    agent?: string | null | undefined;
    agent_status?: string | null | undefined;
    interactive_ready?: boolean | null | undefined;
    agent_session?: {
        agent?: string | null | undefined;
        kind?: string | null | undefined;
        value?: unknown;
    } | null | undefined;
};
type RpcClient = {
    agent: {
        list: () => Promise<{
            agents: Agent[];
        }>;
        get: (id: string) => Promise<{
            agent: Agent;
        }>;
    };
    pane: {
        list: () => Promise<{
            panes: {
                pane_id: string;
            }[];
        }>;
    };
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const nativeSessionHash = (session: Agent['agent_session']) => session?.agent && session.kind && session.value ? digest(JSON.stringify([session.agent, session.kind, session.value])) : undefined;
const uuid = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
function privateFile(path: string) {
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path))
        throw Error('Canary path must have canonical nonsymlink parent');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const s = fstatSync(fd);
        if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size > 16384)
            throw Error('Canary file must be owner-private regular bounded data');
        return readFileSync(fd, 'utf8');
    }
    finally {
        closeSync(fd);
    }
}
export function parsePermit(text: string): CanaryPermit {
    const p = JSON.parse(text) as CanaryPermit;
    if (![1,2].includes(p.version) || !uuid(p.permitId) || !/^jira-work:tasks:[A-Z][A-Z0-9_]*-\d+$/.test(p.workerKey) || !uuid(p.authority?.serverId) || !uuid(p.authority?.authorizationId) || !uuid(p.authority?.deploymentId) || !/^[a-f0-9]{64}$/.test(p.desiredToken) || !['claude', 'codex', 'agy'].includes(p.targetProvider) || !isAbsolute(p.source?.cwd ?? '') || !p.source?.paneId || !p.source.provider || !/^[a-f0-9]{64}$/.test(p.source.sessionHash) || p.holdClearance?.notHeld !== true || p.holdClearance.paneId !== p.source.paneId || p.holdClearance.sessionHash !== p.source.sessionHash || !Number.isFinite(Date.parse(p.expiresAt)) || !Number.isFinite(Date.parse(p.holdClearance.expiresAt)))
        throw Error('Invalid exact-identity canary permit/hold clearance');
    if(p.version===1&&p.continuation!==undefined||p.version===2&&!p.continuation)throw Error('Explicit continuation permit version required');
    if(p.continuation){const c=p.continuation,issued=Date.parse(c.issuedAt),deadline=Date.parse(c.operationDeadline),admit=Date.parse(p.expiresAt);
        if(c.kind!=='owned-existing-target'||p.source.provider!=='codex'||p.targetProvider!=='claude'||c.target.provider!=='claude'||!/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(c.target.paneId)||c.target.paneId===p.source.paneId||c.target.workspaceId!==c.target.paneId.split(':')[0]||!c.target.terminalId||c.target.cwd!==p.source.cwd||!/^[a-f0-9]{64}$/.test(c.target.sessionHash)||!Number.isFinite(issued)||!Number.isFinite(deadline)||deadline<=issued||deadline-issued>48*60*60_000||admit<=issued||admit-issued>20*60_000||Date.parse(p.holdClearance.expiresAt)>admit||deadline<admit||!/^https:\/\//.test(c.policy.origin)||p.workerKey!=='jira-work:tasks:'+c.policy.issueKey||![c.policy.issueHash,c.policy.taskHash,c.policy.reviewerHash,c.snapshot.sha256].every(x=>/^[a-f0-9]{64}$/.test(x))||![c.snapshot.bytes,c.snapshot.chars,c.snapshot.chunks].every(x=>Number.isSafeInteger(x)&&x>0)||c.snapshot.bytes>64*1024*1024||c.snapshot.chars>64*1024*1024||c.snapshot.chunks<Math.ceil(c.snapshot.chars/48000)||c.snapshot.chunks>Math.ceil(c.snapshot.chars/47999))throw Error('Invalid bounded exact existing-target continuation');
    }
    if(realpathSync(p.source.cwd)!==p.source.cwd)throw Error('Canary source cwd must be canonical and nonsymlink');
    const cwdStat=lstatSync(p.source.cwd);if(!cwdStat.isDirectory()||cwdStat.isSymbolicLink()||cwdStat.uid!==process.getuid?.())throw Error('Canary source cwd must be an owned directory');
    return p;
}

function syncCanaryDirectory(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
/** Shared by consumption and renewal. An abandoned lock is uncertainty, never a timeout lease. */
function canaryControlLock(directory:string){
 const path=join(directory,'worker-canary-control.lock');
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 const owned=fstatSync(fd);
 try{writeFileSync(fd,JSON.stringify({version:1,pid:process.pid})+'\n');fsyncSync(fd);syncCanaryDirectory(directory);}catch(e){closeSync(fd);throw e;}
 return Object.assign(()=>{try{const current=lstatSync(path);if(current.dev!==owned.dev||current.ino!==owned.ino)throw Error('Canary control lock ownership changed');unlinkSync(path);syncCanaryDirectory(directory);}finally{closeSync(fd);}},{abandon:()=>closeSync(fd)});
}
function sameCanaryLatch(path:string,permitId:string,hash:string){const latch=JSON.parse(privateFile(path));if(latch.permitId!==permitId||latch.permitHash!==hash)throw Error('Canary latch changed; stale operation refused');}
function newCanaryFile(path:string,text:string){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}syncCanaryDirectory(dirname(path));}

/** Explicit temporary mode. No environment flag means this guard is not installed. */
export function createWorkerRollout(path: string, stateDirectory: string, now = () => Date.now(), monotonicNow = () => performance.now()) {
    const text = privateFile(path), permit = parsePermit(text), fileHash = digest(text);
    if (!isAbsolute(stateDirectory) || realpathSync(stateDirectory) !== stateDirectory)
        throw Error('Canonical canary state directory required');
    const stateStat = lstatSync(stateDirectory);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || stateStat.uid !== process.getuid?.() || (stateStat.mode & 0o077))
        throw Error('Canary state directory must be owner-private');
    const receipts = join(stateDirectory, 'worker-canary-attempts');
    try {
        mkdirSync(receipts, { mode: 0o700 });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
            throw e;
    }
    const dir = lstatSync(receipts);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077))
        throw Error('Unsafe canary receipt directory');
    const latch = join(stateDirectory, 'worker-canary-mode.json');
    try {
        const fd = openSync(latch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            writeSync(fd, JSON.stringify({ permitId: permit.permitId, permitHash: fileHash }) + '\n');
            fsyncSync(fd);
            const d = openSync(stateDirectory, 'r');
            try {
                fsyncSync(d);
            }
            finally {
                closeSync(d);
            }
        }
        finally {
            closeSync(fd);
        }
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
            throw e;
        const previous = JSON.parse(privateFile(latch));
        if (previous.permitId !== permit.permitId || previous.permitHash !== fileHash)
            throw Error('Canary mode is latched to another reviewed permit; explicit retirement required');
    }
    const receipt = join(receipts, permit.permitId + '.jsonl');
    let status = 'pending';
    try {
        const fd = openSync(receipt, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const s = fstatSync(fd);
            if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077))
                throw Error('Unsafe canary receipt');
            status = 'consumed-before-this-process';
        }
        finally {
            closeSync(fd);
        }
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    type Context = {
        client: RpcClient;
        current: () => boolean;
        runnable: () => Promise<void>;
        fd: number;
        target?: string;
        targetSession?: string;
        retired: boolean;
        sourceVerified: boolean;
        sourceCloseAttempted: boolean;
        created: boolean;
        started: boolean;
        closedTarget: boolean;
        acknowledged: boolean;
        committed: () => {
            paneId: string;
            provider: string;
        } | undefined;
        protectedPanes: Set<string>;
        ended?:boolean;abandoned?:boolean;monoDeadline?:number;policyProof?:ContinuationPolicyProof;lastAck?:number;promptIndex?:number;sentIndex?:number;progressCommitted?:boolean;pauseSent?:boolean;
    };
    const context = new AsyncLocalStorage<Context>();
    let policyReader:(()=>Promise<ContinuationPolicyProof>)|undefined;
    const wrappers = new WeakMap<object, object>();
    function event(fd: number, value: unknown) { const bytes = Buffer.from(JSON.stringify({ at: new Date(now()).toISOString(), ...value as object }) + '\n'); let offset = 0; while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        if (n <= 0)
            throw Error('Canary receipt short write');
        offset += n;
    } fsyncSync(fd); }
    function claim(kind: string) { const release=canaryControlLock(stateDirectory);try{sameCanaryLatch(latch,permit.permitId,fileHash);return claimOwned(kind);}finally{release();} }
    function claimOwned(kind: string) { const fd = openSync(receipt, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try {
        event(fd, { status: kind, permitId: permit.permitId, workerKey: permit.workerKey, permitHash: fileHash });
        const d = openSync(receipts, 'r');
        try {
            fsyncSync(d);
        }
        finally {
            closeSync(d);
        }
        status = kind;
        return fd;
    }
    catch (e) {
        status = 'consumed-claim-error';
        closeSync(fd);
        throw e;
    } }
    function invalidate(reason: string) { if (status !== 'pending')
        return; try {
        const fd = claim('invalidated');
        try {
            event(fd, { reason });
        }
        finally {
            closeSync(fd);
        }
    }
    catch (e) {
        status = 'blocked-receipt';
        throw e;
    } }
    function validFile() { if (digest(privateFile(path)) !== fileHash)throw Error('Canary permit changed');
        const c=context.getStore();
        if(c?.ended||c?.abandoned)throw Error('Canary operation ended or was abandoned');
        if(permit.continuation&&c){if(!Number.isFinite(now())||!Number.isFinite(monotonicNow())||now()>=Date.parse(permit.continuation.operationDeadline)||c.monoDeadline===undefined||monotonicNow()>=c.monoDeadline)throw Error('Continuation total deadline expired');}
        else if(now()>=Date.parse(permit.expiresAt)||now()>=Date.parse(permit.holdClearance.expiresAt))throw Error('Canary permit/hold clearance expired');
    }
    async function freshPolicy(c:Context,allowCached=false){
        if(!permit.continuation)return;
        const valid=(proof:ContinuationPolicyProof|undefined)=>!!proof&&Number.isFinite(proof.checkedAt)&&proof.checkedAt<=now()&&now()-proof.checkedAt<=5000&&stableCanaryJSON(proof.binding)===stableCanaryJSON(permit.continuation!.policy);
        if(allowCached&&valid(c.policyProof))return;
        if(!policyReader)throw Error('Dedicated continuation policy reader unavailable');
        const proof=structuredClone(await policyReader());
        if(!valid(proof))throw Error('Continuation policy evidence stale or changed');
        c.policyProof=proof;validFile();
    }
    function sameAuthority(authority: WorkerChange['authority']) { return !!authority && JSON.stringify([authority.serverId, authority.authorizationId, authority.deploymentId]) === JSON.stringify([permit.authority.serverId, permit.authority.authorizationId, permit.authority.deploymentId]); }
    function observe(intent: CanaryIntent | undefined) { if (status !== 'pending')
        return; try {
        validFile();
        if (!intent || !intent.enabled || intent.token !== permit.desiredToken || !sameAuthority(intent.authority))
            invalidate('Desired authority/configuration disabled, missing or superseded');
    }
    catch (e) {
        invalidate(e instanceof Error ? e.message : 'Canary observation failed');
        throw e;
    } }
    function requireFreshPolicy(c:Context){if(permit.continuation&&(!c.policyProof||!Number.isFinite(c.policyProof.checkedAt)||c.policyProof.checkedAt>now()||now()-c.policyProof.checkedAt>5000||stableCanaryJSON(c.policyProof.binding)!==stableCanaryJSON(permit.continuation.policy)))throw Error('Continuation policy aged during final effect check');}
    async function finalCheck(c:Context){requireFreshPolicy(c);await c.runnable();requireFreshPolicy(c);validFile();if(!c.current())throw Error('Canary intent changed at effect boundary');}
    async function verify(c: Context) {
        validFile();
        if(permit.continuation){delete c.policyProof;await freshPolicy(c);}
        if (!c.current())
            throw Error('Canary desired intent was superseded or disabled');
        await c.runnable();
        if (!c.current())
            throw Error('Canary intent changed during hold check');
        if (!c.retired) {
            c.sourceVerified = false;
            const { agent } = await c.client.agent.get(permit.source.paneId);
            if (agent.pane_id !== permit.source.paneId || agent.cwd !== permit.source.cwd || agent.agent !== permit.source.provider || !['idle', 'done'].includes(agent.agent_status ?? '') || agent.interactive_ready !== true || nativeSessionHash(agent.agent_session) !== permit.source.sessionHash)
                throw Error('Canary source identity/session/status/clearance mismatch');
            c.sourceVerified = true;
        }
        await finalCheck(c);
    }
    async function target(c: Context) { if(permit.continuation){await assertClaudeTargetReady(permit.continuation.target,{getAgent:async pane=>(await c.client.agent.get(pane)).agent,readPrompt:async pane=>(c.client as any).pane.read({pane_id:pane,source:'detection',strip_ansi:true})},now);c.targetSession=permit.continuation.target.sessionHash;return;} if (!c.target)
        throw Error('No canary-owned target'); const { agent } = await c.client.agent.get(c.target); if (agent.pane_id !== c.target || agent.cwd !== permit.source.cwd || agent.agent !== permit.targetProvider)
        throw Error('Canary target identity changed'); const session = nativeSessionHash(agent.agent_session); if (!session || c.targetSession && session !== c.targetSession)
        throw Error('Canary target session changed or missing'); c.targetSession = session; }
    function wrap<T extends object>(raw: T): T {
        const existing = wrappers.get(raw);
        if (existing)
            return existing as T;
        const groups = new Map<PropertyKey, unknown>();
        const proxy = new Proxy(raw, { get(owner, group, receiver) {
                const value = Reflect.get(owner, group, receiver);
                if (group === 'raw' && value && typeof value === 'object')
                    return wrap(value);
                if (group === 'inner' || group === 'chokePoint')
                    throw Error('Canary does not expose unfenced RPC internals');
                if (group === 'call' && typeof value === 'function')
                    return (...args: unknown[]) => { if (!['agent.list', 'agent.get', 'pane.list', 'pane.read', 'workspace.list', 'workspace.get'].includes(String(args[0])))
                        throw Error('Canary blocks generic mutation RPC bypass'); return Reflect.apply(value, owner, args); };
                if (typeof group !== 'string' || !['agent', 'workspace', 'pane', 'tab', 'session', 'server', 'worktree', 'layout', 'plugin', 'integration', 'ui', 'events'].includes(group) || !value || typeof value !== 'object')
                    return typeof value==='function'?value.bind(owner):value;
                if (!groups.has(group))
                    groups.set(group, new Proxy(value, { get(surface, method) {
                            const fn = Reflect.get(surface, method);
                            if (typeof fn !== 'function')
                                return fn;
                            return async (...args: unknown[]) => {
                                const name = String(method), readOnly = ['list','get','read','explain','current','processInfo','wait','waitForOutput','snapshot','ping','agentManifests','graphicsInfo','neighbor','edges','selectionRead','linkResolve','subscribe','watch','status'].includes(name), replacement = !readOnly && !(group==='agent'&&name==='prompt'), c = context.getStore();
                                if ((replacement || permit.continuation&&group==='agent'&&name==='prompt') && !c)
                                    throw Error('Canary observational mode blocks all unpermitted replacement/stop paths');
                                if (c && (replacement || group === 'agent' && name === 'prompt')) {
                                    await verify(c);
                                    const p = args[0] as Record<string, unknown>;
                                    if(permit.continuation&&((group==='workspace'&&name==='create')||(group==='agent'&&name==='start')||(group==='pane'&&name==='close'&&args[0]!==permit.source.paneId)))throw Error('Continuation forbids target creation/start/cleanup');
                                    if (group === 'workspace' && name === 'create') {
                                        if (c.created || p.cwd !== permit.source.cwd)
                                            throw Error('Canary permits one exact target workspace');
                                        await finalCheck(c);
                                        c.created = true;
                                        event(c.fd, { status: 'rpc-attempt', group, method: name });
                                        const result = await Reflect.apply(fn, surface, args), id = typeof result.root_pane === 'string' ? result.root_pane : result.root_pane?.pane_id;
                                        if (typeof id !== 'string' || c.protectedPanes.has(id))
                                            throw Error('Canary target aliases an existing/human pane');
                                        c.target = id;
                                        event(c.fd, { status: 'target-created', pane: id });
                                        return result;
                                    }
                                    if (group === 'agent' && name === 'start') {
                                        if (c.started || !c.target || p.pane_id !== c.target || p.kind !== permit.targetProvider)
                                            throw Error('Canary permits one exact provider start');
                                        c.started = true;
                                    }
                                    else if (group === 'agent' && name === 'prompt') {
                                        if (p.target !== c.target)
                                            throw Error('Canary prompt target mismatch');
                                        await target(c);
                                        if(permit.continuation){
                                            if(c.retired){if(p.text!==WORKER_CANARY_KICKOFF||c.pauseSent)throw Error('Continuation permits one paused completion marker');c.pauseSent=true;}
                                            else {if(c.promptIndex===undefined||c.promptIndex!==((c.lastAck??-1)+1)||c.sentIndex===c.promptIndex||typeof p.text!=='string'||(c.promptIndex===0?!p.text.startsWith('Drovr owned-target continuation bootstrap.'):!p.text.startsWith('Drovr context handoff. This turn is ONLY')))throw Error('Continuation permits only one exact import prompt per ACK');c.sentIndex=c.promptIndex;}
                                        }
                                    }
                                    else if (group === 'pane' && name === 'close') {
                                        const id = args[0];
                                        if (id === permit.source.paneId && !c.retired) {
                                            if(permit.continuation&&(!c.progressCommitted||c.lastAck!==permit.continuation.snapshot.chunks))throw Error('Continuation retirement requires every native chunk ACK and commit');
                                            await target(c);
                                            await finalCheck(c);
                                            const committed = c.committed();
                                            if (committed?.paneId !== c.target || committed?.provider !== permit.targetProvider)
                                                throw Error('Canary source retirement requires acknowledged SDK commit');
                                            c.acknowledged = true;
                                            event(c.fd, { status: 'acknowledged-source-close-attempt', pane: id });
                                            c.sourceCloseAttempted = true;
                                            const result = await Reflect.apply(fn, surface, args);
                                            c.retired = true;
                                            event(c.fd, { status: 'source-retired', pane: id });
                                            return result;
                                        }
                                        if (id !== c.target || c.closedTarget || c.acknowledged || c.committed()?.paneId === c.target)
                                            throw Error('Canary close does not own exact pane');
                                        await target(c);
                                        await finalCheck(c);
                                        event(c.fd, { status: 'target-cleanup-attempt', pane: id });
                                        const result = await Reflect.apply(fn, surface, args);
                                        c.closedTarget = true;
                                        event(c.fd, { status: 'target-closed', pane: id });
                                        return result;
                                    }
                                    else
                                        throw Error('Canary forbids this replacement/keyboard path');
                                }
                                if (c && (replacement || group === 'agent' && name === 'prompt')){await finalCheck(c);event(c.fd, { status: 'rpc-attempt', group, method: name });}
                                return Reflect.apply(fn, surface, args);
                            };
                        } }));
                return groups.get(group);
            } });
        wrappers.set(raw, proxy);
        wrappers.set(proxy, proxy);
        return proxy;
    }
    async function run(client: RpcClient, change: WorkerChange, current: () => boolean, runnable: () => Promise<void>, action: () => Promise<WorkerChangeResult>, committed: () => {
        paneId: string;
        provider: string;
    } | undefined): Promise<WorkerChangeResult> {
        if (change.id !== permit.workerKey)
            throw Error('Worker is outside the explicit canary permit');
        if (status !== 'pending')
            throw Error('Canary attempt already consumed; inspection/new approval required');
        if(permit.continuation)validFile();
        const fd = claim('claimed');
        const c: Context = { client, current, runnable, fd, retired: false, sourceVerified: false, sourceCloseAttempted: false, created: false, started: false, closedTarget: false, acknowledged: false, committed, protectedPanes: new Set() };
        if(permit.continuation){c.target=permit.continuation.target.paneId;c.targetSession=permit.continuation.target.sessionHash;c.monoDeadline=monotonicNow()+Date.parse(permit.continuation.operationDeadline)-now();c.lastAck=-1;}
        try {
            return await context.run(c, async () => {
                if (change.token !== permit.desiredToken || !sameAuthority(change.authority) || change.spec.key !== permit.workerKey || change.spec.agents?.[0]?.harness !== permit.targetProvider)
                    throw Error('Canary authority/configuration/desired provider mismatch');
                await verify(c);
                const { panes } = await client.pane.list();
                c.protectedPanes = new Set(panes.map(p => p.pane_id));
                if(permit.continuation){if(!c.protectedPanes.has(permit.continuation.target.paneId))throw Error('Continuation target missing from complete census');await target(c);event(fd,{status:'continuation-target-bound',pane:c.target,sessionHash:c.targetSession});}
                if (!c.protectedPanes.has(permit.source.paneId))
                    throw Error('Canary source pane absent from complete census');
                await finalCheck(c);
            const result = await action();
                const settled = result.status === 'blocked' && c.target && !c.closedTarget ? { ...result, partial: true } : result;
                status = settled.status;
                event(fd, { status: 'terminal', result: settled, retired: c.retired, target: c.target ?? null,...(permit.continuation?{lastAcknowledged:c.lastAck,committed:c.progressCommitted===true}: {}) });
                return settled;
            });
        }
        catch (e) {
            status = 'blocked';
            let reason = e instanceof Error ? e.message : 'Canary attempt failed';
            let committed: ReturnType<Context['committed']>;
            try {
                committed = c.committed();
            }
            catch {
                reason += '; committed identity unavailable';
            }
            const physical = committed?.paneId === c.target && committed?.provider === permit.targetProvider ? committed : c.acknowledged && c.target ? { paneId: c.target, provider: permit.targetProvider } : c.sourceCloseAttempted || !c.sourceVerified ? undefined : { paneId: permit.source.paneId, provider: permit.source.provider };
            try {
                event(fd, { status: 'blocked', reason, retired: c.retired, retirementAttempted: c.sourceCloseAttempted, retirementUnknown: c.sourceCloseAttempted && !c.retired, current: physical ?? null, target: c.target ?? null });
            }
            catch {
                reason += '; canary receipt persistence failed';
            }
            return { status: 'blocked', reason, partial: !!permit.continuation || c.created && !c.closedTarget, ...(physical ? { current: physical } : {}) };
        }
        finally {
            c.ended=true;closeSync(fd);
        }
    }
    const continuationRequest=():OwnedTargetContinuation|undefined=>{
        const spec=permit.continuation;if(!spec)return undefined;
        return {target:{paneId:spec.target.paneId,provider:'claude',cwd:spec.target.cwd},sourceSessionHash:permit.source.sessionHash,targetSessionHash:spec.target.sessionHash,snapshot:{sha256:spec.snapshot.sha256,bytes:spec.snapshot.bytes,chars:spec.snapshot.chars},operationDeadline:Date.parse(spec.operationDeadline),progress:async(e:ContinuationProgress)=>{
            const c=context.getStore();if(!c||c.ended)throw Error('Continuation progress outside owned live transaction');
            if(e.sourceSHA256!==spec.snapshot.sha256||e.total!==spec.snapshot.chunks+1||!Number.isSafeInteger(e.index)||e.index<0||e.index>e.total)throw Error('Continuation progress binding differs');
            if(e.phase==='blocked'){c.abandoned=true;event(c.fd,{status:'continuation-progress',...e});return;}
            validFile();
            if(e.phase==='prompt-attempt'){if(e.index!==(c.lastAck??-1)+1||c.promptIndex===e.index)throw Error('Repeated or out-of-order continuation prompt');c.promptIndex=e.index;}
            if(e.phase==='acknowledged'){if(e.index!==c.promptIndex||e.index!==(c.lastAck??-1)+1||c.sentIndex!==e.index)throw Error('Unproven or repeated continuation ACK');c.lastAck=e.index;}
            if(e.phase==='committed'){if(c.lastAck!==spec.snapshot.chunks||!e.committed||c.committed()?.paneId!==spec.target.paneId)throw Error('Continuation commit lacks full ACK evidence');c.progressCommitted=true;}
            event(c.fd,{status:'continuation-progress',...e});
        }};
    };
    return { continuationRequest,continuationSpec:()=>permit.continuation?structuredClone({...permit.continuation,source:permit.source,authority:permit.authority,desiredToken:permit.desiredToken}):undefined,installContinuationPolicyReader:(reader:()=>Promise<ContinuationPolicyProof>)=>{if(!permit.continuation||policyReader||!['pending','consumed-before-this-process'].includes(status))throw Error('Continuation policy reader cannot be replaced');if(status==='pending')policyReader=reader;},workerKey: permit.workerKey, wrap, run, observe, summary: () => ({ mode: 'one-attempt' as const, permitId: permit.permitId, workerKey: permit.workerKey, status, receipt, permitHash: fileHash }), assertOrdinaryAllowed: () => { throw Error('Explicit canary mode fences ordinary spawn/stop/respawn; only the named reconciliation attempt is permitted'); } };
}
export type WorkerRollout = ReturnType<typeof createWorkerRollout>;
/** Removing an environment flag alone cannot silently remove a previously armed fence. */
export function configuredWorkerRollout(path: string | undefined, stateDirectory: string) {
    if(verifyValidationRetirement(stateDirectory,path))return undefined;
    if (path !== undefined)
        return createWorkerRollout(path, stateDirectory);
    try {
        lstatSync(join(stateDirectory, 'worker-canary-mode.json'));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw e;
    }
    throw Error('Canary mode remains durably latched; explicit reviewed retirement required before steady-state restart');
}
/** The daemon gives every watcher and Herd the SAME fenced client. */
export function daemonWorkerClient<T extends object>(client: T, rollout: WorkerRollout | undefined) { return rollout ? rollout.wrap(client) : client; }

/** A validation canary never resumes product work merely because import completed. */
export const WORKER_CANARY_KICKOFF='CANARY_HANDOFF_COMPLETE. Preserve all prior work, history and holds. This was a validation-only provider handoff. Do not execute project work or answer pending approvals. Wait for the coordinator to explicitly release the canary hold.';


export interface CanaryRenewalSnapshot{
 checkedAt:number; enabled:boolean; notHeld:boolean; desiredToken:string; targetProvider:CanaryPermit['targetProvider'];
 authority:CanaryPermit['authority']; source:CanaryPermit['source'];
}
export interface CanaryRenewalRequest{
 previousPath:string; nextPath:string; stateDirectory:string; next:CanaryPermit;
 /** Must independently inspect the actual service AND competing process state; unknown throws. */
 assertStopped:()=>Promise<void>;
 /** Fresh real identity/intent/hold inspection, not a user-supplied self-attestation. */
 inspect:()=>Promise<CanaryRenewalSnapshot>;
}
const stableCanaryJSON=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
/** Explicit offline operator transition. Same grant; no fence retirement or new attempt budget.
 * Must be separately reviewed before live use. Original files/claims are never removed.
 */
export async function renewExpiredWorkerPermit(request:CanaryRenewalRequest,now=()=>Date.now()){
 const {previousPath,nextPath,stateDirectory}=request;
 if(!isAbsolute(stateDirectory)||realpathSync(stateDirectory)!==stateDirectory)throw Error('Unsafe renewal state directory');
 const state=lstatSync(stateDirectory);if(!state.isDirectory()||state.uid!==process.getuid?.()||(state.mode&0o077))throw Error('Unsafe renewal state directory');
 if(!isAbsolute(nextPath)||realpathSync(dirname(nextPath))!==dirname(nextPath)||nextPath===previousPath)throw Error('Renewal requires a new canonical permit path');
 const parent=lstatSync(dirname(nextPath));if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077))throw Error('Unsafe renewal permit parent');
 const release=canaryControlLock(stateDirectory);let uncertain=false;
 try{
  const oldText=privateFile(previousPath),previous=parsePermit(oldText),oldHash=digest(oldText);
  const next=structuredClone(request.next),newText=JSON.stringify(next)+'\n';parsePermit(newText);
  // Exact comparison covers every original/unknown field, allowing ONLY these two times.
  const binding=(p:CanaryPermit)=>{const x=structuredClone(p);delete (x as Partial<CanaryPermit>).expiresAt;delete (x.holdClearance as Partial<CanaryPermit['holdClearance']>).expiresAt;return stableCanaryJSON(x);};
  if(binding(previous)!==binding(next))throw Error('Renewal changed exact permit binding');
  const latch=join(stateDirectory,'worker-canary-mode.json'),claim=join(stateDirectory,'worker-canary-attempts',previous.permitId+'.jsonl');
  const receipts=lstatSync(dirname(claim));if(!receipts.isDirectory()||receipts.isSymbolicLink()||receipts.uid!==process.getuid?.()||(receipts.mode&0o077))throw Error('Unsafe renewal attempt directory');
  const noAttempt=()=>{try{lstatSync(claim);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Consumed or uncertain attempt cannot be renewed');};
  const validateTime=()=>{const t=now();if(t<Date.parse(previous.expiresAt))throw Error('Only an expired permit may be renewed');if(Date.parse(next.expiresAt)<=t||Date.parse(next.holdClearance.expiresAt)<=t||Date.parse(next.expiresAt)>t+20*60_000||Date.parse(next.holdClearance.expiresAt)>Date.parse(next.expiresAt))throw Error('Fresh bounded permit and hold clearance required');};
  const check=async()=>{
   sameCanaryLatch(latch,previous.permitId,oldHash);noAttempt();validateTime();
   await request.assertStopped();const snapshot=structuredClone(await request.inspect());
   if(!Number.isFinite(snapshot.checkedAt)||snapshot.checkedAt>now()||now()-snapshot.checkedAt>5000||!snapshot.enabled||!snapshot.notHeld||snapshot.desiredToken!==previous.desiredToken||snapshot.targetProvider!==previous.targetProvider||stableCanaryJSON(snapshot.authority)!==stableCanaryJSON(previous.authority)||stableCanaryJSON(snapshot.source)!==stableCanaryJSON(previous.source))throw Error('Fresh exact renewal identity/intent/hold proof required');
   sameCanaryLatch(latch,previous.permitId,oldHash);noAttempt();validateTime();
  };
  await check();
  const archives=join(stateDirectory,'worker-canary-renewals');try{mkdirSync(archives,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const archiveStat=lstatSync(archives);if(!archiveStat.isDirectory()||archiveStat.isSymbolicLink()||archiveStat.uid!==process.getuid?.()||(archiveStat.mode&0o077))throw Error('Unsafe renewal archive');
  const archive=join(archives,oldHash+'.json'),newHash=digest(newText),oldLatch=privateFile(latch);
  // From first write onward, an error leaves the control lock as a durable fail-closed barrier.
  uncertain=true;
  newCanaryFile(archive,JSON.stringify({version:1,at:new Date(now()).toISOString(),previousPath,nextPath,previousPermit:oldText,previousLatch:oldLatch,nextPermit:newText,previousHash:oldHash,nextHash:newHash})+'\n');
  newCanaryFile(nextPath,newText);
  await check();
  if(privateFile(previousPath)!==oldText||privateFile(nextPath)!==newText||privateFile(latch)!==oldLatch)throw Error('Renewal evidence changed');
  const temporary=join(stateDirectory,'.worker-canary-renewal-'+randomUUID());newCanaryFile(temporary,JSON.stringify({permitId:previous.permitId,permitHash:newHash})+'\n');
  renameSync(temporary,latch);syncCanaryDirectory(stateDirectory);
  sameCanaryLatch(latch,previous.permitId,newHash);
  newCanaryFile(archive+'.complete',JSON.stringify({version:1,at:new Date(now()).toISOString(),permitId:previous.permitId,previousHash:oldHash,nextHash:newHash})+'\n');
  uncertain=false;return {permitId:previous.permitId,previousHash:oldHash,nextHash:newHash,nextPath,archive,attemptBudget:1 as const,fenceLatched:true as const};
 }finally{if(!uncertain)release();else release.abandon();}
}

export interface PreservedPartialTargetIdentity {
    paneId: string; workspaceId: string; terminalId: string; cwd: string;
    bootId: string; pid: number; startTicks: string; executableSHA256: string;
}
export interface PreservedPartialTargetSnapshot {
    checkedAt: number; identity: PreservedPartialTargetIdentity;
    allThreadsStopped: boolean; noChildren: boolean; soleProcessGroupMember: boolean;
    noRegisteredAgent: boolean; blankVisiblePane: boolean; noUnaccountedLaunch: boolean;
}
export interface PreservedPartialTarget {
    identity: PreservedPartialTargetIdentity;
    /** Immutable ancestor receipts remain independently pinned as well as the immediate predecessor. */
    ancestorReceipts: { path: string; sha256: string }[];
    inspect: () => Promise<PreservedPartialTargetSnapshot>;
}
export interface CanaryReplacementRequest extends CanaryRenewalRequest {
    /** Exact reviewed predecessor evidence, not a search for any failed attempt. */
    previousPermitSHA256: string;
    previousReceiptSHA256: string;
    /** Audit reference only. The operator must obtain explicit new-budget approval. */
    approvalReference: string;
    /** Explicit exception only for an owned, preserved and physically frozen pre-ACK target. */
    preservedPartialTarget?: PreservedPartialTarget;
}

function canaryEvidence(path: string) {
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) throw Error('Canonical evidence path required');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) || before.nlink !== 1 || before.size > 16384) throw Error('Unsafe bounded private evidence');
        const text = readFileSync(fd, 'utf8'), after = fstatSync(fd);
        const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink];
        if (stableCanaryJSON(identity(before)) !== stableCanaryJSON(identity(after))) throw Error('Evidence changed during read');
        return { text, identity: identity(after) };
    } finally { closeSync(fd); }
}

/** Explicit new budget after a proven pre-target failure; never a renewal or daemon path.
 * Old permits/receipts are immutable, all writes are absent-only except atomic latched-mode
 * replacement, and uncertainty leaves the shared control lock in place. Approval must be
 * obtained by the operator for these exact hashes and new permit ID before invocation.
 */
export async function issueReplacementWorkerPermit(request: CanaryReplacementRequest, now = () => Date.now()) {
    const { previousPath, nextPath, stateDirectory, previousPermitSHA256, previousReceiptSHA256, approvalReference, assertStopped, inspect } = request;
    const preserved = request.preservedPartialTarget ? {
        identity: structuredClone(request.preservedPartialTarget.identity),
        ancestorReceipts: structuredClone(request.preservedPartialTarget.ancestorReceipts),
        inspect: request.preservedPartialTarget.inspect,
    } : undefined;
    const next = structuredClone(request.next), newText = JSON.stringify(next) + '\n';
    if (![previousPermitSHA256, previousReceiptSHA256].every(x => /^[a-f0-9]{64}$/.test(x)) || typeof approvalReference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:./ -]{0,255}$/.test(approvalReference)) throw Error('Exact predecessor hashes and new-budget approval reference required');
    const privateDirectory = (path: string) => {
        if (!isAbsolute(path) || realpathSync(path) !== path) throw Error('Canonical private replacement directory required');
        const s = lstatSync(path);
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw Error('Unsafe replacement directory');
    };
    privateDirectory(stateDirectory);
    if (!isAbsolute(nextPath) || nextPath === previousPath || dirname(nextPath) !== dirname(previousPath)) throw Error('New permit requires a distinct path in the original private permit directory');
    privateDirectory(dirname(nextPath));
    const release = canaryControlLock(stateDirectory);
    let uncertain = false;
    try {
        const oldPermit = canaryEvidence(previousPath), previous = parsePermit(oldPermit.text);
        if (digest(oldPermit.text) !== previousPermitSHA256) throw Error('Reviewed previous permit differs');
        parsePermit(newText);
        if (next.permitId === previous.permitId) throw Error('Consumed permit ID cannot be reused');
        const binding = (p: CanaryPermit) => {
            const copy = structuredClone(p);
            delete (copy as Partial<CanaryPermit>).permitId;
            delete (copy as Partial<CanaryPermit>).expiresAt;
            delete (copy.holdClearance as Partial<CanaryPermit['holdClearance']>).expiresAt;
            return stableCanaryJSON(copy);
        };
        if (binding(previous) !== binding(next)) throw Error('Replacement changed exact source, intent or authority binding');
        const receipts = join(stateDirectory, 'worker-canary-attempts');
        privateDirectory(receipts);
        const claimPath = join(receipts, previous.permitId + '.jsonl'), nextClaim = join(receipts, next.permitId + '.jsonl');
        const oldClaim = canaryEvidence(claimPath);
        if (digest(oldClaim.text) !== previousReceiptSHA256 || !oldClaim.text.endsWith('\n')) throw Error('Reviewed complete receipt differs');
        const lines = oldClaim.text.slice(0, -1).split('\n');
        const events = lines.map(line => JSON.parse(line));
        const claimed = events[0], terminal = events.at(-1);
        const exactKeys = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
        const ancestors: { path: string; evidence: ReturnType<typeof canaryEvidence>; sha256: string }[] = [];
        if (!preserved) {
            if (lines.length !== 2) throw Error('Only a proven pre-target terminal attempt can receive a new budget');
        } else {
            const i = preserved.identity;
            if (!i || !exactKeys(i, ['paneId','workspaceId','terminalId','cwd','bootId','pid','startTicks','executableSHA256']) || !/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(i.paneId) || i.workspaceId !== i.paneId.split(':')[0] || !i.terminalId || i.cwd !== previous.source.cwd || i.paneId === previous.source.paneId || !uuid(i.bootId) || !Number.isSafeInteger(i.pid) || i.pid <= 1 || !/^[0-9]+$/.test(i.startTicks) || !/^[a-f0-9]{64}$/.test(i.executableSHA256)) throw Error('Exact owned preserved target identity required');
            if (events.length !== 5) throw Error('Preserved target requires the exact five-event pre-ACK receipt');
            const [, create, target, start] = events;
            if (!exactKeys(create,['at','status','group','method']) || create.status !== 'rpc-attempt' || create.group !== 'workspace' || create.method !== 'create' || !exactKeys(target,['at','status','pane']) || target.status !== 'target-created' || target.pane !== i.paneId || !exactKeys(start,['at','status','group','method']) || start.status !== 'rpc-attempt' || start.group !== 'agent' || start.method !== 'start') throw Error('Preserved target receipt contains uncertain effects');
            const times = events.map(e => typeof e.at === 'string' ? Date.parse(e.at) : NaN);
            if (times.some((t,n) => !Number.isFinite(t) || t > now() || n > 0 && t < times[n-1]!)) throw Error('Preserved target chronology is uncertain');
            if (!Array.isArray(preserved.ancestorReceipts) || preserved.ancestorReceipts.length !== 1) throw Error('Exact original spent receipt must remain pinned');
            for (const a of preserved.ancestorReceipts) {
                if (dirname(a.path) !== receipts || a.path === claimPath || a.path === nextClaim || !/^[a-f0-9]{64}$/.test(a.sha256)) throw Error('Invalid preserved ancestor receipt binding');
                const evidence = canaryEvidence(a.path);
                if (digest(evidence.text) !== a.sha256) throw Error('Original spent receipt differs');
                ancestors.push({path:a.path,evidence,sha256:a.sha256});
            }
        }
        if (!exactKeys(claimed, ['at', 'status', 'permitId', 'workerKey', 'permitHash']) || claimed.status !== 'claimed' || claimed.permitId !== previous.permitId || claimed.workerKey !== previous.workerKey || claimed.permitHash !== previousPermitSHA256) throw Error('Uncertain or mismatched original consumption');
        if (!exactKeys(terminal, ['at', 'status', 'result', 'retired', 'target']) || terminal.status !== 'terminal' || terminal.retired !== false || terminal.target !== (preserved ? preserved.identity.paneId : null) || !exactKeys(terminal.result, ['status', 'reason', 'partial', 'current']) || terminal.result.status !== 'blocked' || terminal.result.partial !== !!preserved || typeof terminal.result.reason !== 'string' || terminal.result.reason.length === 0) throw Error('Uncertain effects, target or retirement forbid replacement');
        const original = terminal.result.current;
        if (preserved && original === undefined) throw Error('Preserved target requires proven original current identity');
        if (original !== undefined && (!exactKeys(original, ['paneId', 'provider']) || original.paneId !== previous.source.paneId || original.provider !== previous.source.provider)) throw Error('Original surviving identity differs');
        const startedAt = typeof claimed.at === 'string' ? Date.parse(claimed.at) : NaN, endedAt = typeof terminal.at === 'string' ? Date.parse(terminal.at) : NaN;
        if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt || endedAt > now()) throw Error('Original terminal chronology is uncertain');
        const latch = join(stateDirectory, 'worker-canary-mode.json'), oldLatch = canaryEvidence(latch);
        const unchanged = (path: string, expected: ReturnType<typeof canaryEvidence>) => {
            const actual = canaryEvidence(path);
            if (actual.text !== expected.text || stableCanaryJSON(actual.identity) !== stableCanaryJSON(expected.identity)) throw Error('Replacement predecessor evidence changed');
        };
        const absent = (path: string) => { try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw Error('Replacement output or new receipt already exists'); };
        const validateTime = () => { const t = now(); if (!Number.isFinite(t)) throw Error('Unknown replacement clock'); if (Date.parse(next.expiresAt) <= t || Date.parse(next.holdClearance.expiresAt) <= t || Date.parse(next.expiresAt) > t + 20 * 60_000 || Date.parse(next.holdClearance.expiresAt) > Date.parse(next.expiresAt)) throw Error('Fresh bounded replacement permit/clearance required'); };
        const validateSnapshot = (snapshot: CanaryRenewalSnapshot) => {
            if (!Number.isFinite(snapshot.checkedAt) || snapshot.checkedAt > now() || now() - snapshot.checkedAt > 5000 || !Number.isFinite(now()) || snapshot.enabled !== true || snapshot.notHeld !== true || snapshot.desiredToken !== previous.desiredToken || snapshot.targetProvider !== previous.targetProvider || stableCanaryJSON(snapshot.authority) !== stableCanaryJSON(previous.authority) || stableCanaryJSON(snapshot.source) !== stableCanaryJSON(previous.source)) throw Error('Fresh exact replacement identity/intent/hold proof required');
        };
        let preservedProof: PreservedPartialTargetSnapshot | undefined;
        const inspectPreserved = async () => {
            if (!preserved) return;
            const proof = structuredClone(await preserved.inspect());
            if (!Number.isFinite(proof.checkedAt) || proof.checkedAt > now() || now()-proof.checkedAt > 5000 || stableCanaryJSON(proof.identity) !== stableCanaryJSON(preserved.identity) || proof.allThreadsStopped !== true || proof.noChildren !== true || proof.soleProcessGroupMember !== true || proof.noRegisteredAgent !== true || proof.blankVisiblePane !== true || proof.noUnaccountedLaunch !== true) throw Error('Fresh physically frozen preserved target proof required');
            for (const a of ancestors) unchanged(a.path,a.evidence);
            preservedProof = proof;
        };
        const check = async () => {
            sameCanaryLatch(latch, previous.permitId, previousPermitSHA256);
            unchanged(previousPath, oldPermit); unchanged(claimPath, oldClaim); unchanged(latch, oldLatch); absent(nextClaim); validateTime();
            await assertStopped();
            const snapshot = structuredClone(await inspect());
            validateSnapshot(snapshot);
            await inspectPreserved();
            validateSnapshot(snapshot);
            sameCanaryLatch(latch, previous.permitId, previousPermitSHA256);
            unchanged(previousPath, oldPermit); unchanged(claimPath, oldClaim); unchanged(latch, oldLatch); absent(nextClaim); validateTime();
            return snapshot;
        };
        absent(nextPath);
        await check();
        const archives = join(stateDirectory, 'worker-canary-replacements');
        try { mkdirSync(archives, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        privateDirectory(archives);
        const archive = join(archives, previous.permitId + '-' + previousReceiptSHA256 + '.json'), nextHash = digest(newText);
        absent(archive); absent(archive + '.complete');
        uncertain = true;
        newCanaryFile(archive, JSON.stringify({ version: 1, kind: 'explicit-new-budget', at: new Date(now()).toISOString(), approvalReference, previousPath, nextPath, previousPermit: oldPermit.text, previousReceipt: oldClaim.text, previousLatch: oldLatch.text, nextPermit: newText, previousPermitSHA256, previousReceiptSHA256, nextHash, ...(preserved ? {preservedTarget:preserved.identity, preservedProof, ancestorReceipts:ancestors.map(a=>({path:a.path,sha256:a.sha256,text:a.evidence.text}))} : {}) }) + '\n');
        newCanaryFile(nextPath, newText);
        const snapshot = await check();
        if (privateFile(nextPath) !== newText) throw Error('New permit changed');
        const temporary = join(stateDirectory, '.worker-canary-replacement-' + randomUUID());
        newCanaryFile(temporary, JSON.stringify({ permitId: next.permitId, permitHash: nextHash }) + '\n');
        await inspectPreserved();
        validateSnapshot(snapshot); validateTime();
        sameCanaryLatch(latch, previous.permitId, previousPermitSHA256);
        unchanged(previousPath, oldPermit); unchanged(claimPath, oldClaim); unchanged(latch, oldLatch); absent(nextClaim);
        renameSync(temporary, latch); syncCanaryDirectory(stateDirectory);
        sameCanaryLatch(latch, next.permitId, nextHash);
        newCanaryFile(archive + '.complete', JSON.stringify({ version: 1, approvalReference, at: new Date(now()).toISOString(), previousPermitId: previous.permitId, nextPermitId: next.permitId, previousPermitSHA256, previousReceiptSHA256, nextHash, attemptBudget: 1, fenceLatched: true }) + '\n');
        uncertain = false;
        return { previousPermitId: previous.permitId, permitId: next.permitId, nextHash, nextPath, archive, attemptBudget: 1 as const, fenceLatched: true as const };
    } finally { if (uncertain) release.abandon(); else release(); }
}

export interface ExistingTargetContinuationProof {
 checkedAt:number;target:NonNullable<CanaryPermit['continuation']>['target'];ready:true;
 policy:ContinuationPolicyProof;history:{sha256:string;bytes:number;chars:number;chunks:number};
}
export interface ContinuationPermitRequest extends CanaryRenewalRequest {
 previousPermitSHA256:string;previousReceiptSHA256:string;approvalReference:string;
 ancestorReceipts:{path:string;sha256:string}[];
 /** Fresh registered identity, full same-source history fit and configured policy reads. */
 inspectExisting:()=>Promise<ExistingTargetContinuationProof>;
}
/** New, append-only budget for an already registered target. Never a renewal,
 * orphan exception, history importer or reset of either consumed receipt. */
export async function issueExistingTargetContinuationPermit(request:ContinuationPermitRequest,now=()=>Date.now()){
 const r={...request,next:structuredClone(request.next),ancestorReceipts:structuredClone(request.ancestorReceipts)};
 const privateDir=(p:string)=>{if(!isAbsolute(p)||realpathSync(p)!==p)throw Error('Canonical continuation directory required');const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw Error('Private owned continuation directory required');};
 privateDir(r.stateDirectory);privateDir(dirname(r.previousPath));
 if(!isAbsolute(r.nextPath)||r.nextPath===r.previousPath||dirname(r.nextPath)!==dirname(r.previousPath)||![r.previousPermitSHA256,r.previousReceiptSHA256].every(x=>/^[a-f0-9]{64}$/.test(x))||!r.approvalReference||r.approvalReference.length>256)throw Error('Exact reviewed predecessor and distinct approved continuation required');
 const nextText=JSON.stringify(r.next)+'\n';parsePermit(nextText);const spec=r.next.continuation;
 if(r.next.version!==2||!spec)throw Error('Explicit existing-target version2 permit required');
 const release=canaryControlLock(r.stateDirectory);let uncertain=false;
 try{
  const previousEvidence=canaryEvidence(r.previousPath),previous=parsePermit(previousEvidence.text);
  if(previous.version!==1||digest(previousEvidence.text)!==r.previousPermitSHA256||previous.permitId===r.next.permitId)throw Error('Reviewed consumed legacy predecessor required');
  const binding=(p:CanaryPermit)=>{const q=structuredClone(p);delete(q as Partial<CanaryPermit>).version;delete(q as Partial<CanaryPermit>).permitId;delete(q as Partial<CanaryPermit>).expiresAt;delete q.continuation;delete(q.holdClearance as Partial<CanaryPermit['holdClearance']>).expiresAt;return stableCanaryJSON(q);};
  if(binding(previous)!==binding(r.next))throw Error('Continuation changed original source/intent/authority binding');
  const receipts=join(r.stateDirectory,'worker-canary-attempts');privateDir(receipts);
  const claimPath=join(receipts,previous.permitId+'.jsonl'),nextClaim=join(receipts,r.next.permitId+'.jsonl'),claim=canaryEvidence(claimPath);
  if(digest(claim.text)!==r.previousReceiptSHA256||!claim.text.endsWith('\n'))throw Error('Complete reviewed spent receipt required');
  const events=claim.text.slice(0,-1).split('\n').map(s=>JSON.parse(s));
  const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
  const [first,create,target,start,terminal]=events;
  if(events.length!==5||!exact(first,['at','status','permitId','workerKey','permitHash'])||first.status!=='claimed'||first.permitId!==previous.permitId||first.workerKey!==previous.workerKey||first.permitHash!==r.previousPermitSHA256||!exact(create,['at','status','group','method'])||create.status!=='rpc-attempt'||create.group!=='workspace'||create.method!=='create'||!exact(target,['at','status','pane'])||target.status!=='target-created'||target.pane!==spec.target.paneId||!exact(start,['at','status','group','method'])||start.status!=='rpc-attempt'||start.group!=='agent'||start.method!=='start'||!exact(terminal,['at','status','result','retired','target'])||terminal.status!=='terminal'||terminal.retired!==false||terminal.target!==spec.target.paneId||!exact(terminal.result,['status','reason','partial','current'])||terminal.result.status!=='blocked'||terminal.result.partial!==true||typeof terminal.result.reason!=='string'||!terminal.result.reason||!exact(terminal.result.current,['paneId','provider'])||terminal.result.current.paneId!==previous.source.paneId||terminal.result.current.provider!==previous.source.provider)throw Error('Exact known pre-ACK partial-target receipt required; unknown effects forbid continuation');
  const times=events.map(e=>Date.parse(e.at));if(times.some((t,i)=>!Number.isFinite(t)||t>now()||i>0&&t<times[i-1]!))throw Error('Uncertain predecessor chronology');
  if(r.ancestorReceipts.length!==1)throw Error('Original spent receipt must remain independently pinned');
  const ancestors=r.ancestorReceipts.map(a=>{if(dirname(a.path)!==receipts||a.path===claimPath||a.path===nextClaim||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('Invalid original spent receipt identity');const evidence=canaryEvidence(a.path);if(digest(evidence.text)!==a.sha256)throw Error('Original spent receipt changed');return {...a,evidence};});
  const latch=join(r.stateDirectory,'worker-canary-mode.json'),oldLatch=canaryEvidence(latch);
  const unchanged=(p:string,e:ReturnType<typeof canaryEvidence>)=>{const a=canaryEvidence(p);if(a.text!==e.text||stableCanaryJSON(a.identity)!==stableCanaryJSON(e.identity))throw Error('Immutable continuation predecessor changed');};
  const absent=(p:string)=>{try{lstatSync(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Continuation output or attempt already exists');};
  const fresh=(t:number)=>Number.isFinite(t)&&Number.isFinite(now())&&t<=now()&&now()-t<=5000;
  const validateTime=()=>{const t=now();if(!Number.isFinite(t)||Date.parse(spec.issuedAt)>t||t-Date.parse(spec.issuedAt)>20*60_000||Date.parse(r.next.expiresAt)<=t||Date.parse(r.next.expiresAt)>t+20*60_000||Date.parse(r.next.holdClearance.expiresAt)<=t)throw Error('Fresh short continuation admission required');};
  const validateSource=(p:CanaryRenewalSnapshot)=>{if(!fresh(p.checkedAt)||p.enabled!==true||p.notHeld!==true||p.desiredToken!==previous.desiredToken||p.targetProvider!==previous.targetProvider||stableCanaryJSON(p.authority)!==stableCanaryJSON(previous.authority)||stableCanaryJSON(p.source)!==stableCanaryJSON(previous.source))throw Error('Fresh exact source/intent/hold proof required');};
  const validateTarget=(p:ExistingTargetContinuationProof)=>{if(!fresh(p.checkedAt)||p.ready!==true||stableCanaryJSON(p.target)!==stableCanaryJSON(spec.target)||!fresh(p.policy.checkedAt)||stableCanaryJSON(p.policy.binding)!==stableCanaryJSON(spec.policy)||stableCanaryJSON(p.history)!==stableCanaryJSON(spec.snapshot))throw Error('Fresh exact target/history/policy proof required');};
  const staticCheck=()=>{sameCanaryLatch(latch,previous.permitId,r.previousPermitSHA256);unchanged(r.previousPath,previousEvidence);unchanged(claimPath,claim);unchanged(latch,oldLatch);for(const a of ancestors)unchanged(a.path,a.evidence);absent(nextClaim);validateTime();};
  const check=async()=>{staticCheck();await r.assertStopped();const source=structuredClone(await r.inspect()),target=structuredClone(await r.inspectExisting());validateSource(source);validateTarget(target);staticCheck();return {source,target};};
  absent(r.nextPath);const before=await check();
  const archives=join(r.stateDirectory,'worker-canary-continuations');try{mkdirSync(archives,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}privateDir(archives);
  const archive=join(archives,previous.permitId+'-'+r.next.permitId+'.json'),nextHash=digest(nextText);absent(archive);absent(archive+'.complete');
  uncertain=true;
  newCanaryFile(archive,JSON.stringify({version:1,kind:'explicit-existing-target-continuation',at:new Date(now()).toISOString(),approvalReference:r.approvalReference,previousPath:r.previousPath,nextPath:r.nextPath,previousPermit:previousEvidence.text,previousReceipt:claim.text,previousLatch:oldLatch.text,ancestorReceipts:ancestors.map(a=>({path:a.path,sha256:a.sha256,text:a.evidence.text})),nextPermit:nextText,nextHash,before})+'\n');
  newCanaryFile(r.nextPath,nextText);const after=await check();
  if(privateFile(r.nextPath)!==nextText)throw Error('New continuation permit changed');
  const temp=join(r.stateDirectory,'.worker-continuation-'+randomUUID());newCanaryFile(temp,JSON.stringify({permitId:r.next.permitId,permitHash:nextHash})+'\n');
  // No awaits after this freshness and predecessor check through atomic latch publication.
  validateSource(after.source);validateTarget(after.target);staticCheck();
  renameSync(temp,latch);syncCanaryDirectory(r.stateDirectory);sameCanaryLatch(latch,r.next.permitId,nextHash);
  newCanaryFile(archive+'.complete',JSON.stringify({version:1,at:new Date(now()).toISOString(),approvalReference:r.approvalReference,previousPermitId:previous.permitId,permitId:r.next.permitId,nextHash,attemptBudget:1,fenceLatched:true,targetPreserved:true})+'\n');
  uncertain=false;return {permitId:r.next.permitId,nextPath:r.nextPath,nextHash,archive,attemptBudget:1 as const,fenceLatched:true as const};
 }finally{if(uncertain)release.abandon();else release();}
}
