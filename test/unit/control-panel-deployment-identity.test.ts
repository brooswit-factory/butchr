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
  const script=`
   import {createControlPanelClient} from ${JSON.stringify(module)};
   for(let attempt=0;attempt<200;attempt++){
    try{const client=createControlPanelClient(${JSON.stringify(dir)});console.log(client.deploymentId);client.stop();break;}
    catch(e){if(!String((e as Error).message).includes('Another control-panel client'))throw e;}
   }
  `;
  const children=Array.from({length:4},()=>Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'}));
  const outputs=await Promise.all(children.map(async child=>{
   const [out,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);
   if(code!==0)throw Error('Synthetic racer failed: '+await new Response(child.stderr).text());
   return out.trim();
  }));
  const identities=new Set(outputs);
  expect(identities.size).toBe(1);
  for(const id of identities)expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(readdirSync(dir).filter(f=>f.startsWith('.deployment-'))).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
},15000);
