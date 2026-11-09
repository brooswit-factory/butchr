import {test,expect} from 'bun:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTelemetryOutbox,scopeOperationalSnapshot,createOperationalAgentFeed} from '../../src/control-panel/telemetry.js';
import {encodeQueryAgentKey,encodeAgentKey} from '../../src/rules/agent-key.js';
import {cwdAgentResolvers} from '../../src/agents/dashboard.js';
import {validateEvent} from '../../src/control-panel/telemetry-wire.js';
const key=encodeAgentKey({resourceProvider:'confluence-page',ruleId:'servy-codex-agents',resourceId:'60588033'}),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
/** A real filesystem resource id must have a platform-correct absolute shape (FACTORY-1043: a hardcoded POSIX path is invalid on win32). */
const fsPath=process.platform==='win32'?'C:\\private\\fixture\\path':'/private/fixture/path';
test('existing Confluence agent omitted by the legacy dashboard is observed without widening dashboard/PTY ownership',()=>{
 const legacy=cwdAgentResolvers(()=>key);expect(legacy.dashboardAgentOfCwd('/synthetic-managed-workspace')).toBeNull();const feed=createOperationalAgentFeed(()=>Date.parse('2026-10-26T12:00:00.000Z'));expect(feed.snapshot('daemon',true).agentsChecked).toBe(false);
 expect(feed.record([{agentKey:key,status:'idle'}])).toBe(true);expect(feed.snapshot('daemon',true)).toEqual({mode:'daemon',controllersEnabled:true,agentsChecked:true,agentsTruncated:false,agents:[{id:hash(key),status:'idle',confirmedAt:'2026-10-26T12:00:00.000Z',provenance:{provider:'confluence-page',kind:'resource',ruleId:'servy-codex-agents',resourceId:'60588033'}}]});expect(JSON.stringify(feed.snapshot('daemon',true))).not.toContain('ancestor');expect(legacy.dashboardAgentOfCwd('/synthetic-managed-workspace')).toBeNull();
});
test('same observed inventory supports other resource providers and legacy keys but excludes human/unknown identities',()=>{
 const feed=createOperationalAgentFeed();const keys=[key,encodeAgentKey({resourceProvider:'github-issue',ruleId:'triage',resourceId:'fixture/repo#1'}),encodeAgentKey({resourceProvider:'zendesk-ticket',ruleId:'triage',resourceId:'fixture#1'}),'FIXTURE-1','FIXTURE'];feed.record([...keys.map(agentKey=>({agentKey,status:'working'})),{agentKey:null,status:'working'},{agentKey:'unrelated human pane',status:'working'}]);expect(feed.snapshot('daemon',true).agents.map(a=>a.id).sort()).toEqual(keys.map(hash).sort());
});
test('failed or duplicate observations retain last confirmed agents honestly; confirmed empty removes them',()=>{
 let now=Date.parse('2026-10-26T12:00:00.000Z');const feed=createOperationalAgentFeed(()=>now);feed.record([{agentKey:key,status:'idle'}]);const before=feed.snapshot('daemon',true).agents;now+=60000;feed.decline();expect(feed.snapshot('daemon',true).agentsChecked).toBe(false);expect(feed.snapshot('daemon',true).agents).toEqual(before);expect(feed.record([{agentKey:key,status:'idle'},{agentKey:key,status:'working'}])).toBe(false);expect(feed.snapshot('daemon',true).agents).toEqual(before);expect(feed.record([])).toBe(true);expect(feed.snapshot('daemon',true).agentsChecked).toBe(true);expect(feed.snapshot('daemon',true).agents).toEqual([]);
});
test('bounded projection has explicit truncation, normalizes unknown status and exposes no mutable snapshot references',()=>{
 const feed=createOperationalAgentFeed();expect(feed.record(Array.from({length:101},(_,i)=>({agentKey:encodeAgentKey({resourceProvider:'confluence-page',ruleId:'fixture',resourceId:String(i+1)}),status:'starting'})))).toBe(true);const snap=feed.snapshot('daemon',true);expect(snap.agentsTruncated).toBe(true);expect(snap.agents).toHaveLength(100);expect(snap.agents.every(a=>a.status==='unknown')).toBe(true);snap.agents[0]!.status='working';expect(feed.snapshot('daemon',true).agents.every(a=>a.status==='unknown')).toBe(true);expect(feed.record(Array.from({length:10001},()=>({agentKey:null})))).toBe(false);expect(feed.snapshot('daemon',true).agentsChecked).toBe(false);
});

