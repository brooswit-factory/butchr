import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync,readFileSync,readlinkSync,readdirSync,statSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,basename} from 'node:path';
import {hash} from './validation-retirement.js';
export interface NativeAgent{pane_id:string;workspace_id?:string;cwd?:string|null;agent?:string|null;agent_status?:string|null;interactive_ready?:boolean|null;agent_session?:{agent:string;kind:string;value:unknown}|null;}
export interface NativeClient{agent:{get:(pane:string)=>Promise<{agent:NativeAgent}>;list:()=>Promise<{agents:NativeAgent[]}>};pane:{get:(pane:string)=>Promise<unknown>;processInfo:(params:{pane_id:string})=>Promise<unknown>;reportAgentSession:(params:{pane_id:string;agent:string;agent_session_id:string;source:string;session_start_source?:string;seq?:number})=>Promise<unknown>};integration?:{list:()=>Promise<unknown>};}
export interface NativeEvidence{pid:number;generation:string;cwd:string;executableIdentity:string;path:string;fileIdentity:string;sessionId:string;headerSHA256:string;bytes:number;}
export interface NativeEvidenceIO{inspect(agent:NativeAgent,allowedRoots:readonly string[]):Promise<NativeEvidence[]>;}
export interface NativeRecoveryPlan{version:1;kind:'restore-native-reference-only';paneId:string;provider:'codex';workspaceId:string;cwd:string;allowedRoots:string[];evidence:NativeEvidence;confirmation:string;}
function agentIdentity(a:NativeAgent){if(!a.pane_id||!a.workspace_id||!a.cwd||a.agent!=='codex'||!['idle','done'].includes(a.agent_status??'')||a.interactive_ready!==true)throw Error('Exact idle Codex identity/readiness required');return {paneId:a.pane_id,workspaceId:a.workspace_id,cwd:a.cwd};}
export async function planNativeRecovery(client:NativeClient,paneId:string,allowedRoots:readonly string[],io:NativeEvidenceIO):Promise<NativeRecoveryPlan>{
 if(!allowedRoots.length)throw Error('Explicit permitted native roots required; no history search or fallback is allowed');
 const a=(await client.agent.get(paneId)).agent,id=agentIdentity(a);if(id.paneId!==paneId||a.agent_session)throw Error('Reference already present or pane differs; never overwrite');
 const paneRaw=await client.pane.get(paneId) as any,pane=paneRaw.pane??paneRaw;if(pane.pane_id!==paneId||pane.workspace_id!==id.workspaceId||pane.cwd!==id.cwd||pane.agent_session)throw Error('Existing or mismatched pane native ownership; never overwrite');
 const candidates=await io.inspect(a,allowedRoots);if(candidates.length!==1)throw Error('Exactly one process-bound native identity required');const evidence=candidates[0]!;
 if(evidence.cwd!==id.cwd||! /^[A-Za-z0-9_-]{1,128}$/.test(evidence.sessionId)||!evidence.path||!evidence.generation||evidence.bytes<=0||evidence.bytes>64*1024*1024)throw Error('Invalid bounded native identity evidence');
 const after=(await client.agent.get(paneId)).agent;if(JSON.stringify(agentIdentity(after))!==JSON.stringify(id)||after.agent_session||JSON.stringify(await io.inspect(after,allowedRoots))!==JSON.stringify(candidates))throw Error('Native process/session changed during inspection');
 const body={version:1 as const,kind:'restore-native-reference-only' as const,paneId,provider:'codex' as const,workspaceId:id.workspaceId,cwd:id.cwd,allowedRoots:[...allowedRoots],evidence};return {...body,confirmation:hash(JSON.stringify(body))};
}
export async function applyNativeRecovery(client:NativeClient,plan:NativeRecoveryPlan,confirmation:string,io:NativeEvidenceIO){
 if(confirmation!==plan.confirmation)throw Error('Exact inspected plan confirmation required');const current=await planNativeRecovery(client,plan.paneId,plan.allowedRoots,io);if(JSON.stringify(current)!==JSON.stringify(plan))throw Error('Native recovery plan changed');
 // Herdr 0.8.2 accepts session refs only from the matching official provider source.
 // Omit replacement causes and sequence overrides: Herdr must refuse a competing
 // existing owner/reference rather than overwrite it. Readback is mandatory.
 await client.pane.reportAgentSession({pane_id:plan.paneId,agent:'codex',agent_session_id:plan.evidence.sessionId,source:'herdr:codex'});
 const a=(await client.agent.get(plan.paneId)).agent,ref=a.agent_session,paneRaw=await client.pane.get(plan.paneId) as any,pane=paneRaw.pane??paneRaw;
 if(JSON.stringify(agentIdentity(a))!==JSON.stringify({paneId:plan.paneId,workspaceId:plan.workspaceId,cwd:plan.cwd})||pane.pane_id!==plan.paneId||pane.workspace_id!==plan.workspaceId||pane.cwd!==plan.cwd||pane.agent_session?.agent!=='codex'||pane.agent_session?.kind!=='id'||pane.agent_session?.value!==plan.evidence.sessionId||!ref||ref.agent!=='codex'||ref.kind!=='id'||ref.value!==plan.evidence.sessionId||JSON.stringify(await io.inspect(a,plan.allowedRoots))!==JSON.stringify([plan.evidence]))throw Error('Session report not verified; inspect outcome before retrying. No source stop or target launch requested.');
 return {registered:true,provider:'codex',paneId:plan.paneId,confirmation:plan.confirmation,workerLaunchRequested:false};
}
function processGeneration(text:string){const fields=text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/);if(!/^\d+$/.test(fields[19]??''))throw Error('Process generation unavailable');return fields[19]!;}
function fileKey(s:NonNullable<ReturnType<typeof statSync>>){return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}
/** Linux, same-owner, exact foreground PID only. Permission failures propagate; no alternate roots or newest-session guessing. */
export function linuxNativeEvidence(client:Pick<NativeClient,'pane'>,procRoot='/proc'):NativeEvidenceIO{return {async inspect(agent,allowedRoots){
 if(process.platform!=='linux')throw Error('Verified native recovery currently requires Linux; no unsafe fallback');
 const roots=allowedRoots.map(root=>{if(!isAbsolute(root)||realpathSync(root)!==resolve(root))throw Error('Canonical permitted native root required');const s=lstatSync(root);if(!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o022))throw Error('Owned non-writable permitted native root required');return {root,key:fileKey(s)};});
 const response=await client.pane.processInfo({pane_id:agent.pane_id}) as any;const info=response?.process_info,rows=info?.foreground_processes;
 if(!Array.isArray(rows)||rows.length!==1||rows[0].name!=='codex'||!Number.isSafeInteger(rows[0].pid)||rows[0].pid<=1)throw Error('Single exact foreground Codex process required');
 const pid=rows[0].pid,proc=join(procRoot,String(pid)),cwd=agent.cwd!;
 const processProof=()=>{if(basename(realpathSync(proc+'/exe')).replace(/\.exe$/i,'')!=='codex')throw Error('Foreground executable is not Codex');if(lstatSync(proc).uid!==process.getuid?.()||realpathSync(proc+'/cwd')!==realpathSync(cwd))throw Error('Process owner/cwd differs');return {generation:processGeneration(readFileSync(proc+'/stat','utf8')),executableIdentity:fileKey(statSync(proc+'/exe'))};};const before=processProof(),found=new Map<string,NativeEvidence>();
 for(const name of readdirSync(proc+'/fd')){
  const link=readlinkSync(proc+'/fd/'+name);if(!link.endsWith('.jsonl'))continue;
  const root=roots.find(r=>{const rel=relative(r.root,link);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);});if(!root)continue;
  if(realpathSync(link)!==resolve(link))throw Error('Native path must not traverse symlinks');const fd=openSync(link,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o022)||stat.size<=0||stat.size>64*1024*1024||fileKey(stat)!==fileKey(statSync(link)))throw Error('Unsafe native file identity');const bytes:number[]=[],one=Buffer.alloc(1);let complete=false;while(bytes.length<1024*1024){if(readSync(fd,one,0,1,null)!==1)break;if(one[0]===10){complete=true;break;}bytes.push(one[0]!);}if(!complete)throw Error('Bounded complete native identity header required');const text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes)),header=JSON.parse(text),payload=header?.payload;
   if(header?.type!=='session_meta'||payload?.cwd!==cwd||typeof payload.id!=='string'||payload.session_id!==undefined&&payload.session_id!==payload.id)throw Error('Native header does not match exact process workspace');
   if(fileKey(stat)!==fileKey(fstatSync(fd))||fileKey(stat)!==fileKey(statSync(link))||realpathSync(link)!==resolve(link))throw Error('Native file changed during identity read');
   found.set(link,{pid,...before,cwd,path:link,fileIdentity:fileKey(stat),sessionId:payload.id,headerSHA256:hash(text),bytes:stat.size});
  }finally{closeSync(fd);}
 }
 if(JSON.stringify(before)!==JSON.stringify(processProof())||roots.some(r=>fileKey(lstatSync(r.root))!==r.key||realpathSync(r.root)!==resolve(r.root)))throw Error('Native process/root changed');return [...found.values()].sort((a,b)=>a.path.localeCompare(b.path));
 }};}
