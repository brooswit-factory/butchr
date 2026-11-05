import {constants,openSync,closeSync,writeFileSync,fsyncSync,renameSync,unlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {parsePermit,type CanaryPermit} from '../control-panel/worker-rollout.js';
import {privateText,hash,verifyValidationRetirement} from './validation-retirement.js';
import {retirementWriterIdentity,claimRetirementWriter,type RetirementWriterIdentity} from './retirement-writer.js';
import {stable} from './staged-bootstrap.js';
export interface SuggestionConfirmation{kind:"user-confirmed-suggestion";reference:string;confirmedAt:number;target:Target;process:{pid:number;generation:string};suggestion:string;ansiLineSHA256:string;}
export interface AdoptionRequest{suggestionConfirmation?:SuggestionConfirmation;state:string;permit:string;socket:string;runtime:string;unit:string;workspaces:string;freezeRoot:string;repository:string;sourceHistory:string;nativeRoot:string;targetExecutable:string;}
type Target=NonNullable<CanaryPermit['continuation']>['target'];
export interface AdoptionSnapshot{target:Target;sourceAbsent:true;workspaceKey:string;preferences:{model:string;effort:string};process:unknown;workspace:unknown;histories:unknown;inventory:unknown;independentHolds:unknown;holdsClear:true;}
export interface AdoptionIO{assertStopped():Promise<void>;capture(permit:CanaryPermit):Promise<AdoptionSnapshot>;}
export interface AdoptionPlan{version:1;kind:'adopt-source-absent-target';request:AdoptionRequest;beforeSHA256:string;afterSHA256:string;afterText:string;evidence:unknown;snapshot:AdoptionSnapshot;writer:RetirementWriterIdentity;effects:{target:string;launches:0;closes:0;imports:0;preservesHistories:true;preservesWorkspace:true};confirmation:string;}
function absent(path:string){try{lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Existing transaction/output requires inspection');}
function durable(path:string,text:string){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}sync(path.slice(0,path.lastIndexOf('/')));}
function sync(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function retiredEvidence(r:AdoptionRequest){
 const recordText=privateText(join(r.state,'worker-canary-retired.json'),16384),record=JSON.parse(recordText);
 if(!/^[a-f0-9]{64}$/.test(record.confirmation)||record.archive!==join(r.state,'validation-retirement-'+record.confirmation+'.json'))throw Error('Invalid retired transaction binding');
 const archiveText=privateText(record.archive);if(hash(archiveText)!==record.archiveSHA256)throw Error('Retirement archive changed');
 const audit=JSON.parse(archiveText),p=audit.plan,{confirmation,...body}=p;
 if(audit.kind!=='validation-retirement'||hash(JSON.stringify(body))!==confirmation||confirmation!==record.confirmation||p.stateDirectory!==r.state||p.permitPath!==r.permit)throw Error('Retirement does not bind this exact historical operation');
 const text=privateText(r.permit,16384),permit=parsePermit(text);if(p.receiptPath!==join(r.state,'worker-canary-attempts',permit.permitId+'.jsonl'))throw Error('Receipt must remain inside the original private transaction directory');
 const receiptText=privateText(p.receiptPath),latchText=privateText(join(r.state,'worker-canary-mode.json'),16384);
 if(hash(text)!==p.permitSHA256||hash(receiptText)!==p.receiptSHA256||hash(latchText)!==p.latchSHA256||text!==audit.permit||receiptText!==audit.receipt||latchText!==audit.latch||p.workerKey!==permit.workerKey||!p.partialWorkerRemainsBlocked||!permit.continuation)throw Error('Exact spent partial-handoff evidence required');
 const events=receiptText.trimEnd().split('\n').map(l=>JSON.parse(l)),last=events.at(-1);
 if(!receiptText.endsWith('\n')||events[0]?.status!=='claimed'||last?.status!=='terminal'||last.result?.partial!==true||last.target!==permit.continuation.target.paneId)throw Error('Terminal partial transaction target differs');
 return {permit,evidence:{retiredRecordSHA256:hash(recordText),archiveSHA256:hash(archiveText),permitSHA256:hash(text),receiptSHA256:hash(receiptText),latchSHA256:hash(latchText)}};
}
function controls(r:AdoptionRequest){let text:string|null=null;try{text=privateText(join(r.state,'remote-overrides.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const value=text===null?{enabled:true,disabledRules:[]}:JSON.parse(text);if(value.enabled!==true||!Array.isArray(value.disabledRules)||value.disabledRules.length>10000||value.disabledRules.some((v:unknown)=>typeof v!=='string'||!/^remote:[a-f0-9-]{36}:[a-f0-9-]{36}:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v)))throw Error('Independent master/override hold');return {value,sha256:text===null?null:hash(text)};}
async function inspect(r:AdoptionRequest,io:AdoptionIO){
 await io.assertStopped();const {permit,evidence}=retiredEvidence(r),text=privateText(join(r.state,'remote-rule-authority.json')),m=JSON.parse(text),control=controls(r);
 const entries=m.retained?.filter((v:any)=>v[0]===permit.workerKey),entry=entries?.[0]?.[1],rules=m.remote?.filter((v:any)=>v.sourceRuleId===entry?.rule?.id&&v.definition?.resourceProvider===entry?.rule?.resourceProvider),rule=rules?.[0]?.definition;
 if(m.active!==true||m.source?.serverId!==permit.authority.serverId||m.source?.authorizationId!==permit.authority.authorizationId||entries?.length!==1||rules?.length!==1||entry.managed!==true||entry.known!==true||entry.needsReconciliation!==true||!entry.lastHandoff?.partial||entry.reconciliation?.partial!==true||entry.lastHandoff.current?.paneId!==permit.source.paneId||entry.reconciliation.current?.paneId!==permit.source.paneId||entry.lastHandoff.current.provider!==permit.source.provider||entry.lastHandoff.token!==permit.desiredToken||entry.reconciliation.status!=='blocked')throw Error('Only the exact obsolete source-absent partial handoff may be adopted');
 const remoteId=`remote:${m.source.serverId}:${m.source.authorizationId}:${rule.id}`;
 if(rule.enabled!==true||control.value.disabledRules.includes(remoteId)||rule.agentPreferences?.length!==1||rule.agentPreferences[0].harness!=='claude'||!rule.agentPreferences[0].model||!rule.agentPreferences[0].effort)throw Error('Enabled explicit Claude model/effort required');
 const token=hash(JSON.stringify([m.source,rule,control.value.enabled,control.value.disabledRules.includes(remoteId)]));if(entry.reconciliation.token!==token)throw Error('Desired settings/token changed or are not yet reconciled');
 const snapshot=await io.capture(permit),pref=rule.agentPreferences[0];
 if(stable(snapshot.target)!==stable(permit.continuation!.target)||snapshot.sourceAbsent!==true||snapshot.workspaceKey!==permit.workerKey||snapshot.holdsClear!==true||snapshot.preferences.model!==pref.model||snapshot.preferences.effort!==pref.effort)throw Error('Target identity, workspace, actual preferences or independent holds differ');
 if(privateText(join(r.state,'remote-rule-authority.json'))!==text||stable(controls(r))!==stable(control))throw Error('Desired authority changed during inspection');
 const next=structuredClone(m),selected=next.retained.find((v:any)=>v[0]===permit.workerKey)[1],current={paneId:snapshot.target.paneId,provider:'claude'};
 selected.appliedPreferences=structuredClone(rule.agentPreferences);selected.needsReconciliation=false;
 selected.lastHandoff={status:'applied',current,partial:false,token};selected.reconciliation={status:'applied',current,partial:false,token};
 return {text,afterText:JSON.stringify(next),evidence:{...evidence,controlsSHA256:control.sha256},snapshot};
}
export async function planFreshTargetAdoption(r:AdoptionRequest,io:AdoptionIO):Promise<AdoptionPlan>{
 if(!verifyValidationRetirement(r.state,r.permit))throw Error('Historical validation mode must already be retired');
 const first=await inspect(r,io),second=await inspect(r,io);if(stable(first)!==stable(second))throw Error('Recovery evidence changed during read-only planning');
 const body={version:1 as const,kind:'adopt-source-absent-target' as const,request:structuredClone(r),beforeSHA256:hash(first.text),afterSHA256:hash(first.afterText),afterText:first.afterText,evidence:first.evidence,snapshot:first.snapshot,writer:retirementWriterIdentity(r.state),effects:{target:first.snapshot.target.paneId,launches:0 as const,closes:0 as const,imports:0 as const,preservesHistories:true as const,preservesWorkspace:true as const}};
 return {...body,confirmation:hash(stable(body))};
}
export async function applyFreshTargetAdoption(plan:AdoptionPlan,confirm:string,approval:string,io:AdoptionIO){
 const {confirmation,...body}=plan;if(plan.kind!=='adopt-source-absent-target'||plan.version!==1||confirm!==confirmation||hash(stable(body))!==confirmation||!approval.trim()||approval.length>256)throw Error('Exact reviewed plan and explicit adoption authority required');
 if(!verifyValidationRetirement(plan.request.state,plan.request.permit))throw Error('Retirement proof changed');
 const state=plan.request.state,lock=join(state,'worker-canary-control.lock'),auditPath=join(state,'fresh-target-adoption-'+confirmation+'.json'),authority=join(state,'remote-rule-authority.json'),temp=join(state,'.fresh-target-'+confirmation+'.tmp');let resume=false;try{const audit=JSON.parse(privateText(auditPath));if(stable(audit.plan)!==stable(plan)||hash(audit.beforeText)!==plan.beforeSHA256)throw Error('Existing adoption intent differs');const status=freshTargetAdoptionStatus(state,confirmation);if(status.adopted)return {adopted:true,alreadyApplied:true,target:plan.effects.target,confirmation,auditPath,launches:0,closes:0,imports:0};if(!status.notApplied)throw Error('Interrupted adoption state requires inspection');resume=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}absent(temp);
 const fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);let uncertain=false;let writer:ReturnType<typeof claimRetirementWriter>|undefined;
 try{
  writer=claimRetirementWriter(state,plan.writer);writeFileSync(fd,'source-absent target adoption\n');fsyncSync(fd);
  const check=async()=>{writer!.assertOwned();const now=await inspect(plan.request,io);if(hash(now.text)!==plan.beforeSHA256||hash(now.afterText)!==plan.afterSHA256||stable(now.snapshot)!==stable(plan.snapshot)||stable(now.evidence)!==stable(plan.evidence))throw Error('Stale adoption plan; inspect again');return now;};
  const first=await check();await check();
  // Audit includes an exact rollback image and both state hashes. It is an intent
  // until status proves the authority matches afterSHA256. No workspace/history write.
  const auditText=JSON.stringify({version:1,kind:plan.kind,at:new Date().toISOString(),approval,plan,beforeText:first.text})+'\n';if(Buffer.byteLength(auditText)>8_000_000)throw Error('Adoption audit exceeds bounded private evidence limit');
  if(!resume)durable(auditPath,auditText);
  await check();await io.assertStopped();writer.assertOwned();if(hash(privateText(authority))!==plan.beforeSHA256)throw Error('Authority changed immediately before adoption');
  durable(temp,plan.afterText);uncertain=true;renameSync(temp,authority);sync(state);uncertain=false;
  return {adopted:true,target:plan.effects.target,confirmation,auditPath,launches:0,closes:0,imports:0};
 }finally{try{writer?.release();}finally{closeSync(fd);if(!uncertain){try{unlinkSync(temp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}unlinkSync(lock);sync(state);}}}
}
export function freshTargetAdoptionStatus(state:string,confirmation:string){
 if(!/^[a-f0-9]{64}$/.test(confirmation))throw Error('Exact adoption confirmation required');const auditPath=join(state,'fresh-target-adoption-'+confirmation+'.json'),audit=JSON.parse(privateText(auditPath)),plan=audit.plan as AdoptionPlan,{confirmation:c,...body}=plan;
 if(audit.kind!=='adopt-source-absent-target'||plan.request.state!==state||c!==confirmation||hash(stable(body))!==c||hash(audit.beforeText)!==plan.beforeSHA256||hash(plan.afterText)!==plan.afterSHA256)throw Error('Adoption audit changed');
 const text=privateText(join(state,'remote-rule-authority.json')),current=hash(text),actual=JSON.parse(text),after=JSON.parse(plan.afterText),key=parsePermit(privateText(plan.request.permit,16384)).workerKey;const adopted=actual.active===true&&stable(actual.source)===stable(after.source)&&stable(actual.retained?.find((v:any)=>v[0]===key))===stable(after.retained.find((v:any)=>v[0]===key));return {adopted,notApplied:current===plan.beforeSHA256,requiresInspection:!adopted&&current!==plan.beforeSHA256,auditPath,confirmation,target:plan.effects.target,physicalReadbackRequired:true};
}
