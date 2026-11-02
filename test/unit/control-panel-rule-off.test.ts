import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuleRuntime,type RuntimeUpdate} from '../../src/control-panel/rule-runtime.js';
import {reconcileDisabledRules} from '../../src/control-panel/reconcile-disabled-rules.js';
import {createRulesHolder,parseRules,sourceEtagOf} from '../../src/rules/rules.js';
import {HerdrHerd} from '../../src/agents/herd.js';
import {ensureWorkspaceDir,workspaceDirFor} from '../../src/agents/workspace.js';
import {runResourceLoop} from '../../src/daemon/loop.js';
import {encodeAgentKey} from '../../src/rules/agent-key.js';

const authority={serverId:'00000000-0000-4000-8000-000000000001',authorizationId:'00000000-0000-4000-8000-000000000002'};
const first='jira-work:first:FIXTURE-1',shared='jira-work:shared:FIXTURE-1';
const spec=(key:string)=>({key,issuetype:'Task',summary:'Synthetic rule-OFF fixture',parent:null});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function fixture(twoRules=false,apply?: import('../../src/control-panel/rule-runtime.js').RuntimeLocal['reconcile']){
 const dir=mkdtempSync(join(tmpdir(),'rule-off-')),previous=process.env.BUTCHR_WORKSPACES;
 process.env.BUTCHR_WORKSPACES=join(dir,'work');
 const original={rules:[{id:'first',resourceProvider:'jira-work',query:'project = FIXTURE',brief:'Synthetic fixture',enabled:true},...(twoRules?[{id:'shared',resourceProvider:'jira-work',query:'project = FIXTURE',brief:'Synthetic shared owner',enabled:true}]:[])]};
 const text=JSON.stringify(original),path=join(dir,'rules.json');writeFileSync(path,text,{mode:0o600});
 const runtime=createRuleRuntime(dir,{holder:createRulesHolder(parseRules(original),sourceEtagOf(text)),readText:()=>readFileSync(path,'utf8'),reload:()=>({ok:true}),...(apply?{reconcile:apply}:{})});
 let definitions=original,connected=true,control={enabled:true,disabledRules:[] as string[]},complete=true,fail=false;
 const rows:any[]=[];const closed:string[]=[];let afterRead:(()=>Promise<void>)|undefined,readsUntilHook=0;
 function add(id:string,pane=id){const cwd=ensureWorkspaceDir(id);rows.push({pane_id:pane,workspace_id:'workspace-'+pane,cwd,agent:'codex',agent_status:'working'});}
 add(first);if(twoRules)add(shared);
 const client:any={agent:{list:async()=>{if(fail)throw Error('Synthetic inventory failure');const agents=rows.map(r=>({...r}));if(afterRead&&--readsUntilHook===0)await afterRead();return {agents};},get:async(id:string)=>{const agent={...rows.find(r=>r.pane_id===id)};await afterRead?.();return {agent};}},pane:{close:async(id:string)=>{closed.push(id);const i=rows.findIndex(r=>r.pane_id===id);if(i>=0)rows.splice(i,1);}}};
 const herd=new HerdrHerd(client,'http://localhost:7717/mcp',async()=>{});herd.ruleRuntime=()=>runtime.policy;
 const census=herd.ruleCensus.bind(herd);herd.ruleCensus=async()=>{const c=await census();return {...c,complete:c.complete&&complete};};
 function update(extra:Partial<RuntimeUpdate>={}){runtime.update({connected,source:authority,revision:'a'.repeat(64),control,rules:parseRules(definitions).map(definition=>({id:`remote:${authority.serverId}:${authority.authorizationId}:${definition.id}`,source:'remote',...authority,sourceRuleId:definition.id,definition,executionState:'staged'})),...extra});}
 runtime.recordFullCensus(rows.map(r=>r.pane_id),true);update();runtime.recordFullCensus(rows.map(r=>r.pane_id),true);const plan=runtime.plan();runtime.activate({localDigest:plan.localDigest!,remoteDigest:plan.remoteDigest!,confirm:true});
 return {dir,runtime,herd,rows,closed,add,update,off(){definitions={rules:original.rules.map(r=>({...r,enabled:r.id==='first'?false:r.enabled}))};update();},on(){definitions=original;update();},preferences(){definitions={rules:original.rules.map(r=>({...r,agentPreferences:[{harness:'claude' as const}]}))};update();},disconnect(){connected=false;update();},masterOff(){control={enabled:false,disabledRules:[]};update();},overrideOff(){control={enabled:true,disabledRules:[`remote:${authority.serverId}:${authority.authorizationId}:first`]};update();},incomplete(){complete=false;},fail(){fail=true;},readHook(h:()=>Promise<void>){afterRead=h;readsUntilHook=2;},async reconcile(){await reconcileDisabledRules(herd,()=>true);},close(){if(previous===undefined)delete process.env.BUTCHR_WORKSPACES;else process.env.BUTCHR_WORKSPACES=previous;rmSync(dir,{recursive:true,force:true});}};
}

