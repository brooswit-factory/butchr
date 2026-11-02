import {decodeAnyAgentKey} from "../rules/agent-key.js";
import {isIssueKey,isProjectId} from "../resources/id.js";
import {validateServerUrl} from "./server-origin.js";
import {syncDirectory} from "./writer.js";
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import type {DashboardResponse} from '../agents/dashboard.js';
import {validateEvent,validAgentProvenance,type AgentProvenance,type AdmittedRuleIdentity,type InstanceEvent,type OperationalSnapshot} from './telemetry-wire.js';
export type {OperationalSnapshot};
export interface TelemetrySource {origin:string;serverId:string;authorizationId:string}
/** Never send retained source-A identifiers through a newly configured source-B connection. */
export function scopeOperationalSnapshot(data:OperationalSnapshot,source:TelemetrySource):OperationalSnapshot {
 return {...data,agents:data.agents.map(agent=>{const origin=agent.provenance?.admittedRule;if(origin?.source==='remote'&&(origin.serverId!==source.serverId||origin.authorizationId!==source.authorizationId)){const {provenance:_,...status}=agent;return status;}return structuredClone(agent);})};
}
interface QueuedEvent extends TelemetrySource {deploymentId:string;sessionId:string;event:InstanceEvent}
/** Privacy projection of the existing dashboard feed. No resource keys, panes, task text or paths. */
export function projectOperationalSnapshot(dashboard:DashboardResponse,mode:OperationalSnapshot['mode'],controllersEnabled:boolean|null):Omit<OperationalSnapshot,'remoteConfigsEnabled'|'transportConnected'>{
 const agents=dashboard.rows.filter(row=>row.kind==='agent');
 return {mode,controllersEnabled,agentsChecked:dashboard.checked,agentsTruncated:agents.length>100,agents:agents.slice(0,100).map(row=>({id:createHash('sha256').update(row.resourceKey).digest('hex'),status:(['idle','working','blocked','done','unknown'].includes(row.agentStatus)?row.agentStatus:'unknown') as OperationalSnapshot['agents'][number]['status'],confirmedAt:row.confirmedAt}))};
}
export function agentProvenance(key:string):AgentProvenance|undefined {
 const decoded=decodeAnyAgentKey(key);
 const value=decoded?{provider:decoded.resourceProvider,kind:decoded.kind,ruleId:decoded.ruleId,...(decoded.kind==='resource'&&decoded.resourceProvider!=='filesystem'?{resourceId:decoded.resourceId}:{})}:isIssueKey(key)?{provider:'jira-work',kind:'resource',resourceId:key}:isProjectId(key)?{provider:'jira-project',kind:'resource',resourceId:key}:undefined;
 return validAgentProvenance(value)?value:undefined;
}
/** All recognized Butchr-managed identities from the existing Herdr read, independently of legacy dashboard row filtering. */
export function createOperationalAgentFeed(now=Date.now,admittedRule:(key:string)=>AdmittedRuleIdentity|undefined=()=>undefined){
 let checked=false,truncated=false,agents:OperationalSnapshot['agents']=[];
 function decline(){checked=false;}
 function record(rows:readonly {agentKey:string|null|undefined;status?:string|undefined}[]){
  if(rows.length>10000){decline();return false;}
  const confirmedAt=new Date(now()).toISOString(),seen=new Set<string>(),next:OperationalSnapshot['agents']=[];
  for(const row of rows){const key=row.agentKey;if(!key||!decodeAnyAgentKey(key)&&!isIssueKey(key)&&!isProjectId(key))continue;
   const id=createHash('sha256').update(key).digest('hex');if(seen.has(id)){decline();return false;}seen.add(id);
   const provenance=agentProvenance(key),origin=admittedRule(key);if(provenance&&origin){const candidate={...provenance,admittedRule:origin};if(validAgentProvenance(candidate))Object.assign(provenance,{admittedRule:structuredClone(origin)});}
   if(next.length<100)next.push({id,...(provenance?{provenance}:{}),status:(['idle','working','blocked','done','unknown'].includes(row.status??'')?row.status:'unknown') as OperationalSnapshot['agents'][number]['status'],confirmedAt});
  }
  // Keep the complete status census within the wire budget. Optional provenance
  // may be unavailable on the final rows, but identities/statuses never disappear.
  for(let i=next.length-1;i>=0&&Buffer.byteLength(JSON.stringify(next))>30000;i--)delete next[i]!.provenance;
  checked=true;truncated=seen.size>100;agents=next.sort((a,b)=>a.id.localeCompare(b.id));return true;
 }
 return {record,decline,snapshot:(mode:OperationalSnapshot['mode'],controllersEnabled:boolean|null):Omit<OperationalSnapshot,'remoteConfigsEnabled'|'transportConnected'>=>({mode,controllersEnabled,agentsChecked:checked,agentsTruncated:truncated,agents:agents.map(a=>({...a,...(a.provenance?{provenance:structuredClone(a.provenance)}:{})}))})};
}
export function createTelemetryOutbox(directory:string,sync:typeof syncDirectory=syncDirectory){
 const path=join(directory,'event-outbox.json');let records:QueuedEvent[]=[],sequences:Record<string,number>={},retry:ReturnType<typeof setTimeout>|undefined,inFlight=false,stopped=false,attempts=0,lastError:string|null=null;
 const identity=/^[0-9a-f-]{36}$/;
 const cursorKey=(r:TelemetrySource,deploymentId:string,sessionId:string)=>createHash('sha256').update(JSON.stringify([r.origin,r.serverId,r.authorizationId,deploymentId,sessionId])).digest('hex');
 function validateRecord(r:any){if(!r||Object.keys(r).sort().join(',')!=='authorizationId,deploymentId,event,origin,serverId,sessionId'||![r.serverId,r.authorizationId,r.deploymentId,r.sessionId].every(id=>typeof id==='string'&&identity.test(id))||typeof r.origin!=='string'||validateServerUrl(r.origin)!==r.origin)throw Error('Invalid event outbox');validateEvent(r.event);}
 try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>2_000_000)throw Error('Unsafe event outbox');const data=JSON.parse(readFileSync(path,'utf8'));if(data.version!==2||!Array.isArray(data.records)||data.records.length>64||!data.sequences||typeof data.sequences!=='object'||Array.isArray(data.sequences))throw Error('Invalid event outbox');for(const r of data.records)validateRecord(r);for(const [k,v] of Object.entries(data.sequences))if(!/^[0-9a-f]{64}$/.test(k)||!Number.isSafeInteger(v)||Number(v)<0)throw Error('Invalid event sequence');records=data.records;sequences=data.sequences;for(const record of records)if((sequences[cursorKey(record,record.deploymentId,record.sessionId)]??0)<record.event.sequence)throw Error('Invalid event cursor');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 function persist(next:QueuedEvent[],seq:Record<string,number>){const text=JSON.stringify({version:2,records:next,sequences:seq});if(Buffer.byteLength(text)>2_000_000)throw Error('Event outbox full');const temp=join(directory,`.event-outbox-${randomUUID()}.tmp`);try{writeFileSync(temp,text,{flag:'wx',mode:0o600});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);records=next;sequences=seq;sync(directory);}finally{try{unlinkSync(temp);}catch{}}records=next;sequences=seq;}
 function enqueue(source:TelemetrySource,deploymentId:string,sessionId:string,data:OperationalSnapshot){
  data=scopeOperationalSnapshot(data,source);
  if(records.length>=64){lastError='Event outbox full; collection paused until delivery resumes';return false;}
  const key=cursorKey(source,deploymentId,sessionId);const event:InstanceEvent={id:randomUUID(),sequence:(sequences[key]??0)+1,occurredAt:new Date().toISOString(),type:'session.snapshot',data};validateEvent(event);const next={...source,deploymentId,sessionId,event};validateRecord(next);
  // Keep cursors across source switches; otherwise returning to an earlier authorization
  // could reuse sequence1 under the same process session. Never silently evict a cursor.
  const seq={...sequences,[key]:event.sequence};if(Object.keys(seq).length>10000){lastError='Event cursor capacity reached';return false;}
  try{persist([...records,next],seq);}catch(error){lastError='Event storage unavailable or full; collection paused';throw error;}return true;
 }
 async function flush(source:TelemetrySource,send:(events:QueuedEvent[])=>Promise<number>){
  if(stopped||inFlight)return;clearTimeout(retry);inFlight=true;
  try{while(!stopped){const first=records.find(r=>r.origin===source.origin&&r.serverId===source.serverId&&r.authorizationId===source.authorizationId);if(!first)break;
   const batch=records.filter(r=>r.origin===first.origin&&r.serverId===first.serverId&&r.authorizationId===first.authorizationId&&r.sessionId===first.sessionId&&r.deploymentId===first.deploymentId).slice(0,16);
   const ack=await send(batch);if(stopped)return;if(!Number.isSafeInteger(ack)||ack<batch.at(-1)!.event.sequence)throw Error('Invalid event acknowledgement');const ids=new Set(batch.filter(r=>r.event.sequence<=ack).map(r=>r.event.id));persist(records.filter(r=>!ids.has(r.event.id)),sequences);lastError=null;attempts=0;
  }}catch{lastError='Event delivery pending; retrying';const delay=Math.min(30000,1000*2**Math.min(attempts++,5))*(.75+Math.random()*.25);if(!stopped){retry=setTimeout(()=>void flush(source,send),delay);retry.unref();}}finally{inFlight=false;}
 }
 return {enqueue,flush,summary:()=>({queued:records.length,lastError}),stop:()=>{stopped=true;clearTimeout(retry);}};
}
