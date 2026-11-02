import {randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,writeFileSync,fsyncSync,renameSync,unlinkSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {stagedTargetName} from '@brooswit/drovr';
import {sha,type BootstrapEvidence} from './bootstrap-history.js';
import {privateText} from './validation-retirement.js';
export const stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export interface BootstrapRequest{workerKey:string;sourcePane:string;targetPane:string;stateDirectory:string;daemonOrigin:string;socketPath:string;nativeRoot:string;targetExecutable:string;}
export interface RollbackWorker{paneId:string;workspaceId:string;terminalId:string;cwd:string;provider:'codex'|'claude';name:string;native:{agent:string;kind:string;value:string}|null;process:{pid:number;generation:string;executable:string;executableIdentity:string};}
export interface BootstrapSnapshot{bootId:string;source:RollbackWorker;target:RollbackWorker;targetHistory:BootstrapEvidence;sourceHistory:{sha256:string;bytes:number;chars:number;normalImportChunks:number};authority:unknown;inventory:unknown;prompt:{sha256:string;empty:true};}
export interface BootstrapRollbackIO{inspect():Promise<BootstrapSnapshot>;targetAbsent():Promise<boolean>;historiesPreserved(snapshot:BootstrapSnapshot):Promise<boolean>;closeTarget():Promise<unknown>;}
export interface BootstrapRollbackPlan{version:1;kind:'rollback-uncommitted-bootstrap';transactionId:string;request:BootstrapRequest;snapshot:BootstrapSnapshot;effects:{closesOnlyTarget:string;keepsSource:string;preservesBothNativeHistories:true;normalReconciliationMayStartPaidHandoff:true};confirmation:string;}
function validate(request:BootstrapRequest,s:BootstrapSnapshot){
 const a=s.source,b=s.target;if(a.paneId!==request.sourcePane||b.paneId!==request.targetPane||a.paneId===b.paneId||a.provider!=='codex'||b.provider!=='claude'||a.cwd!==b.cwd||a.workspaceId===b.workspaceId||!a.terminalId||!b.terminalId||a.name!=='butchr-'+sha(request.workerKey).slice(0,24)||a.native?.agent!=='codex'||a.native.kind!=='id'||!a.native.value||b.native!==null)throw Error('Exact original source and uncommitted target ownership required');
 const names=new Set<string>();for(let i=0;i<16;i++)names.add(stagedTargetName(a.name,{paneId:a.paneId,provider:a.provider,cwd:a.cwd},b.paneId,b.provider,names));
 if(!names.has(b.name)||!s.targetHistory.noUsefulWorkProven||s.targetHistory.userTurns!==1||s.targetHistory.assistantTurns!==1||!s.prompt.empty||!s.sourceHistory.bytes||!s.bootId)throw Error('Target is not a proven empty owned bootstrap');
}
export async function planBootstrapRollback(request:BootstrapRequest,io:BootstrapRollbackIO):Promise<BootstrapRollbackPlan>{
 const first=await io.inspect();validate(request,first);const second=await io.inspect();validate(request,second);if(stable(first)!==stable(second))throw Error('Recovery evidence changed during planning');
 const body={version:1 as const,kind:'rollback-uncommitted-bootstrap' as const,transactionId:randomUUID(),request:structuredClone(request),snapshot:first,effects:{closesOnlyTarget:first.target.paneId,keepsSource:first.source.paneId,preservesBothNativeHistories:true as const,normalReconciliationMayStartPaidHandoff:true as const}};
 return {...body,confirmation:sha(stable(body))};
}
function planValid(plan:BootstrapRollbackPlan,confirm:string){const {confirmation,...body}=plan;if(plan.version!==1||plan.kind!=='rollback-uncommitted-bootstrap'||! /^[a-f0-9-]{36}$/.test(plan.transactionId)||confirmation!==confirm||sha(stable(body))!==confirm)throw Error('Exact reviewed rollback plan confirmation required');validate(plan.request,plan.snapshot);}
function privateDirectory(path:string){const s=lstatSync(path);if(realpathSync(path)!==path||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o077))throw Error('Existing canonical owner-private state directory required');}
export function bootstrapReceiptPath(plan:BootstrapRollbackPlan){return join(plan.request.stateDirectory,'staged-bootstrap-rollback-'+sha(stable([plan.snapshot.bootId,plan.snapshot.target.paneId,plan.snapshot.target.process.generation]))+'.json');}
interface Attempt{plan:BootstrapRollbackPlan;approvalReference:string;phase:'claimed'|'close-requested'|'refused-before-close'|'applied';at:string;}
interface Ledger{version:1;attempts:Attempt[];}
function readLedger(path:string):Ledger{try{const data=JSON.parse(privateText(path));if(data.version!==1||!Array.isArray(data.attempts)||!data.attempts.length||data.attempts.length>32)throw Error('Invalid rollback audit');for(const a of data.attempts)planValid(a.plan,a.plan.confirmation);return data;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:1,attempts:[]};throw e;}}
function writeLedger(path:string,value:Ledger){const temp=path+'.'+randomUUID()+'.tmp',fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,stable(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);const dir=openSync(join(path,'..'),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
export async function bootstrapRollbackStatus(plan:BootstrapRollbackPlan,io:BootstrapRollbackIO){planValid(plan,plan.confirmation);privateDirectory(plan.request.stateDirectory);const path=bootstrapReceiptPath(plan),ledger=readLedger(path),last=ledger.attempts.at(-1),absent=await io.targetAbsent();return {receiptPath:path,phase:last?.phase??'not-applied',targetAbsent:absent,historiesPreserved:await io.historiesPreserved(plan.snapshot)};}
/** Only one exact-target close may be in flight. A transport error preserves
 * the lock/audit; later calls inspect absence rather than issuing another RPC. */
export async function applyBootstrapRollback(plan:BootstrapRollbackPlan,confirm:string,approvalReference:string,io:BootstrapRollbackIO){
 planValid(plan,confirm);if(!approvalReference.trim()||approvalReference.length>256)throw Error('Explicit rollback approval reference required');privateDirectory(plan.request.stateDirectory);
 const path=bootstrapReceiptPath(plan),prior=readLedger(path),previous=prior.attempts.at(-1);
 if(previous&&['close-requested','applied'].includes(previous.phase)&&await io.targetAbsent()){
  if(!await io.historiesPreserved(plan.snapshot))throw Error('Previously closed target history requires inspection');
  return {rolledBack:true,idempotent:true,outcomeVerifiedByAbsence:true,receiptPath:path,sourceCloseRequested:false,workerLaunchRequested:false};
 }
 if(previous&&previous.phase!=='refused-before-close')throw Error('Prior rollback is applied or uncertain; inspect, never repeat close');
 const lock=path+'.lock',fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);let uncertain=false;
 try{
  writeFileSync(fd,plan.transactionId+'\n');fsyncSync(fd);const ledger=readLedger(path),last=ledger.attempts.at(-1);if(last&&last.phase!=='refused-before-close')throw Error('Concurrent rollback claim');if(ledger.attempts.length>=32)throw Error('Rollback audit attempt bound reached');
  if(stable(await io.inspect())!==stable(plan.snapshot))throw Error('Recovery plan changed before claim');
  const attempt:Attempt={plan,approvalReference,phase:'claimed',at:new Date().toISOString()};ledger.attempts.push(attempt);writeLedger(path,ledger);
  try{if(stable(await io.inspect())!==stable(plan.snapshot))throw Error('Late recovery evidence changed');}catch(e){attempt.phase='refused-before-close';writeLedger(path,ledger);throw e;}
  attempt.phase='close-requested';writeLedger(path,ledger);uncertain=true;
  try{await io.closeTarget();}catch{if(!await io.targetAbsent())throw Error('Target close outcome uncertain; inspect before retry');}
  if(!await io.targetAbsent())throw Error('Target close not acknowledged by physical absence; inspect before retry');
  if(!await io.historiesPreserved(plan.snapshot))throw Error('Target closed but native-history preservation needs inspection');
  attempt.phase='applied';writeLedger(path,ledger);uncertain=false;
  return {rolledBack:true,idempotent:false,receiptPath:path,sourceCloseRequested:false,workerLaunchRequested:false,normalReconciliationMayProceed:true};
 }finally{closeSync(fd);if(!uncertain)unlinkSync(lock);}
}
