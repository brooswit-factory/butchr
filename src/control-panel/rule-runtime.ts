import type {WorkerRollout} from './worker-rollout.js';
import {createWorkerReconciler,type WorkerChange,type WorkerChangeResult,type WorkerChangeState} from './worker-reconciliation.js';
import {ownsManagedSessionAgent} from './reserved-worker.js';
import {readFileSync,lstatSync,writeFileSync,renameSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {parseRules,sourceEtagOf,type Rule,type RulesHolder,type ResourceProvider,type AgentPreference} from '../rules/rules.js';
import {decodeAnyAgentKey} from '../rules/agent-key.js';
import type {SpawnSpec} from '../agents/herd.js';
import type {RemoteRule} from './remote-rules.js';
import {prepareRuleCutover,ruleFingerprint} from './rule-cutover.js';
import {type AdmittedRuleIdentity} from './telemetry-wire.js';
import {restoreRetainedProvenance,remoteAdmittedIdentity} from './retained-origin.js';
import {syncDirectory} from './writer.js';
const MAX=8_000_000,MAX_AGENTS=10000;
const fingerprint=ruleFingerprint;
const keyOf=(rule:Rule)=>rule.resourceProvider+':'+rule.id;
export interface RuntimePolicy{
 census(value:{ids:readonly string[];complete:boolean}):void;generation():number;scope(owns:(id:string)=>boolean):RuntimePolicy;
 prepare(desired:ReadonlyMap<string,SpawnSpec>,running:readonly string[],lease:number):ReadonlyMap<string,SpawnSpec>;
 canObserve(provider?:ResourceProvider):boolean;canAdmit(id:string,lease:number):boolean;canSpawn(spec:SpawnSpec,lease:number):boolean;spawnFailed(id:string):void;spawnSucceeded(id:string):void;spawnObservedExisting(id:string):void;
 disabledWorkers(lease:number):readonly string[];
 protectStop(id:string,lease:number):boolean;protectRespawn(id:string,lease:number):boolean;
 canNotify(id:string,previous:number|undefined,next:number|undefined):boolean;ignoreNotification(id:string):boolean;notificationContext(id:string):string|undefined;noticeDisposition(id:string,context:string):'deliver'|'defer'|'discard';
}
interface Retained{rule:Rule;known:boolean;managed:boolean;origin?:AdmittedRuleIdentity;appliedPreferences?:AgentPreference[]|null;needsReconciliation?:boolean;reconciliation?:(WorkerChangeState&{token:string})|{status:'disabled';token:string;reason:string};lastHandoff?:(WorkerChangeState&{token:string})}
interface Manifest{version:1;active:boolean;source:{serverId:string;authorizationId:string};baseline:{rules:Rule[]};remote:RemoteRule[];observationGraph:Rule[];history:Rule[];revision:string;retained:[string,Retained][];deactivation?:{originalText:string;emptyEtag:string;backupId?:string|null}}
export interface RuntimeUpdate{connected:boolean;rules:readonly RemoteRule[];revision:string|null;control:{enabled:boolean;disabledRules:string[]};source?:{serverId:string;authorizationId:string}|undefined}
export interface RuntimeLocal{deploymentId?:string;rollout?:Pick<WorkerRollout,'workerKey'|'observe'|'summary'>&Partial<Pick<WorkerRollout,'continuationSpec'>>;holder:RulesHolder;readText:()=>string|undefined;writeText?:(text:string,ifMatch:string)=>{etag:string;backupId:string|null};reload:()=>{ok:boolean};census?:()=>Promise<{ids:readonly string[];complete:boolean}>;reconcile?:(change:WorkerChange,isCurrent:()=>boolean)=>Promise<WorkerChangeResult>}
export function createRuleRuntime(directory:string,local:RuntimeLocal,sync:typeof syncDirectory=syncDirectory){
 const path=join(directory,'remote-rule-authority.json');let manifest:Manifest|null=null,connected=false,control={enabled:true,disabledRules:[] as string[]},received:RemoteRule[]=[],revision:string|null=null,source:RuntimeUpdate['source'],generation=0,error:string|null=null,fault=false,inventoryComplete=false;
 const pendingSpawns=new Set<string>(),pendingOrigins=new Map<string,AdmittedRuleIdentity>();let activationCensus:{generation:number;etag:string|undefined;at:number}|null=null;let retained=new Map<string,Retained>();const live:Rule[]=[];let initialized=new Set<ResourceProvider>();
 const observedSpecs=new Map<string,SpawnSpec>();
 const workers=createWorkerReconciler({valid:workerChangeCurrent,validResult:completedContinuationResult,apply:(change,isCurrent)=>local.reconcile?local.reconcile(change,isCurrent):Promise.resolve({status:'blocked',reason:'Worker handoff is unavailable'}),state:recordWorkerChange});
 function validate(value:unknown):Manifest{
  const m=value as Manifest;if(!m||m.version!==1||typeof m.active!=='boolean'||!m.source||!/^([0-9a-f-]{36})$/.test(m.source.serverId)||!/^([0-9a-f-]{36})$/.test(m.source.authorizationId)||typeof m.revision!=='string'||!Array.isArray(m.remote)||!Array.isArray(m.retained)||m.retained.length>MAX_AGENTS)throw Error('Invalid remote authority manifest');
  if([...m.baseline.rules,...m.remote.map(r=>r.definition)].some(r=>r.resourceProvider==='filesystem'&&r.id==='managed-sessions'))throw Error('Reserved built-in rule namespace');parseRules(m.baseline);parseRules({rules:m.remote.map(r=>r.definition)});parseRules({rules:m.observationGraph});if(!Array.isArray(m.history)||m.history.length>1000)throw Error('Invalid rule history');parseRules({rules:m.history});if(m.remote.some(r=>r.serverId!==m.source.serverId||r.authorizationId!==m.source.authorizationId||r.id!==`remote:${m.source.serverId}:${m.source.authorizationId}:${r.definition.id}`||r.sourceRuleId!==r.definition.id))throw Error('Invalid cached rule provenance');
  for(const [id,entry]of m.retained){if(typeof id!=='string'||typeof entry.known!=='boolean'||typeof entry.managed!=='boolean')throw Error('Invalid retained rule');const decoded=decodeAnyAgentKey(id);if(!decoded||decoded.ruleId!==entry.rule.id||decoded.resourceProvider!==entry.rule.resourceProvider)throw Error('Invalid retained identity');if(entry.origin)entry.origin=restoreRetainedProvenance({provider:decoded.resourceProvider,kind:decoded.kind,ruleId:decoded.ruleId,...(decoded.kind==='resource'&&decoded.resourceProvider!=='filesystem'?{resourceId:decoded.resourceId}:{}),admittedRule:entry.origin},m.source).admittedRule!;parseRules({rules:[...m.history.filter(r=>r.id!==entry.rule.id),entry.rule]});if(Object.hasOwn(entry,'appliedPreferences'))parseRules({rules:[appliedRule(entry)]});if(entry.reconciliation&&(!/^[a-f0-9]{64}$/.test(entry.reconciliation.token)||!['pending','applied','blocked','superseded','disabled'].includes(entry.reconciliation.status)))throw Error('Invalid worker reconciliation record');}
  if(m.deactivation&&(typeof m.deactivation.originalText!=='string'||typeof m.deactivation.emptyEtag!=='string'))throw Error('Invalid deactivation record');return m;
 }
 try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>MAX)throw Error('Unsafe remote authority manifest');manifest=validate(JSON.parse(readFileSync(path,'utf8')));retained=new Map(manifest.retained);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 function initializationRules():Rule[]{
  if(!manifest?.active)return [...local.holder.getRules()];
  const rules=new Map(manifest.remote.map(r=>[keyOf(r.definition),structuredClone(r.definition)]));
  for(const entry of retained.values())if(entry.managed&&entry.known){const key=keyOf(entry.rule);const current=rules.get(key);rules.set(key,{...structuredClone(current??entry.rule),enabled:true});}
  return [...rules.values()];
 }
 const initial=initializationRules();initialized=new Set(initial.filter(r=>r.enabled).map(r=>r.resourceProvider));
 function persist(next:Manifest){const text=JSON.stringify(next);if(Buffer.byteLength(text)>MAX)throw Error('Remote authority snapshot exceeds local storage bound');const temp=join(directory,`.remote-authority-${randomUUID()}.tmp`);let installed=false;
  try{writeFileSync(temp,text,{flag:'wx',mode:0o600});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);installed=true;manifest=next;sync(directory);}catch(e){if(installed)manifest=next;fault=true;error='Remote authority persistence requires recovery';generation++;refresh();throw e;}finally{try{unlinkSync(temp);}catch{}}
 }
 function saveRetained(){if(manifest)persist({...manifest,retained:[...retained]});}
 const definitions=()=>manifest?.active?manifest.observationGraph:[...local.holder.getRules()];
 const graphFingerprint=(rules:readonly Rule[])=>JSON.stringify([...rules].sort((a,b)=>a.id.localeCompare(b.id)).map(r=>{const fields=['id','resourceProvider','query','execution','relationships','linkedEventing','linkedPollIntervalMs','maxLinkedItems','linkedRemoteLinks','linkedDescriptionLinks'];return fields.map(k=>(r as unknown as Record<string,unknown>)[k]);}));
 // Fields a retained worker's own in-flight traversal depends on staying stable — never membership
 // (`query`/`id`/`resourceProvider`, see nextObservationGraph) — so that only THESE need to freeze.
 const OBSERVATION_BEHAVIOR_FIELDS=['execution','relationships','linkedEventing','linkedPollIntervalMs','maxLinkedItems','linkedRemoteLinks','linkedDescriptionLinks'] as const;
 const observationBehaviorOf=(rule:Rule)=>{const out:Record<string,unknown>={};for(const k of OBSERVATION_BEHAVIOR_FIELDS)out[k]=(rule as unknown as Record<string,unknown>)[k];return out;};
 function graphDeferred(){return !!manifest?.active&&graphFingerprint(manifest.observationGraph)!==graphFingerprint(manifest.remote.map(r=>r.definition));}
 function heldObservationKeys(graph:readonly Rule[]){
  const previous=new Map(graph.map(rule=>[keyOf(rule),rule]));
  const held=new Set([...retained.values()].filter(entry=>entry.managed).map(entry=>keyOf(entry.rule)));
  const pending=[...held];for(let i=0;i<pending.length;i++){const old=previous.get(pending[i]!),rel=old?.relationships;for(const id of [rel?.childRule,...(rel?.inwardConnectionRules??[])]){const dependency=id?[...previous.values()].find(rule=>rule.id===id):undefined;if(dependency&&!held.has(keyOf(dependency))){held.add(keyOf(dependency));pending.push(keyOf(dependency));}}}
  return held;
 }
 function nextObservationGraph(parsed:readonly Rule[]):Rule[]{
  const previous=new Map((manifest?.observationGraph??[]).map(rule=>[keyOf(rule),rule]));
  const held=heldObservationKeys([...previous.values()]);
  // A DIRECTLY retained key (some managed identity's own rule — never merely reached via
  // childRule/inwardConnectionRules below) must keep admitting and retiring resources on the latest
  // wire query: a retained worker elsewhere under the same rule has no bearing on whether some OTHER
  // resource is currently eligible. What that worker's own in-flight traversal DOES still need frozen
  // is the observation-BEHAVIOR shape (maxLinkedItems etc.) it is actively using — so only those
  // fields, never membership, stay pinned to the old value until every resident under the key drains.
  const directRoots=new Set([...retained.values()].filter(entry=>entry.managed).map(entry=>keyOf(entry.rule)));
  const next=parsed.map(rule=>{const old=previous.get(keyOf(rule));if(!old||!held.has(keyOf(rule)))return structuredClone(rule);
   return directRoots.has(keyOf(rule))?{...structuredClone(rule),...observationBehaviorOf(old)}:{...structuredClone(old),enabled:rule.enabled};});
  // A dependency with no parsed counterpart at all (or a withdrawn direct root) has no live value to
  // take membership from either way — keep the entire prior entry, exactly as a dependency would.
  for(const [key,old]of previous)if(held.has(key)&&!parsed.some(rule=>keyOf(rule)===key))next.push(structuredClone(old));
  return next;
 }
 function observers(rule:Rule){return [...retained.values()].some(r=>r.managed&&r.known&&keyOf(r.rule)===keyOf(rule));}
 function observationHeld(rule:Rule){return !!manifest&&heldObservationKeys(manifest.observationGraph).has(keyOf(rule));}
 function observationAllowed(rule:Rule){return !fault&&(!manifest?.active||inventoryComplete&&connected&&!error&&control.enabled&&rule.enabled&&initialized.has(rule.resourceProvider));}
 function remoteIdentity(rule:Rule){return `remote:${manifest!.source.serverId}:${manifest!.source.authorizationId}:${rule.id}`;}
 // Scoped to admission, NOT to the dependency-freeze `nextObservationGraph` already applies: a rule
 // with no live counterpart on the wire at all can never admit a new resource (withdrawal, direct
 // root or not — its existing retained worker stays protected regardless, since protectStop/
 // protectRespawn never consult `allowed`/`ruleGraphDeferred`). Short of outright withdrawal, a
 // DIRECTLY retained rule's exposed `rule.query` already tracks the live wire (nextObservationGraph),
 // so the rest of its definition drifting (OBSERVATION_BEHAVIOR_FIELDS — maxLinkedItems etc, still
 // pinned for that worker's own in-flight traversal) must never fence any OTHER resource's admission
 // under the SAME rule — that reintroduces the incident. A rule only reached as another rule's
 // dependency (never a direct root itself) has no such exemption: its exposed definition, query
 // included, stays frozen in full and unconditionally (protecting a DIFFERENT rule's in-flight
 // traversal, not an admission backlog), so any drift there still defers it exactly as before this
 // fix — existing dependency-freeze coverage asserts this unchanged. deferredRuleDetails() below
 // reports all of this for operators without it ever gating admission on its own.
 function ruleGraphDeferred(rule:Rule){
  if(!manifest?.active)return false;
  const desired=manifest.remote.find(row=>keyOf(row.definition)===keyOf(rule))?.definition;
  if(!desired)return true;
  if([...retained.values()].some(entry=>entry.managed&&keyOf(entry.rule)===keyOf(rule)))return false;
  return graphFingerprint([rule])!==graphFingerprint([desired]);
 }
 function allowed(rule:Rule){return !fault&&(!manifest?.active||inventoryComplete&&connected&&!error&&!ruleGraphDeferred(rule)&&control.enabled&&rule.enabled&&!control.disabledRules.includes(remoteIdentity(rule))&&initialized.has(rule.resourceProvider));}
 const DEFERRABLE_FIELDS=['query',...OBSERVATION_BEHAVIOR_FIELDS] as const;
 function deferredRuleDetails(){
  if(!manifest?.active)return [] as {id:string;resourceProvider:string;admissionBlocked:boolean;differingFields:string[];holdingWorkers:string[];unblockCondition:string}[];
  const graph=manifest.observationGraph,exposed=new Map(graph.map(rule=>[keyOf(rule),rule]));
  const held=heldObservationKeys(graph);
  const directRoots=new Set([...retained.values()].filter(entry=>entry.managed).map(entry=>keyOf(entry.rule)));
  const out:{id:string;resourceProvider:string;admissionBlocked:boolean;differingFields:string[];holdingWorkers:string[];unblockCondition:string}[]=[];
  for(const key of held){
   const current=exposed.get(key);if(!current)continue;
   const desired=manifest.remote.find(r=>keyOf(r.definition)===key)?.definition;
   const differingFields=desired?DEFERRABLE_FIELDS.filter(field=>JSON.stringify((current as unknown as Record<string,unknown>)[field])!==JSON.stringify((desired as unknown as Record<string,unknown>)[field])):['rule withdrawn from the live remote definition'];
   if(differingFields.length===0)continue;
   const holdingWorkers=[...retained].filter(([,entry])=>entry.managed&&keyOf(entry.rule)===key).map(([id])=>id);
   const direct=directRoots.has(key),admissionBlocked=!direct||!desired;
   out.push({id:current.id,resourceProvider:current.resourceProvider,admissionBlocked,differingFields:[...differingFields],holdingWorkers,unblockCondition:!desired?'This rule has no live counterpart on the remote definition at all, so no new resource can be admitted under it; the holding worker(s) above stay protected and running until they retire naturally.':direct?'Admission already follows the live query; only this rule\'s observation-behavior fields stay pinned to the holding worker(s) above until they drain naturally.':'This rule is only held as another rule\'s dependency, so its own definition (including its query) stays pinned in full until every worker retained under it drains naturally.'});
  }
  return out;
 }
 function refresh(){const defs=definitions();live.splice(0,live.length,...defs.map(r=>({...structuredClone(r),enabled:r.enabled&&(allowed(r)||observationHeld(r)&&observationAllowed(r))})));}
 function changed(){generation++;refresh();}
 refresh();
 function schedulingSignature(){return JSON.stringify([manifest?.active??false,manifest?.active?[manifest.observationGraph,manifest.remote.map(r=>r.definition)]:null,control,connected,error,fault]);}
 function update(value:RuntimeUpdate){const before=schedulingSignature();control=structuredClone(value.control);received=structuredClone([...value.rules]);revision=value.revision;source=value.source;connected=value.connected;
  if(manifest?.active&&connected){try{if(!source||source.serverId!==manifest.source.serverId||source.authorizationId!==manifest.source.authorizationId||!revision)throw Error('Remote authority identity mismatch');const parsed=parseRules({rules:received.map(r=>r.definition)});if(parsed.some(r=>r.resourceProvider==='filesystem'&&r.id==='managed-sessions'))throw Error('Reserved built-in rule namespace');if(received.some(r=>r.id!==`remote:${source!.serverId}:${source!.authorizationId}:${r.definition.id}`||r.sourceRuleId!==r.definition.id||r.serverId!==source!.serverId||r.authorizationId!==source!.authorizationId))throw Error('Remote provenance mismatch');
    const archive=new Map(manifest.history.map(r=>[r.id,r]));for(const r of parsed){if(archive.has(r.id)&&archive.get(r.id)!.resourceProvider!==r.resourceProvider)throw Error('Provider identity changes require a new rule ID');archive.set(r.id,r);}if(archive.size>1000)throw Error('Rule history bound exceeded');const observationGraph=nextObservationGraph(parsed);const next={...manifest,remote:received,observationGraph,revision,history:[...archive.values()],retained:[...retained]};if(fault||JSON.stringify(next)!==JSON.stringify(manifest))persist(next);fault=false;error=parsed.some(r=>r.enabled&&(!initialized.has(r.resourceProvider)))?'A newly declared provider requires a controlled restart':null;
   }catch{error='Remote authority update could not be validated or saved';connected=false;}
  }
  if(manifest?.active){if(before!==schedulingSignature())changed();else refresh();reconcileWorkers();}
 }
 function plan(){const text=local.readText();if(sourceEtagOf(text)!==local.holder.getSourceEtag())return {equivalent:false,problems:['Reload the changed local rule file before cutover'],localDigest:null,remoteDigest:null,bindings:[]};let doc:unknown;try{doc=JSON.parse(text??'{}');}catch{return {equivalent:false,problems:['Local rule document is unavailable'],localDigest:null,remoteDigest:null,bindings:[]};}if(!connected||!source||!revision)return {equivalent:false,problems:['A current authoritative connection is required'],localDigest:null,remoteDigest:null,bindings:[]};return prepareRuleCutover(doc,received,source);}
 function activate(input:{localDigest:string;remoteDigest:string;confirm:boolean}){
  if(manifest?.active)throw Error('Remote authority is already active');if(!activationCensus||activationCensus.generation!==generation||activationCensus.etag!==sourceEtagOf(local.readText())||Date.now()-activationCensus.at>10000)throw Error('A fresh complete worker census is required before activation');const p=plan();if(!p.equivalent||input.confirm!==true||p.localDigest!==input.localDigest||p.remoteDigest!==input.remoteDigest||!source||!revision)throw Error('Review an unchanged equivalent cutover plan first');
  if(!control.enabled||received.some(r=>r.definition.enabled&&control.disabledRules.includes(r.id)))throw Error('Local remote-config overrides prevent equivalent admission');
  if(received.some(r=>r.definition.enabled&&(!initialized.has(r.definition.resourceProvider))))throw Error('Provider initialization does not support this cutover');
  for(const [id,r]of retained)retained.set(id,{...r,managed:true});
  const next:Manifest={version:1,active:true,source,baseline:{rules:structuredClone(p.rules)},remote:structuredClone(received),observationGraph:structuredClone(p.rules),history:structuredClone(p.rules),revision,retained:[...retained]};persist(next);fault=false;error=null;changed();return summary();
 }
 function deactivateLocal(input:{localDigest:string;remoteDigest:string;confirm:boolean}){
  if(!manifest?.active||!local.writeText)throw Error('Remote authority is not active');const p=plan();if(!p.equivalent||input.confirm!==true||p.localDigest!==input.localDigest||p.remoteDigest!==input.remoteDigest||!control.enabled||!connected||error||graphDeferred())throw Error('A fresh equivalent delivery is required before deactivating local rules');
  const original=local.readText();if(original===undefined)throw Error('Local rules are missing');const empty='{ "rules": [] }\n',etag=sourceEtagOf(original)!;persist({...manifest,deactivation:{originalText:original,emptyEtag:sourceEtagOf(empty)!}});
  const result=local.writeText(empty,etag);if(!local.reload().ok)throw Error('Local deactivation needs recovery; remote authority remains active');persist({...manifest!,deactivation:{originalText:original,emptyEtag:result.etag,backupId:result.backupId}});changed();return {backupId:result.backupId,...summary()};
 }
 function rollback(confirm:boolean){if(!manifest?.active||confirm!==true)throw Error('Confirm rollback of an active authority');const d=manifest.deactivation;
  if(d){const text=local.readText();if(text!==d.originalText){if(sourceEtagOf(text)!==d.emptyEtag||!local.writeText)throw Error('Local rules changed; rollback requires review');local.writeText(d.originalText,d.emptyEtag);if(!local.reload().ok)throw Error('Local rollback reload failed');}}
  const p=prepareRuleCutover({rules:local.holder.getRules()},manifest.baseline.rules.map(definition=>({id:`remote:${manifest!.source.serverId}:${manifest!.source.authorizationId}:${definition.id}`,source:'remote',...manifest!.source,sourceRuleId:definition.id,definition,executionState:'staged'})),manifest.source);
  if(!p.equivalent)throw Error('Restore the equivalent local baseline before rollback');persist({...manifest,active:false,retained:[...retained]});fault=false;error=null;changed();return summary();
 }
 function ruleFor(id:string){if(ownsManagedSessionAgent(id))return undefined;const decoded=decodeAnyAgentKey(id);return decoded?definitions().find(r=>r.id===decoded.ruleId&&r.resourceProvider===decoded.resourceProvider):undefined;}
 function appliedRule(entry:Retained):Rule{const rule=structuredClone(entry.rule);if(Object.hasOwn(entry,'appliedPreferences')){if(entry.appliedPreferences===null)delete rule.agentPreferences;else rule.agentPreferences=structuredClone(entry.appliedPreferences!);}return rule;}
 function desiredRule(id:string){const decoded=decodeAnyAgentKey(id);return decoded?manifest?.remote.find(r=>r.definition.id===decoded.ruleId&&r.definition.resourceProvider===decoded.resourceProvider)?.definition:undefined;}
 const preferences=(rule:Rule)=>JSON.stringify(rule.agentPreferences??null);
 function desiredEnabled(rule:Rule){return connected&&!fault&&!error&&control.enabled&&rule.enabled&&!control.disabledRules.includes(remoteIdentity(rule));}
 function workerToken(rule:Rule){return createHash('sha256').update(JSON.stringify([manifest?.source,rule,control.enabled,control.disabledRules.includes(remoteIdentity(rule))])).digest('hex');}
 function continuationBinding(id:string,entry:Retained,rule:Rule){
  const fence=local.rollout,spec=fence?.continuationSpec?.(),last=entry.lastHandoff;
  return !!spec&&fence!.workerKey===id&&entry.managed&&entry.known&&last?.status==='blocked'&&last.partial===true&&last.current?.paneId===spec.source.paneId&&last.current.provider===spec.source.provider&&last.token===spec.desiredToken&&workerToken(rule)===spec.desiredToken&&spec.authority.serverId===manifest?.source.serverId&&spec.authority.authorizationId===manifest.source.authorizationId&&spec.authority.deploymentId===local.deploymentId;
 }
 function explicitContinuationAdmitsPartial(id:string,entry:Retained,rule:Rule){return !!local.rollout&&['pending','claimed'].includes(local.rollout.summary().status)&&continuationBinding(id,entry,rule);}
 function workerChangeCurrent(change:WorkerChange){const entry=retained.get(change.id),rule=desiredRule(change.id);return !!manifest?.active&&!!entry?.managed&&entry.known&&!!rule&&desiredEnabled(rule)&&workerToken(rule)===change.token&&!(entry.needsReconciliation&&entry.lastHandoff?.partial&&!explicitContinuationAdmitsPartial(change.id,entry,rule));}
 function completedContinuationResult(change:WorkerChange,result:Pick<WorkerChangeState,'status'|'current'>){
  const entry=retained.get(change.id),rule=desiredRule(change.id),fence=local.rollout,spec=fence?.continuationSpec?.();
  return result.status==='applied'&&!!manifest?.active&&!!entry&&!!rule&&desiredEnabled(rule)&&workerToken(rule)===change.token&&continuationBinding(change.id,entry,rule)&&fence?.summary().status==='applied'&&!!spec&&result.current?.paneId===spec.target.paneId&&result.current.provider==='claude';
 }
 function recordWorkerChange(change:WorkerChange,state:WorkerChangeState){
  const previous=retained.get(change.id);if(!previous)return;const next=structuredClone(previous),rule=desiredRule(change.id);if(!(state.status==='pending'&&rule&&previous.needsReconciliation&&previous.lastHandoff?.partial&&explicitContinuationAdmitsPartial(change.id,previous,rule)))next.lastHandoff={...structuredClone(state),token:change.token};
  if(state.current&&state.partial)next.needsReconciliation=true;
  if(rule&&workerToken(rule)===change.token){next.reconciliation={...structuredClone(state),...(state.status==='superseded'&&state.partial?{status:'blocked' as const,reason:'A superseded transaction changed physical identity; reconciliation requires inspection'}:{}),token:change.token};const completedContinuation=completedContinuationResult(change,state);if(state.status==='applied'&&(workerChangeCurrent(change)||completedContinuation)){next.appliedPreferences=structuredClone(rule.agentPreferences??null);next.needsReconciliation=false;}}
  retained.set(change.id,next);try{saveRetained();}catch(error){retained.set(change.id,previous);throw error;}refresh();if(state.status==='superseded')queueMicrotask(()=>reconcileWorkers());
 }
 function reconcileWorkers(retry=false){
  if(!manifest?.active)return;
  if(local.rollout&&connected&&!fault&&!error){const rule=desiredRule(local.rollout.workerKey);local.rollout.observe(rule?{token:workerToken(rule),enabled:desiredEnabled(rule),...(local.deploymentId?{authority:{...manifest.source,deploymentId:local.deploymentId}}:{})}:undefined);}
  for(const [id,entry]of retained){
   if(!entry.managed||ownsManagedSessionAgent(id))continue;const rule=desiredRule(id);
   if(!rule||!desiredEnabled(rule)){workers.cancel(id);if(rule&&(!rule.enabled||!control.enabled||control.disabledRules.includes(remoteIdentity(rule)))){const disabled={status:'disabled' as const,token:workerToken(rule),reason:'Desired rule admission is disabled'};if(JSON.stringify(entry.reconciliation)!==JSON.stringify(disabled)){entry.reconciliation=disabled;saveRetained();}}continue;}
   if(preferences(appliedRule(entry))===preferences(rule)&&!entry.needsReconciliation){workers.cancel(id);continue;}
   const token=workerToken(rule),spec=observedSpecs.get(id);
   if(!entry.known||!spec){const blocked={status:'blocked' as const,token,reason:entry.known?'A complete observed worker specification is required':'Applied worker policy is unknown'};if(JSON.stringify(entry.reconciliation)!==JSON.stringify(blocked)){entry.reconciliation=blocked;saveRetained();}continue;}
   if(entry.needsReconciliation&&entry.lastHandoff?.partial&&!explicitContinuationAdmitsPartial(id,entry,rule)){const blocked={...structuredClone(entry.lastHandoff),status:'blocked' as const,token,reason:'A prior handoff changed physical identity; exact surviving-pane ownership requires inspection'};if(JSON.stringify(entry.reconciliation)!==JSON.stringify(blocked)){entry.reconciliation=blocked;saveRetained();}continue;}
   const next=structuredClone(spec);delete next.agents;if(rule.agentPreferences)next.agents=structuredClone(rule.agentPreferences);workers.request({id,token,spec:next,...(local.deploymentId?{authority:{...manifest.source,deploymentId:local.deploymentId}}:{})},retry);
  }
 }
 function workerPending(id:string){if(local.rollout?.workerKey===id)return true;const entry=retained.get(id),rule=desiredRule(id);return !!entry?.managed&&!!rule&&(preferences(appliedRule(entry))!==preferences(rule)||!!entry.needsReconciliation);}
 function ruleForAgent(id:string){const entry=retained.get(id);if(entry?.managed||manifest?.active)return entry?.known?appliedRule(entry):undefined;return ruleFor(id);}
 function admittedRuleIdentity(id:string):AdmittedRuleIdentity|undefined {
  const entry=retained.get(id);return entry?.known&&entry.origin&&!pendingSpawns.has(id)?structuredClone(entry.origin):undefined;
 }
 function ruleForAdmission(id:string){const entry=retained.get(id);return entry?.managed?entry.known?appliedRule(entry):undefined:ruleFor(id);}
 function captureCensus(running:readonly string[],complete:boolean,owns:(id:string)=>boolean,proof=false){const before=inventoryComplete;inventoryComplete=complete;const have=new Set(running);let dirty=false;for(const [id]of retained)if(complete&&owns(id)&&!have.has(id)&&!pendingSpawns.has(id)){retained.delete(id);observedSpecs.delete(id);workers.cancel(id);dirty=true;}for(const id of running)if(!retained.has(id)){const rule=manifest?.active?manifest.baseline.rules.find(r=>{const d=decodeAnyAgentKey(id);return d?.ruleId===r.id&&d.resourceProvider===r.resourceProvider})??ruleFor(id):ruleFor(id);if(rule){if(retained.size>=MAX_AGENTS)throw Error('Admitted context bound exceeded');retained.set(id,{rule:structuredClone(rule),known:!manifest?.active,managed:!!manifest?.active});dirty=true;}}if(dirty&&manifest){const graph=nextObservationGraph(manifest.remote.map(r=>r.definition));const adopt=manifest.active&&graphFingerprint(graph)!==graphFingerprint(manifest.observationGraph);if(adopt)manifest={...manifest,observationGraph:graph};saveRetained();if(adopt)changed();else refresh();}if(before!==inventoryComplete&&manifest?.active)changed();reconcileWorkers(true);if(proof&&complete&&!manifest?.active)activationCensus={generation,etag:sourceEtagOf(local.readText()),at:Date.now()};}
 function recordFullCensus(running:readonly string[],complete=false){captureCensus(running,complete,()=>true,true);}
 async function prepareActivation(){if(!local.census)throw Error('Complete worker census unavailable');const before=generation,etag=sourceEtagOf(local.readText());const census=await local.census();if(before!==generation||etag!==sourceEtagOf(local.readText()))throw Error('Cutover state changed during census');recordFullCensus(census.ids,census.complete);if(!census.complete)throw Error('Worker inventory is incomplete or ambiguous');}
 function managed(id:string){if(ownsManagedSessionAgent(id))return false;return !!retained.get(id)?.managed||(!!manifest?.active||fault)&&!!decodeAnyAgentKey(id);}
 function current(id:string,lease:number){const r=ruleFor(id);return !fault&&lease===generation&&!!r&&allowed(r);}
 // Membership (query) is never part of this comparison: it now always tracks the live wire for a
 // directly retained rule (see nextObservationGraph) and drifting on its own is not a reason to treat
 // an otherwise-healthy, already-admitted worker as incompatible — only the observation-BEHAVIOR shape
 // it is actively relying on (maxLinkedItems etc.) does that.
 function observationCompatible(a:Rule,b:Rule){return JSON.stringify(OBSERVATION_BEHAVIOR_FIELDS.map(k=>(a as unknown as Record<string,unknown>)[k]))===JSON.stringify(OBSERVATION_BEHAVIOR_FIELDS.map(k=>(b as unknown as Record<string,unknown>)[k]));}
 function lifecycleEnabled(rule:Rule){return observationAllowed(rule)&&(!manifest?.active||!control.disabledRules.includes(remoteIdentity(rule)));}
 // Same reasoning as observationCompatible above: normalize away a query that moved out from under
 // this worker on its own before comparing the rest (role/brief/preferences/behavior) for an exact
 // match — a query-only change must never block this worker's own respawn.
 function safeLifecycle(id:string,lease:number){const entry=retained.get(id),r=ruleFor(id);return !managed(id)||!!entry?.known&&!!r&&lease===generation&&allowed(r)&&fingerprint({...appliedRule(entry),query:r.query})===fingerprint(r);}
 // OFF is an explicit configuration verdict, never inferred from a missing rule or failed discovery.
 function configuredOff(id:string,lease:number):boolean {
  if(!manifest?.active||fault||error||!connected||!control.enabled||!inventoryComplete||lease!==generation||ownsManagedSessionAgent(id))return false;
  const entry=retained.get(id),rule=desiredRule(id),decoded=decodeAnyAgentKey(id);
  return !!entry?.managed&&entry.known&&!entry.needsReconciliation&&!entry.lastHandoff?.partial&&entry.lastHandoff?.status!=='pending'&&!!rule&&!!decoded&&keyOf(entry.rule)===keyOf(rule)&&decoded.resourceProvider===rule.resourceProvider&&decoded.ruleId===rule.id&&(!rule.enabled||control.disabledRules.includes(remoteIdentity(rule)));
 }
 function notificationContext(id:string){if(ownsManagedSessionAgent(id))return 'local';const entry=retained.get(id);if(manifest?.active||entry?.managed)return entry?.known?fingerprint(entry.rule):undefined;const rule=ruleFor(id);return rule?fingerprint(rule):'local';}
 function noticeDisposition(id:string,context:string):'deliver'|'defer'|'discard'{const actual=notificationContext(id);if(!actual||actual!==context)return 'discard';if(!managed(id))return 'deliver';const r=ruleFor(id);return !fault&&!workerPending(id)&&inventoryComplete&&connected&&!error&&control.enabled&&!!r&&!!manifest?.remote.some(v=>v.definition.id===r.id&&v.definition.enabled)&&!control.disabledRules.includes(remoteIdentity(r))?'deliver':'defer';}
 function policy(owns:(id:string)=>boolean=()=>true):RuntimePolicy{return {
  disabledWorkers:lease=>[...retained.keys()].filter(id=>owns(id)&&configuredOff(id,lease)),
  census:value=>captureCensus(value.ids,value.complete,owns),notificationContext,noticeDisposition,generation:()=>generation,scope:filter=>policy(id=>owns(id)&&filter(id)),
  canObserve:provider=>!fault&&(!manifest?.active||inventoryComplete&&connected&&!error&&control.enabled&&definitions().some(r=>r.enabled&&(!provider||r.resourceProvider===provider)&&(allowed(r)||observationHeld(r)&&observationAllowed(r)))),
  prepare(desired,running,lease){for(const [id,spec]of desired)if(owns(id)&&retained.has(id)&&spec.key===id)observedSpecs.set(id,structuredClone(spec));reconcileWorkers();const have=new Set(running);let dirty=false;
   for(const id of running)if(!retained.has(id)){const rule=manifest?.active?manifest.baseline.rules.find(r=>{const d=decodeAnyAgentKey(id);return d?.ruleId===r.id&&d.resourceProvider===r.resourceProvider})??ruleFor(id):ruleFor(id);if(rule&&retained.size<MAX_AGENTS){retained.set(id,{rule:structuredClone(rule),known:!manifest?.active,managed:!!manifest?.active});dirty=true;}}
   if(dirty&&manifest)try{const graph=nextObservationGraph(manifest.remote.map(r=>r.definition));if(manifest.active&&graphFingerprint(graph)!==graphFingerprint(manifest.observationGraph)){manifest={...manifest,observationGraph:graph};saveRetained();changed();}else{saveRetained();refresh();}}catch{error='Admitted context could not be saved';connected=false;changed();}
   return new Map([...desired].filter(([id])=>!fault&&(manifest?.active?(have.has(id)||!managed(id)||current(id,lease)):!manifest||lease===generation)));
  },
  canAdmit:(id,lease)=>ownsManagedSessionAgent(id)||!fault&&(manifest?.active?(!managed(id)||current(id,lease)):!manifest||lease===generation),
  canSpawn(spec,lease){if(local.rollout)return false;if(ownsManagedSessionAgent(spec.key))return true;if(fault||manifest&&lease!==generation)return false;if(manifest?.active&&managed(spec.key)&&!current(spec.key,lease))return false;const rule=ruleFor(spec.key);if(!rule)return !managed(spec.key);if(retained.size>=MAX_AGENTS&&!retained.has(spec.key))return false;pendingSpawns.add(spec.key);pendingOrigins.set(spec.key,{id:rule.id,name:rule.id,...(manifest?.active?remoteAdmittedIdentity(manifest.source):{source:'local' as const})});retained.set(spec.key,{rule:structuredClone(rule),known:true,managed:!!manifest?.active});if(manifest)try{saveRetained();}catch{pendingSpawns.delete(spec.key);pendingOrigins.delete(spec.key);retained.delete(spec.key);error='Admission context could not be saved';connected=false;changed();return false;}return true;},
  spawnObservedExisting(id){if(pendingSpawns.has(id)){const entry=retained.get(id);if(entry){const {origin:_,...rest}=entry;retained.set(id,{...rest,...(manifest?.active?{known:false,managed:true}:{})});if(manifest)saveRetained();refresh();}pendingSpawns.delete(id);pendingOrigins.delete(id);}},spawnSucceeded:(id)=>{const origin=pendingOrigins.get(id),entry=retained.get(id);if(origin&&entry){retained.set(id,{...entry,origin:structuredClone(origin)});if(manifest)saveRetained();}pendingSpawns.delete(id);pendingOrigins.delete(id);},spawnFailed(id){pendingSpawns.delete(id);pendingOrigins.delete(id);/* A failed launch may already own a pane. Only a later reliable census may discard its policy. */},
  protectStop:(id,lease)=>{if(ownsManagedSessionAgent(id))return true;if(configuredOff(id,lease))return false;const e=retained.get(id),r=ruleFor(id);return managed(id)&&!(e?.known&&r&&lease===generation&&lifecycleEnabled(r)&&observationCompatible(e.rule,r));},protectRespawn:(id,lease)=>ownsManagedSessionAgent(id)||managed(id)&&!safeLifecycle(id,lease),
  canNotify:(id,_previous,next)=>{const entry=retained.get(id),r=ruleFor(id);return !managed(id)||!workerPending(id)&&next===generation&&!!entry?.known&&!!r&&next===generation&&observationAllowed(r)&&!!manifest?.remote.some(v=>v.definition.id===r.id&&v.definition.enabled)&&!control.disabledRules.includes(remoteIdentity(r))&&observationCompatible(entry.rule,r);},ignoreNotification:(id)=>managed(id)&&!!manifest?.active&&!retained.has(id)&&!pendingSpawns.has(id),
 };}
 function summary(){return {...(local.rollout?{canary:local.rollout.summary()}:{}),workerReconciliation:[...retained].flatMap(([id,entry])=>entry.reconciliation?[{id,...entry.reconciliation,...(workers.state(id)??{})}]:[]),authority:manifest?.active?'remote':'local',connected,revision:manifest?.revision??revision,inventoryComplete,phase:fault?'blocked':manifest?.active?!inventoryComplete?'inventory-uncertain':error?'blocked':!connected?'disconnected':!control.enabled?'master-off':graphDeferred()?'deferred':'active':'staged',error,generation,retainedAgents:[...retained.values()].filter(r=>r.managed).length,discoveryChangesDeferred:graphDeferred(),deferredRules:deferredRuleDetails(),unresolvedAgents:[...retained.values()].filter(r=>r.managed&&!r.known).length,localDeactivated:!!manifest?.deactivation&&sourceEtagOf(local.readText())===manifest.deactivation.emptyEtag};}
 return {settleReconciliation:()=>workers.idle(),retryReconciliation:()=>reconcileWorkers(true),admittedRuleIdentity,update,plan,activate,recordFullCensus,prepareActivation,ruleForAdmission,isUnresolvedAgent:(id:string)=>!ownsManagedSessionAgent(id)&&!!manifest?.active&&!!decodeAnyAgentKey(id)&&!retained.get(id)?.known,deactivateLocal,rollback,summary,getRules:()=>live,getInitializationRules:initializationRules,refreshLocal:()=>{if(!manifest?.active)changed();},ruleForAgent,observedWorkerIds:()=>[...retained.keys()],retainedRules:()=>[...retained].filter(([,r])=>r.managed&&r.known).map(([id,r])=>({id,rule:structuredClone(r.rule)})),policy:policy()};
}
export type RuleRuntime=ReturnType<typeof createRuleRuntime>;
