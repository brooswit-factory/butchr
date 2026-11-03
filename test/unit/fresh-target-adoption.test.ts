import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {planFreshTargetAdoption,applyFreshTargetAdoption,freshTargetAdoptionStatus,type AdoptionIO,type AdoptionSnapshot,type AdoptionRequest} from '../../src/operator/fresh-target-adoption.js';
import {planValidationRetirement,retireValidationMode,hash} from '../../src/operator/validation-retirement.js';
import {acquireRuntimeWriter} from '../../src/control-panel/writer.js';
const posix=process.platform==='win32'?test.skip:test;
async function fixture(){
 const state=mkdtempSync(join(tmpdir(),'fresh-adoption-')),cwd=join(state,'workspace');mkdirSync(cwd,{mode:0o700});mkdirSync(join(state,'worker-canary-attempts'),{mode:0o700});acquireRuntimeWriter(state)();
 const source={serverId:'00000000-0000-4000-8000-000000000001',authorizationId:'00000000-0000-4000-8000-000000000002'},workerKey='jira-work:tasks:TEST-1',rule={id:'tasks',resourceProvider:'jira-work',query:'project=TEST',brief:'Normal brief',enabled:true,agentPreferences:[{harness:'claude',model:'sonnet',effort:'high'}]},token=hash(JSON.stringify([source,rule,true,false]));
 const ref={agent:'claude',kind:'id',value:'00000000-0000-4000-8000-000000000099'},target={paneId:'w3:p1',workspaceId:'w3',terminalId:'t3',provider:'claude' as const,cwd,sessionHash:hash(JSON.stringify([ref.agent,ref.kind,ref.value]))},permitId='00000000-0000-4000-8000-000000000005';
 const permit={version:2,permitId,workerKey,authority:{...source,deploymentId:'00000000-0000-4000-8000-000000000003'},desiredToken:'b'.repeat(64),targetProvider:'claude',expiresAt:new Date(Date.now()+600000).toISOString(),source:{paneId:'w1:p1',cwd,provider:'codex',sessionHash:'a'.repeat(64)},holdClearance:{notHeld:true,paneId:'w1:p1',sessionHash:'a'.repeat(64),expiresAt:new Date(Date.now()+600000).toISOString()},continuation:{kind:'owned-existing-target',issuedAt:new Date().toISOString(),operationDeadline:new Date(Date.now()+3600000).toISOString(),policy:{origin:'https://example.test',issueKey:'TEST-1',issueHash:'c'.repeat(64),taskHash:'d'.repeat(64),reviewerHash:'e'.repeat(64)},snapshot:{sha256:'f'.repeat(64),bytes:100,chars:100,chunks:1},target}};
 const path=join(state,'permit.json'),text=JSON.stringify(permit),receipt=join(state,'worker-canary-attempts',permitId+'.jsonl');writeFileSync(path,text,{mode:0o600});writeFileSync(join(state,'worker-canary-mode.json'),JSON.stringify({permitId,permitHash:hash(text)}),{mode:0o600});
 writeFileSync(receipt,[{at:new Date().toISOString(),status:'claimed',permitId,workerKey,permitHash:hash(text)},{at:new Date().toISOString(),status:'terminal',target:'w3:p1',retired:false,result:{status:'superseded',partial:true,current:{paneId:'w1:p1',provider:'codex'}}}].map(v=>JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
 const manifest={version:1,active:true,source,revision:'r1',remote:[{sourceRuleId:'tasks',definition:rule}],retained:[[workerKey,{managed:true,known:true,rule:{...rule,agentPreferences:[{harness:'codex'}]},needsReconciliation:true,lastHandoff:{status:'superseded',partial:true,current:{paneId:'w1:p1',provider:'codex'},token:permit.desiredToken},reconciliation:{status:'blocked',partial:true,current:{paneId:'w1:p1',provider:'codex'},token}}]],otherIndependentState:{frozen:true}};
 const authority=join(state,'remote-rule-authority.json');writeFileSync(authority,JSON.stringify(manifest),{mode:0o600});
 const census={agents:[{pane_id:target.paneId,workspace_id:target.workspaceId,cwd,agent:'claude',agent_session:ref}],panes:[{pane_id:'w1:p1',workspace_id:'w1',terminal_id:'t1',cwd},{pane_id:target.paneId,workspace_id:target.workspaceId,terminal_id:target.terminalId,cwd},{pane_id:'human',workspace_id:'human',terminal_id:'human'}]};
 const retirementIO={assertStopped:async()=>{},census:async()=>census,holds:async()=>({otherWorkerFrozen:true})};const retirement=await planValidationRetirement(state,path,retirementIO);await retireValidationMode(retirement,retirement.confirmation,'synthetic retirement',retirementIO);
 const request:AdoptionRequest={state,permit:path,socket:'/synthetic.sock',runtime:'/synthetic-release',unit:'butchr.service',workspaces:state,freezeRoot:join(state,'freezes'),repository:join(cwd,'repo'),sourceHistory:join(state,'source.jsonl'),nativeRoot:join(state,'native'),targetExecutable:'/synthetic/claude'};
 let snapshot:AdoptionSnapshot={target,sourceAbsent:true,workspaceKey:workerKey,preferences:{model:'sonnet',effort:'high'},process:{pid:123,generation:'1'},workspace:{path:cwd,uncommittedSHA:'keep'},histories:{source:'saved',target:'saved'},inventory:{human:'preserved'},independentHolds:{otherFrozen:true},holdsClear:true},stopped=true,interrupt=false;
 const io:AdoptionIO={assertStopped:async()=>{if(!stopped)throw Error('active service');if(interrupt&&readdirSync(state).some(v=>v.startsWith('fresh-target-adoption-')))throw Error('interrupted after audit');},capture:async()=>structuredClone(snapshot)};
 return {state,cwd,path,receipt,authority,manifest,request,io,workerKey,get snapshot(){return snapshot},change:(next:Partial<AdoptionSnapshot>)=>{snapshot={...snapshot,...next}},setStopped:(v:boolean)=>{stopped=v},interrupt:(v:boolean)=>{interrupt=v},close:()=>rmSync(state,{recursive:true,force:true})};
}
posix('read-only plan and audited adoption preserve work, all spent evidence, unrelated holds and human inventory',async()=>{const f=await fixture();try{
 const originals=[f.path,f.receipt,join(f.state,'worker-canary-mode.json')].map(p=>readFileSync(p,'utf8')),before=readFileSync(f.authority,'utf8'),files=readdirSync(f.state);
 const plan=await planFreshTargetAdoption(f.request,f.io);expect(readdirSync(f.state)).toEqual(files);expect(readFileSync(f.authority,'utf8')).toBe(before);expect(plan.effects).toMatchObject({launches:0,closes:0,imports:0});
 const result=await applyFreshTargetAdoption(plan,plan.confirmation,'synthetic explicit adoption',f.io);expect(result.adopted).toBe(true);const after=JSON.parse(readFileSync(f.authority,'utf8'));expect(after.otherIndependentState).toEqual(f.manifest.otherIndependentState);expect(after.retained[0][1]).toMatchObject({needsReconciliation:false,lastHandoff:{status:'applied',partial:false,current:{paneId:'w3:p1',provider:'claude'}},appliedPreferences:[{harness:'claude',model:'sonnet',effort:'high'}]});
 expect([f.path,f.receipt,join(f.state,'worker-canary-mode.json')].map(p=>readFileSync(p,'utf8'))).toEqual(originals);expect(freshTargetAdoptionStatus(f.state,plan.confirmation)).toMatchObject({adopted:true,requiresInspection:false});
 expect(await applyFreshTargetAdoption(plan,plan.confirmation,'same authority',f.io)).toMatchObject({alreadyApplied:true,launches:0,closes:0});expect(existsSync(join(f.state,'worker-canary-control.lock'))).toBe(false);
 }finally{f.close();}});
for(const condition of ['wrong-target','wrong-workspace','source-present','held','preferences','process-drift'] as const)posix('adoption refuses '+condition+' without clearing any state',async()=>{const f=await fixture();try{
 const before=readFileSync(f.authority,'utf8'),plan=await planFreshTargetAdoption(f.request,f.io);
 if(condition==='wrong-target')f.change({target:{...f.snapshot.target,paneId:'foreign'}});
 if(condition==='wrong-workspace')f.change({workspaceKey:'jira-work:tasks:FOREIGN-2'});
 if(condition==='source-present')f.change({sourceAbsent:false as any});
 if(condition==='held')f.change({holdsClear:false as any});
 if(condition==='preferences')f.change({preferences:{model:'opus',effort:'high'}});
 if(condition==='process-drift')f.change({process:{pid:123,generation:'2'}});
 await expect(applyFreshTargetAdoption(plan,plan.confirmation,'synthetic',f.io)).rejects.toThrow();expect(readFileSync(f.authority,'utf8')).toBe(before);
 }finally{f.close();}});
posix('stale desired settings, active service, wrong confirmation and a competing writer fail closed',async()=>{for(const condition of ['settings','active','confirm','writer'] as const){const f=await fixture();try{
 const plan=await planFreshTargetAdoption(f.request,f.io);let release:(()=>void)|undefined;
 if(condition==='settings'){const m=JSON.parse(readFileSync(f.authority,'utf8'));m.remote[0].definition.agentPreferences[0].model='opus';writeFileSync(f.authority,JSON.stringify(m));}
 if(condition==='active')f.setStopped(false);if(condition==='writer')release=acquireRuntimeWriter(f.state);
 const before=readFileSync(f.authority,'utf8');try{await expect(applyFreshTargetAdoption(plan,condition==='confirm'?'wrong':plan.confirmation,'synthetic',f.io)).rejects.toThrow();}finally{release?.();}expect(readFileSync(f.authority,'utf8')).toBe(before);
 }finally{f.close();}}});
posix('interruption after audit retains old partial hold and resumes only the same verified intent',async()=>{const f=await fixture();try{
 const before=readFileSync(f.authority,'utf8'),plan=await planFreshTargetAdoption(f.request,f.io);f.interrupt(true);await expect(applyFreshTargetAdoption(plan,plan.confirmation,'synthetic',f.io)).rejects.toThrow('interrupted');expect(readFileSync(f.authority,'utf8')).toBe(before);expect(freshTargetAdoptionStatus(f.state,plan.confirmation)).toMatchObject({adopted:false,notApplied:true});expect(existsSync(join(f.state,'worker-canary-control.lock'))).toBe(false);
 f.interrupt(false);expect(await applyFreshTargetAdoption(plan,plan.confirmation,'same reviewed intent',f.io)).toMatchObject({adopted:true});
 }finally{f.close();}});
posix('tampered audit and non-transaction partial ownership refuse adoption',async()=>{const f=await fixture();try{
 const plan=await planFreshTargetAdoption(f.request,f.io),m=JSON.parse(readFileSync(f.authority,'utf8'));m.retained[0][1].lastHandoff.token='0'.repeat(64);writeFileSync(f.authority,JSON.stringify(m));await expect(planFreshTargetAdoption(f.request,f.io)).rejects.toThrow('obsolete');
 writeFileSync(f.authority,plan.afterText);writeFileSync(join(f.state,'fresh-target-adoption-'+plan.confirmation+'.json'),JSON.stringify({kind:plan.kind,plan:{...plan,afterText:'tampered'},beforeText:'wrong'}),{mode:0o600});expect(()=>freshTargetAdoptionStatus(f.state,plan.confirmation)).toThrow('audit');
 }finally{f.close();}});
