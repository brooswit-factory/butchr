/** Operator-only, read-only proof. No signal, spawn, pane input or history access. */
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, readlink, stat, open } from 'node:fs/promises';
import type { PreservedPartialTargetIdentity, PreservedPartialTargetSnapshot } from './worker-rollout.js';
export interface PartialTargetPhysicalProof {
    identity: PreservedPartialTargetIdentity;
    allThreadsStopped: boolean; noChildren: boolean; soleProcessGroupMember: boolean; noUnaccountedLaunch: boolean;
}
export interface PartialTargetIO {
    physical: (expected: PreservedPartialTargetIdentity) => Promise<PartialTargetPhysicalProof>;
    panes: () => Promise<{ pane_id: string; workspace_id: string; terminal_id: string; cwd?: string | null }[]>;
    agents: () => Promise<{ pane_id: string }[]>;
    processInfo: (paneId: string) => Promise<{pane_id:string; shell_pid:number; foreground_process_group_id:number}>;
    visible: (paneId: string) => Promise<{ pane_id: string; source: string; truncated: boolean; text: string }>;
}
const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function createPreservedTargetInspection(expected: PreservedPartialTargetIdentity, io: PartialTargetIO, now = () => Date.now()) {
    const identity = structuredClone(expected);
    return async (): Promise<PreservedPartialTargetSnapshot> => {
        const linked = async () => {const p=await io.processInfo(identity.paneId);if(p.pane_id!==identity.paneId || p.shell_pid!==identity.pid || p.foreground_process_group_id!==identity.pid)throw Error('Pane-to-process identity differs');};
        await linked();
        const before = await io.physical(identity);
        const panes = await io.panes(), agents = await io.agents(), visible = await io.visible(identity.paneId);
        const matches = panes.filter(p=>p.pane_id===identity.paneId);
        if (matches.length!==1 || matches[0]!.workspace_id!==identity.workspaceId || matches[0]!.terminal_id!==identity.terminalId || matches[0]!.cwd!==identity.cwd || agents.some(a=>a.pane_id===identity.paneId) || visible.pane_id!==identity.paneId || visible.source!=='visible' || visible.truncated || visible.text!=='') throw Error('Preserved target pane/agent evidence changed');
        const after = await io.physical(identity);
        await linked();
        for (const proof of [before,after]) if (!same(proof.identity,identity) || proof.allThreadsStopped!==true || proof.noChildren!==true || proof.soleProcessGroupMember!==true || proof.noUnaccountedLaunch!==true) throw Error('Preserved target is not physically isolated');
        return {checkedAt:now(),identity:structuredClone(identity),allThreadsStopped:true,noChildren:true,soleProcessGroupMember:true,noUnaccountedLaunch:true,noRegisteredAgent:true,blankVisiblePane:true};
    };
}
function procStat(text: string) {
    const end=text.lastIndexOf(')'); if (end<0) throw Error('Unknown process identity');
    const f=text.slice(end+2).trim().split(/\s+/);
    if (f.length<20 || !/^\d+$/.test(f[19]!) || !/^\d+$/.test(f[2]!)) throw Error('Malformed process identity');
    return {state:f[0],parent:Number(f[1]),group:Number(f[2]),startTicks:f[19]!};
}
/** Uses same-account /proc metadata only. Every uncertainty rejects; no EACCES-as-absence. */
export async function inspectFrozenTargetProcess(identity: PreservedPartialTargetIdentity): Promise<PartialTargetPhysicalProof> {
    if (process.platform!=='linux' || process.getuid?.()===undefined || !Number.isSafeInteger(identity.pid) || identity.pid<=1) throw Error('Unsupported frozen-process inspection');
    const root='/proc/'+identity.pid;
    const processStat=()=>readFile(root+'/stat','utf8').then(procStat);
    const before=await processStat(), boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    if (boot!==identity.bootId || before.startTicks!==identity.startTicks || before.group!==identity.pid || (await lstat(root)).uid!==process.getuid?.() || await readlink(root+'/cwd')!==identity.cwd) throw Error('Preserved process identity differs');
    const threads=(await readdir(root+'/task')).sort(); if (!threads.length) throw Error('Preserved process has no threads');
    const checkThreads = async () => {
        if (!same(threads,(await readdir(root+'/task')).sort())) throw Error('Preserved thread set changed');
        for (const tid of threads) if (procStat(await readFile(root+'/task/'+tid+'/stat','utf8')).state!=='T' || (await readFile(root+'/task/'+tid+'/children','utf8')).trim()!=='') throw Error('Preserved target must have every thread stopped and no children');
    };
    await checkThreads();
    const image=await open(root+'/exe','r');
    const imageKey=(s:Awaited<ReturnType<typeof image.stat>>)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs];
    try {
        const descriptor=await image.stat();
        if (!same(imageKey(descriptor),imageKey(await stat(root+'/exe')))) throw Error('Current executable differs from descriptor');
        const hash=createHash('sha256').update(await image.readFile()).digest('hex');
        if (hash!==identity.executableSHA256) throw Error('Preserved process image differs');
        // Every same-account process born since the target is either this exact
        // stopped process or an actual kernel ancestor of this inspection. Any
        // other recent process refuses proof regardless of cwd/group/reparenting.
        const ancestors=new Map<number,string>();let current=process.pid;
        for(let depth=0;current>0 && depth<64;depth++) {
            if(ancestors.has(current))throw Error('Inspection ancestry cycle');
            const p=procStat(await readFile('/proc/'+current+'/stat','utf8'));ancestors.set(current,p.startTicks);current=p.parent;
        }
        if(current!==0)throw Error('Incomplete inspection ancestry');
        for (const pid of await readdir('/proc')) {
            if (!/^\d+$/.test(pid) || Number(pid)===identity.pid) continue;
            let meta;
            try {meta=await lstat('/proc/'+pid);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
            if(meta.uid!==process.getuid?.())continue;
            let other;
            try{other=procStat(await readFile('/proc/'+pid+'/stat','utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
            if(other.group===identity.pid)throw Error('Unexpected process-group member');
            if(BigInt(other.startTicks)>=BigInt(identity.startTicks) && ancestors.get(Number(pid))!==other.startTicks)throw Error('Unaccounted post-launch process regardless of cwd or group');
        }
        for(const [pid,start] of ancestors)if(procStat(await readFile('/proc/'+pid+'/stat','utf8')).startTicks!==start)throw Error('Inspection ancestry changed');
        await checkThreads();
        if(!same(imageKey(descriptor),imageKey(await image.stat())) || !same(imageKey(descriptor),imageKey(await stat(root+'/exe'))))throw Error('Executable image changed during inspection');
    }finally{await image.close();}
    const after=await processStat();
    if (after.startTicks!==before.startTicks || after.group!==before.group || after.state!=='T' || !same(threads,(await readdir(root+'/task')).sort())) throw Error('Preserved process changed during inspection');
    return {identity:structuredClone(identity),allThreadsStopped:true,noChildren:true,soleProcessGroupMember:true,noUnaccountedLaunch:true};
}
