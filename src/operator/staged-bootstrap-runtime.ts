import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,basename,isAbsolute,resolve} from 'node:path';
import {homedir} from 'node:os';
import {DrovrClient,readNativeTranscript,continuationChunkCount} from '@brooswit/drovr';
import {agentIdOfWorkspacePath} from '../agents/workspace.js';
import {decodeAnyAgentKey} from '../rules/agent-key.js';
import {inspectFreezeRoot} from './maintenance-paths.js';
import {privateText} from './validation-retirement.js';
import {inspectBootstrap,processProof,historyPrefixPreserved,sha} from './bootstrap-history.js';
import {stable,type BootstrapRequest,type BootstrapRollbackIO,type RollbackWorker} from './staged-bootstrap.js';
/** Visible input, not a detector excerpt: require an empty final prompt directly
 * above its input border, at the bottom of an unfocused idle pane. */
export function emptyBootstrapPrompt(pane:any,screen:any){
 if(pane.focused!==false||pane.scroll?.offset_from_bottom!==0||screen.source!=='visible'||screen.truncated!==false||screen.pane_id!==pane.pane_id||typeof screen.text!=='string')throw Error('Complete unfocused bottom-of-screen input proof required');
 const lines=screen.text.split('\n'),indices=lines.flatMap((l:string,i:number)=>/^\s*[❯›>]\s*/.test(l)?[i]:[]),last=indices.at(-1);
 if(last===undefined||!/^\s*[❯›>]\s*$/.test(lines[last]!)||!/^\s*[─━═]{3,}\s*$/.test(lines[last+1]??''))throw Error('Empty single-line bootstrap input required; preserve any draft');
 return {sha256:sha(screen.text),empty:true as const};
}
/** Saved rules retain their transport staging marker. Execution authority is
 * established by the connected runtime plus its live active rule readback. */