test('provider-native string IDs, query identity and filesystem privacy remain distinct',()=>{
 const feed=createOperationalAgentFeed();const fixtures=[['jira-work','FIXTURE-1'],['jira-idea','IDEA-2'],['jira-project','FIXTURE'],['github-issue','fixture/repo#1'],['github-pr','fixture/repo#2'],['zendesk-ticket','fixture#3'],['confluence-page','90071992547409931234'],['filesystem',fsPath]] as const;
 for(const [resourceProvider,resourceId] of fixtures){const agentKey=encodeAgentKey({resourceProvider,ruleId:'fixture-rule',resourceId});feed.record([{agentKey,status:'idle'}]);const a=feed.snapshot('daemon',true).agents[0]!;expect(a.id).toBe(hash(agentKey));expect(a.provenance).toEqual({provider:resourceProvider,kind:'resource',ruleId:'fixture-rule',...(resourceProvider==='filesystem'?{}:{resourceId})});}
 const query=encodeQueryAgentKey({resourceProvider:'confluence-page',ruleId:'fixture-rule'});feed.record([{agentKey:query}]);expect(feed.snapshot('daemon',true).agents[0]!.provenance).toEqual({provider:'confluence-page',kind:'query',ruleId:'fixture-rule'});
 const snapshot=feed.snapshot('daemon',true);snapshot.agents[0]!.provenance!.ruleId='mutated';expect(feed.snapshot('daemon',true).agents[0]!.provenance!.ruleId).toBe('fixture-rule');
 feed.record([{agentKey:'FIXTURE-1'}]);expect(feed.snapshot('daemon',true).agents[0]!.provenance).toEqual({provider:'jira-work',kind:'resource',resourceId:'FIXTURE-1'});
});

test('large valid provenance never overflows the event budget or drops observed identities',()=>{
 const feed=createOperationalAgentFeed();feed.record(Array.from({length:100},(_,i)=>({agentKey:encodeAgentKey({resourceProvider:'confluence-page',ruleId:'a'.repeat(64),resourceId:String(i+1).padStart(500,'0')}),status:'idle'})));const data={...feed.snapshot('daemon',true),remoteConfigsEnabled:true,transportConnected:true};expect(data.agents).toHaveLength(100);expect(data.agents.some(a=>!a.provenance)).toBe(true);expect(()=>validateEvent({id:randomUUID(),sequence:1,occurredAt:new Date().toISOString(),type:'session.snapshot',data})).not.toThrow();
});

test('feed uses the supplied admitted identity, keeps cross-rule same-resource agents separate and clones history',()=>{
 const one=encodeAgentKey({resourceProvider:'confluence-page',ruleId:'one',resourceId:'1'}),two=encodeAgentKey({resourceProvider:'confluence-page',ruleId:'two',resourceId:'1'}),origin={id:'one',name:'one',source:'local' as const};const feed=createOperationalAgentFeed(Date.now,id=>id===one?origin:undefined);feed.record([{agentKey:one},{agentKey:two}]);const snapshot=feed.snapshot('daemon',true);expect(snapshot.agents).toHaveLength(2);expect(snapshot.agents.find(a=>a.id===hash(one))!.provenance!.admittedRule).toEqual(origin);expect(snapshot.agents.find(a=>a.id===hash(two))!.provenance!.admittedRule).toBeUndefined();origin.name='changed';expect(feed.snapshot('daemon',true).agents.find(a=>a.id===hash(one))!.provenance!.admittedRule!.name).toBe('one');snapshot.agents.find(a=>a.id===hash(one))!.provenance!.admittedRule!.name='mutated';expect(feed.snapshot('daemon',true).agents.find(a=>a.id===hash(one))!.provenance!.admittedRule!.name).toBe('one');
});

test('source switch redacts all source-A provenance before durable source-B enqueue without mutating history',()=>{
 const a={origin:'https://fixture.invalid',serverId:randomUUID(),authorizationId:randomUUID()},b={...a,authorizationId:randomUUID()},origin={id:'fixture',name:'fixture',source:'remote' as const,serverId:a.serverId,authorizationId:a.authorizationId},feed=createOperationalAgentFeed(Date.now,()=>origin);feed.record([{agentKey:'confluence-page:fixture:123',status:'idle'}]);const data={...feed.snapshot('daemon',true),transportConnected:true,remoteConfigsEnabled:true};expect(scopeOperationalSnapshot(data,a).agents[0]!.provenance!.admittedRule).toEqual(origin);expect(scopeOperationalSnapshot(data,b).agents[0]!.provenance).toBeUndefined();expect(data.agents[0]!.provenance!.admittedRule).toEqual(origin);const directory=mkdtempSync(join(tmpdir(),'provenance-outbox-'));try{const outbox=createTelemetryOutbox(directory);expect(outbox.enqueue(b,randomUUID(),randomUUID(),data)).toBe(true);const stored=JSON.parse(readFileSync(join(directory,'event-outbox.json'),'utf8'));expect(stored.records[0].event.data.agents[0].provenance).toBeUndefined();expect(stored.records[0].event.data.agents[0].id).toBe(data.agents[0]!.id);expect(createTelemetryOutbox(directory).summary().queued).toBe(1);outbox.stop();}finally{rmSync(directory,{recursive:true,force:true});}
});
