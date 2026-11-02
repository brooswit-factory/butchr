const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function time(v:unknown){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||Date.parse(v)>Date.now()+300000||Date.parse(v)<946684800000)throw new Error('Invalid event timestamp');return v;}
/** Bounded identity provenance, never a query expression or filesystem path. */
export interface AdmittedRuleIdentity {id:string;name:string;source:'local'|'remote';serverId?:string;authorizationId?:string}
export interface AgentProvenance {provider:'jira-work'|'jira-idea'|'jira-project'|'github-issue'|'github-pr'|'zendesk-ticket'|'confluence-page'|'jira-component'|'trello-card'|'filesystem';kind:'resource'|'query';ruleId?:string;resourceId?:string;admittedRule?:AdmittedRuleIdentity}
export function validAgentProvenance(p:any):p is AgentProvenance {
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['provider','kind','ruleId','resourceId','admittedRule'].includes(k))||!['resource','query'].includes(p.kind))return false;
 if(p.ruleId!==undefined&&(typeof p.ruleId!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.ruleId)||p.ruleId.length>64))return false;
 const a=p.admittedRule;if(a!==undefined){if(!exact(a,a?.source==='remote'?['id','name','source','serverId','authorizationId']:['id','name','source'])||!['local','remote'].includes(a.source)||a.id!==p.ruleId||typeof a.name!=='string'||!a.name.length||a.name.length>100||/[\u0000-\u001f\u007f]/.test(a.name)||a.source==='remote'&&(!uuid.test(a.serverId)||!uuid.test(a.authorizationId)))return false;}
 const patterns:Record<string,RegExp>={'jira-work':/^[A-Z][A-Z0-9_]*-[0-9]+$/,'jira-idea':/^[A-Z][A-Z0-9_]*-[0-9]+$/,'jira-project':/^[A-Z][A-Z0-9_]*$/,'github-issue':/^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/,'github-pr':/^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/,'zendesk-ticket':/^[a-z0-9-]+#[1-9][0-9]*$/,'confluence-page':/^[0-9]+$/,'jira-component':/^[A-Z][A-Z0-9_]*:[0-9]+$/,'trello-card':/^[a-f0-9]{24}#[a-f0-9]{24}$/};
 if(typeof p.provider!=='string'||p.provider!=='filesystem'&&!Object.hasOwn(patterns,p.provider))return false;
 if(p.kind==='query'||p.provider==='filesystem')return p.resourceId===undefined&&p.ruleId!==undefined;
 return typeof p.resourceId==='string'&&p.resourceId.length<=512&&patterns[p.provider]!.test(p.resourceId);
}
export interface OperationalSnapshot {mode:'management-only'|'daemon'|'unknown';controllersEnabled:boolean|null;remoteConfigsEnabled:boolean;transportConnected:boolean;agentsChecked:boolean;agentsTruncated:boolean;agents:{id:string;status:'idle'|'working'|'blocked'|'done'|'unknown';confirmedAt:string;provenance?:AgentProvenance}[]}
export interface InstanceEvent {id:string;sequence:number;occurredAt:string;type:'session.snapshot';data:OperationalSnapshot}
export function validateEvent(value:any):InstanceEvent{
 if(!exact(value,['id','sequence','occurredAt','type','data'])||!uuid.test(value.id)||!Number.isSafeInteger(value.sequence)||value.sequence<1||value.type!=='session.snapshot')throw new Error('Invalid event envelope');time(value.occurredAt);
 const d=value.data;if(!exact(d,['mode','controllersEnabled','remoteConfigsEnabled','transportConnected','agentsChecked','agentsTruncated','agents'])||!['management-only','daemon','unknown'].includes(d.mode)||!(d.controllersEnabled===null||typeof d.controllersEnabled==='boolean')||['remoteConfigsEnabled','transportConnected','agentsChecked','agentsTruncated'].some(k=>typeof d[k]!=='boolean')||!Array.isArray(d.agents)||d.agents.length>100)throw new Error('Invalid operational snapshot');
 const seen=new Set<string>();for(const a of d.agents){if(!exact(a,Object.hasOwn(a??{},'provenance')?['id','status','confirmedAt','provenance']:['id','status','confirmedAt'])||(Object.hasOwn(a??{},'provenance')&&!validAgentProvenance(a.provenance))||typeof a.id!=='string'||!/^[0-9a-f]{64}$/.test(a.id)||seen.has(a.id)||!['idle','working','blocked','done','unknown'].includes(a.status))throw new Error('Invalid agent metadata');time(a.confirmedAt);seen.add(a.id);}
 if(Buffer.byteLength(JSON.stringify(value))>32768)throw new Error('Event too large');return value;
}