export function assertBootstrapRule(saved:any,live:any){
 if(!saved||!live||live.executionState!=='active'||live.locallyDisabled===true||stable(saved.definition)!==stable(live.definition)||saved.sourceRuleId!==live.sourceRuleId||saved.serverId!==live.serverId||saved.authorizationId!==live.authorizationId)throw Error('Saved and active authoritative rule differ');
}
function canonical(path:string){if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)throw Error('Explicit existing canonical path required');return path;}
function mustBeAbsent(path:string){try{lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Independent hold/control exists; recovery cannot clear it');}
export function stagedBootstrapRuntime(request:BootstrapRequest):BootstrapRollbackIO{
 const r=structuredClone(request),url=new URL(r.daemonOrigin);
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.origin!==r.daemonOrigin||url.username||url.password)throw Error('Explicit loopback daemon origin required');
 for(const path of [r.stateDirectory,r.socketPath,r.nativeRoot,r.targetExecutable])canonical(path);
 if(r.nativeRoot!==join(homedir(),'.claude','projects',basename(r.nativeRoot)))throw Error('Only the current owner exact Claude project root is permitted');
 const client=new DrovrClient({socketPath:r.socketPath,timeoutMs:5000}),key=decodeAnyAgentKey(r.workerKey);if(!key)throw Error('Managed worker key required');
 async function get(path:string){const response=await fetch(r.daemonOrigin+path,{headers:{Origin:r.daemonOrigin},redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Daemon readback unavailable');return response.json() as Promise<any>;}
 async function sourceText(source:RollbackWorker){if(source.native?.agent!=='codex'||source.native.kind!=='id')throw Error('Existing exact source reference required');return readNativeTranscript({provider:'codex',session:{kind:'id',value:source.native.value},cwd:source.cwd,home:homedir(),maxBytes:4*1024*1024});}
 async function census(){const [{agents},{panes}]=await Promise.all([client.agent.list(),client.pane.list()]);if(new Set(panes.map(p=>p.pane_id)).size!==panes.length||agents.some(a=>!panes.some(p=>p.pane_id===a.pane_id)))throw Error('Incomplete physical inventory');return {agents,panes};}
 async function worker(paneId:string,provider:'codex'|'claude'):Promise<{worker:RollbackWorker;pane:any}>{
  const a=(await client.agent.get(paneId)).agent,p=(await client.pane.get(paneId)).pane;
  if(a.pane_id!==paneId||p.pane_id!==paneId||a.agent!==provider||a.workspace_id!==p.workspace_id||a.terminal_id!==p.terminal_id||a.cwd!==p.cwd||!a.cwd||!a.name||!['idle','done'].includes(a.agent_status??'')||a.interactive_ready!==true||stable(a.agent_session??null)!==stable(p.agent_session??null))throw Error('Exact idle source/target native ownership required');
  const info:any=await client.pane.processInfo({pane_id:paneId}),rows=info.process_info.foreground_processes;
  if(rows.length!==1||rows[0]!.name!==provider)throw Error('One matching foreground process required');
  const pid=rows[0]!.pid,executable=provider==='claude'?r.targetExecutable:realpathSync('/proc/'+pid+'/exe');if(provider==='codex'&&basename(executable)!=='codex')throw Error('Source image is not Codex');
  return {worker:{paneId,workspaceId:a.workspace_id,terminalId:a.terminal_id!,cwd:a.cwd,provider,name:a.name,native:a.agent_session as RollbackWorker['native']??null,process:processProof(pid,a.cwd,executable)},pane:p};
 }
 return {
  async inspect(){
   const [cp,paths,overrides,remoteRules]=await Promise.all([get('/api/control-panel'),get('/api/operator-paths'),get('/api/remote-config'),get('/api/remote-rules')]);
   const runtime=cp.ruleRuntime;if(cp.status!=='Connected'||runtime?.authority!=='remote'||runtime.connected!==true||!Number.isSafeInteger(runtime.generation)||runtime.generation<=0||typeof runtime.revision!=='string'||overrides.enabled!==true||!Array.isArray(overrides.disabledRules)||overrides.disabledRules.includes(key.ruleId))throw Error('Current connected enabled remote authority required');
   const reconciliation=runtime.workerReconciliation?.find((v:any)=>v.id===r.workerKey);if(runtime.phase!=='inventory-uncertain'||runtime.inventoryComplete!==false||reconciliation?.status!=='blocked'||reconciliation.reason!=='A complete observed worker specification is required')throw Error('Only a durably blocked ambiguous-inventory handoff can be rolled back; no concurrent lifecycle operation');
   const authorityText=privateText(join(r.stateDirectory,'remote-rule-authority.json')),manifest=JSON.parse(authorityText),retained=manifest.retained?.find((v:any)=>v[0]===r.workerKey)?.[1];
   const desired=manifest.remote?.filter((v:any)=>v.sourceRuleId===key.ruleId&&v.definition?.resourceProvider===key.resourceProvider);
   if(manifest.active!==true||manifest.revision!==runtime.revision||desired?.length!==1||desired[0].definition.enabled!==true||desired[0].definition.agentPreferences?.length!==1||desired[0].definition.agentPreferences[0].harness!=='claude'||retained?.managed!==true||retained.known!==true||retained.rule?.id!==key.ruleId||retained.lastHandoff?.partial||retained.reconciliation?.partial)throw Error('Managed source and enabled Claude rule without partial handoff required');
   const observed=(Array.isArray(remoteRules)?remoteRules:remoteRules.rules)?.filter((v:any)=>v.sourceRuleId===key.ruleId&&v.definition?.resourceProvider===key.resourceProvider);
   if(observed?.length!==1||observed[0].definition.enabled!==true||observed[0].definition.agentPreferences?.length!==1||observed[0].definition.agentPreferences[0].harness!=='claude'||observed[0].locallyDisabled===true)throw Error('Saved and current authoritative rule differ');
   assertBootstrapRule(desired[0],observed[0]);
   mustBeAbsent(join(r.stateDirectory,'worker-canary-mode.json'));mustBeAbsent(join(r.stateDirectory,'worker-canary-control.lock'));
   const {worker:source}=await worker(r.sourcePane,'codex'),{worker:target,pane}=await worker(r.targetPane,'claude');
   if(agentIdOfWorkspacePath(source.cwd,canonical(paths.workspaces))!==r.workerKey)throw Error('Source is outside the daemon managed workspace');
   const freeze=inspectFreezeRoot(paths.freezeRoot);mustBeAbsent(join(freeze.path,sha('butchr:'+r.workerKey)+'.json'));mustBeAbsent(join(source.cwd,'.butchr-stop-cause.json'));
   const inventory=await census(),siblings=inventory.agents.filter(a=>a.cwd===source.cwd);if(siblings.length!==2||!siblings.some(a=>a.pane_id===source.paneId)||!siblings.some(a=>a.pane_id===target.paneId)||inventory.panes.filter(p=>p.workspace_id===target.workspaceId).length!==1)throw Error('Ambiguous source or target workspace ownership');
   const screen=(await client.pane.read({pane_id:target.paneId,source:'visible',strip_ansi:true})).read,prompt=emptyBootstrapPrompt(pane,screen),targetHistory=inspectBootstrap(target.process.pid,target.cwd,r.targetExecutable,r.nativeRoot),text=await sourceText(source);
   return {bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),source,target,targetHistory,sourceHistory:{sha256:sha(text),bytes:Buffer.byteLength(text),chars:text.length,normalImportChunks:continuationChunkCount(text)},prompt,authority:{pid:paths.pid,generation:runtime.generation,revision:runtime.revision,manifestSHA256:sha(authorityText),overrides,freeze},inventory:{agents:inventory.agents.map(a=>({paneId:a.pane_id,cwd:a.cwd,provider:a.agent,name:a.name,native:a.agent_session??null})).sort((a,b)=>a.paneId.localeCompare(b.paneId)),panes:inventory.panes.map(p=>({paneId:p.pane_id,workspaceId:p.workspace_id,terminalId:p.terminal_id})).sort((a,b)=>a.paneId.localeCompare(b.paneId))}};
  },
  async targetAbsent(){const c=await census();return !c.agents.some(a=>a.pane_id===r.targetPane)&&!c.panes.some(p=>p.pane_id===r.targetPane);},
  async historiesPreserved(snapshot){const text=await sourceText(snapshot.source),prefix=Buffer.from(text).subarray(0,snapshot.sourceHistory.bytes);return prefix.length===snapshot.sourceHistory.bytes&&sha(prefix)===snapshot.sourceHistory.sha256&&historyPrefixPreserved(snapshot.targetHistory);},
  async closeTarget(){return client.pane.close(r.targetPane);}
 };
}