test('last enabled rule OFF stops its exact worker through the real herd without resource discovery',async()=>{
 const f=fixture();let stop:(()=>void)|undefined;try{
  f.off();let searches=0,polls=0;
  stop=runResourceLoop<{id:string}>({discovery:{idOf:r=>r.id,search:async()=>{searches++;return [{id:first}];}},activation:{verdictFor:()=> 'active'},spawnConfig:{specFor:r=>spec(r.id)},eventRules:{poll:async()=>({changedPrimary:[],changedRelated:[],decide:async()=>({deliver:false})})}},{herd:f.herd,ownsId:id=>id.startsWith('jira-work:'),ruleProvider:'jira-work',intervalMs:5,notify:async()=>{},onPollSuccess:()=>polls++});
  for(let i=0;i<100&&!f.closed.length;i++)await Bun.sleep(5);
  expect(f.closed).toEqual([first]);expect(searches).toBe(0);expect(polls).toBeGreaterThan(0);
 }finally{stop?.();await Bun.sleep(15);f.close();}
});

test('OFF respects exact rule ownership when another enabled rule owns the same resource, and preserves human, legacy and unadmitted workers',async()=>{
 const f=fixture(true);try{
  const legacy=encodeAgentKey({resourceProvider:'filesystem',ruleId:'managed-sessions',resourceId:join(f.dir,'synthetic-director.json')});
  f.add(legacy);f.add('jira-work:first:FIXTURE-2');f.rows.push({pane_id:'human',cwd:'/tmp/unmanaged-human',agent:'codex',agent_status:'working'});
  f.off();await f.reconcile();
  expect(f.closed).toEqual([first]);expect(f.rows.map(r=>r.pane_id).sort()).toEqual([shared,legacy,'jira-work:first:FIXTURE-2','human'].sort());
 }finally{f.close();}
});

for(const kind of ['disconnect','missing-rule','invalid-update','incomplete','master-off'] as const)test('no configuration stop from '+kind,async()=>{
 const f=fixture();try{
  f.off();if(kind==='disconnect')f.disconnect();if(kind==='missing-rule')f.update({rules:[]});if(kind==='invalid-update')f.update({source:{...authority,serverId:'00000000-0000-4000-8000-000000000099'}});if(kind==='incomplete')f.incomplete();if(kind==='master-off')f.masterOff();
  await f.reconcile();expect(f.closed).toEqual([]);
 }finally{f.close();}
});

test('explicit per-rule override OFF uses the same numeric authority lease',async()=>{const f=fixture();try{f.overrideOff();await f.reconcile();expect(f.closed).toEqual([first]);}finally{f.close();}});

test('OFF then ON while a real stop waits on identity read cannot close a pane, including an identical subsequent OFF generation',async()=>{
 for(const offAgain of [false,true]){const f=fixture();try{
  f.off();const entered=deferred(),release=deferred();f.readHook(async()=>{entered.resolve();await release.promise;});
  const work=f.reconcile();await entered.promise;f.on();if(offAgain)f.off();release.resolve();
  await expect(work).rejects.toThrow('Rule authority changed');expect(f.closed).toEqual([]);
 }finally{f.close();}}
});

test('incomplete census invalidates a stop already waiting on physical identity',async()=>{
 const f=fixture();try{f.off();const entered=deferred(),release=deferred();f.readHook(async()=>{entered.resolve();await release.promise;});const work=f.reconcile();await entered.promise;f.runtime.recordFullCensus([first],false);release.resolve();await expect(work).rejects.toThrow('Rule authority changed');expect(f.closed).toEqual([]);}finally{f.close();}
});

test('stale numeric lease and provider scoping cannot authorize configuration stops',async()=>{
 const f=fixture();try{const stale=f.runtime.policy.generation();f.off();expect(f.runtime.policy.disabledWorkers(stale)).toEqual([]);await expect(f.herd.stop(first,stale)).rejects.toThrow('Rule authority changed');await reconcileDisabledRules(f.herd,()=>false);expect(f.closed).toEqual([]);}finally{f.close();}
});

test('inventory read failure revokes the previous proof without closing any pane',async()=>{const f=fixture();try{f.off();f.fail();await expect(f.reconcile()).rejects.toThrow('Synthetic inventory failure');expect(f.runtime.summary().inventoryComplete).toBe(false);expect(f.closed).toEqual([]);}finally{f.close();}});

for(const partial of [false,true])test('OFF cancels an inflight preference transaction and fences uncertain physical ownership: partial='+partial,async()=>{
 const entered=deferred(),release=deferred();let stillCurrent=true;
 const f=fixture(false,async(_change,current)=>{entered.resolve();await release.promise;stillCurrent=current();return {status:'blocked',reason:'Synthetic canceled handoff',...(partial?{partial:true,current:{paneId:first,provider:'codex'}}:{})};});
 try{
  const p=f.runtime.policy;p.prepare(new Map([[first,spec(first)]]),[first],p.generation());f.preferences();await entered.promise;
  f.off();await f.reconcile();expect(f.closed).toEqual([]);
  release.resolve();await f.runtime.settleReconciliation();expect(stillCurrent).toBe(false);
  await f.reconcile();expect(f.closed).toEqual(partial?[]:[first]);
 }finally{release.resolve();f.close();}
});
