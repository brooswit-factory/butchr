import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createControlPanelClient} from '../../src/control-panel/client.js';

/**
 * FACTORY-1043 acceptance: deployment identity is stable across restart (covered by
 * control-panel-https.test.ts) and distinct across installations, with race handling
 * and temp-file cleanup during creation. These cover the remaining invariants.
 */
test('distinct installations (separate directories) get distinct, well-formed deployment identities',()=>{
 const dirA=mkdtempSync(join(tmpdir(),'butchr-deploy-a-')),dirB=mkdtempSync(join(tmpdir(),'butchr-deploy-b-'));
 try{
  const a=createControlPanelClient(dirA),b=createControlPanelClient(dirB);
  try{
   expect(a.deploymentId).not.toBe(b.deploymentId);
   for(const id of [a.deploymentId,b.deploymentId])expect(id).toMatch(/^[0-9a-f-]{36}$/);
  }finally{a.stop();b.stop();}
 }finally{rmSync(dirA,{recursive:true,force:true});rmSync(dirB,{recursive:true,force:true});}
});

test('creating the deployment identity leaves no .deployment-*.tmp candidate behind, on both a fresh directory and one that already has an identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-deploy-cleanup-'));
 try{
  const first=createControlPanelClient(dir);
  const deploymentId=first.deploymentId;first.stop();
  expect(readdirSync(dir).filter(f=>f.startsWith('.deployment-'))).toEqual([]);
  expect(existsSync(join(dir,'deployment-id'))).toBe(true);
  // Re-opening an already-provisioned directory must reuse the existing identity
  // without creating (or leaving behind) a fresh candidate file at all.
  const second=createControlPanelClient(dir);
  try{expect(second.deploymentId).toBe(deploymentId);}finally{second.stop();}
  expect(readdirSync(dir).filter(f=>f.startsWith('.deployment-'))).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a losing candidate from a concurrent creation race is cleaned up and every racer converges on the SAME identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-deploy-race-'));
 const module=resolve(import.meta.dir,'../../src/control-panel/client.ts');
 try{
  // Real OS processes racing acquireRuntimeWriter's exclusive kernel lock: at most one
  // can hold the runtime-writer lock and reach the deployment-id candidate/link dance at
  // a time (acquireRuntimeWriter uses `PRAGMA busy_timeout=0; BEGIN EXCLUSIVE`), so the
  // others must observe either a clean "Another control-panel client owns this runtime
  // directory" refusal or, once the holder releases, the SAME identity the holder wrote
  // — never a distinct identity, a corrupt file, or a leaked temp candidate.
  // A tight, uncapped-elapsed-time retry count is not a realistic wait bound against a
  // real competing Windows process spending tens of seconds in synchronous per-write ACL
  // PowerShell calls (native finding, FACTORY-1043: a 200-attempt tight loop exhausted
  // and correctly reported itself after ~31s, well before the real holder had finished —
  // the test's own retry budget was too short, not a product bug). Retry against an
  // elapsed-time deadline instead, yielding (not spinning) between attempts so the OS can
  // actually schedule the real holder process during the wait.
  //
  // Exhausting the deadline without ever acquiring the lock must be a hard, explicit
  // failure (nonzero exit, real error text) — not a silent exit(0) with empty stdout. An
  // exhausted racer's empty output is otherwise indistinguishable from a genuine
  // distinct-identity failure once collected into the identities Set below.
  const script=`
   import {createControlPanelClient} from ${JSON.stringify(module)};
   const deadline=Date.now()+90000;
   let identity;
   while(Date.now()<deadline){
    try{const client=createControlPanelClient(${JSON.stringify(dir)});identity=client.deploymentId;client.stop();break;}
    catch(e){
     if(!String((e as Error).message).includes('Another control-panel client'))throw e;
     await new Promise(r=>setTimeout(r,150));
    }
   }
   if(identity===undefined)throw Error('exhausted the contention retry deadline without ever acquiring the runtime writer lock');
   console.log(identity);
  `;
  const children=Array.from({length:4},()=>Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'}));
  // allSettled, not all: a fail-fast Promise.all would let `finally` remove the shared
  // fixture directory while a sibling racer process was STILL RUNNING (still holding a
  // file open inside it) the instant any ONE racer rejected — `rmSync` then throws EBUSY
  // on Windows, masking the actual racer failure (confirmed natively, FACTORY-1043).
  // Every child's own `child.exited` is awaited here regardless of outcome, so by the
  // time we inspect results every process has actually exited before cleanup runs.
  const settled=await Promise.allSettled(children.map(async child=>{
   const [out,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);
   if(code!==0)throw Error('Synthetic racer failed: '+await new Response(child.stderr).text());
   return out.trim();
  }));
  const failure=settled.find((r):r is PromiseRejectedResult=>r.status==='rejected');
  if(failure)throw failure.reason;
  const outputs=settled.map(r=>(r as PromiseFulfilledResult<string>).value);
  const identities=new Set(outputs);
  expect(identities.size).toBe(1);
  for(const id of identities)expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(readdirSync(dir).filter(f=>f.startsWith('.deployment-'))).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
// Explicit per-write Windows ACL lockdown (restored, FACTORY-1043: a real inheritance
// exposure found natively) adds a real PowerShell invocation per racer attempt; native
// Windows timing for this exact test was observed at ~31s for a losing racer alone, and
// the retry script's own elapsed-time deadline above is 90s — this outer timeout must
// exceed that deadline with room to spare.
},120000);