export function parseIntegrationStatus(text:string){return {integrations:['codex','claude'].map(name=>{const line=text.split('\n').find(l=>l.startsWith(name+': '));const status=!line?'unknown':line.includes(': not installed')?'missing':line.includes(': outdated')?'outdated':/^\w+: (?:current|installed)\b/.test(line)?'installed':'unknown';return {name,status,hookApproval:'not checked'};})};}
export async function nativeReadiness(client:NativeClient){
 const {agents}=await client.agent.list();let integrations:unknown;
 try{const raw=client.integration?await client.integration.list() as any:null;const entries=raw?.integrations;if(!Array.isArray(entries))throw Error('Unsupported integration status');integrations={available:true,providers:['codex','claude'].map(provider=>{const i=entries.find((x:any)=>(x.name??x.agent)===provider);const status=i?.installed===false||['missing','not-installed'].includes(i?.status)?'missing':i?.status==='outdated'?'outdated':i?.installed===true||['installed','current'].includes(i?.status)?'installed':'unknown';return {provider,status,hookApproval:'not checked'};})};}
 catch{integrations={available:false,reason:'Integration status unavailable; use readiness --herdr-bin with the existing trusted Herdr binary. Never assume installed.'};}
 return {integrations,agents:agents.filter(a=>['codex','claude'].includes(a.agent??'')).map(a=>({paneId:a.pane_id,provider:a.agent,nativeSessionRegistered:!!a.agent_session&&a.agent_session.agent===a.agent&&['id','path'].includes(a.agent_session.kind),action:!a.agent_session?'Inspect official integration status and exact native-reference recovery; preserve worker':'Registered reference available; readability and other lifecycle guards still apply'})),installsPerformed:false,workerLaunchRequested:false};
}
