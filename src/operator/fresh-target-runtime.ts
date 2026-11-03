import {constants,openSync,closeSync,readSync,fstatSync,readFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,relative,isAbsolute,basename} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DrovrClient} from '@brooswit/drovr';
import {agentIdOfWorkspacePath} from '../agents/workspace.js';
import {assertClaudeTargetReady} from '../control-panel/worker-target-readiness.js';
import {nativeSessionHash} from '../control-panel/worker-rollout.js';
import {inspectFreezeRoot} from './maintenance-paths.js';
import {processProof,statKey} from './bootstrap-history.js';
import {assertRetirementServicesStopped} from './retirement-writer.js';
import {hash} from './validation-retirement.js';
import {stable} from './staged-bootstrap.js';
import type {AdoptionRequest,AdoptionIO,SuggestionConfirmation} from './fresh-target-adoption.js';
function canonical(path:string){if(!isAbsolute(path)||realpathSync(path)!==path)throw Error('Explicit canonical nonsymlink path required');return path;}
function noHold(path:string){try{lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Independent freeze/stop/quota hold exists');}
/** Hash only; never copy saved conversations into a prompt, audit or output. */
function nativeFile(path:string,expected:{provider:'codex'|'claude';cwd:string;sessionHash:string;max:number}){
 canonical(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=fstatSync(fd);if(!before.isFile()||before.uid!==process.getuid?.()||before.nlink!==1||(before.mode&0o022)||before.size<=0||before.size>expected.max)throw Error('Unsafe bounded native history');
  const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let total=0,header='',identity=false;
  for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;digest.update(buffer.subarray(0,n));total+=n;
   if(!identity){header+=buffer.subarray(0,n).toString('utf8');for(const line of header.split('\n').slice(0,-1)){const j=JSON.parse(line),id=expected.provider==='codex'?j.type==='session_meta'?j.payload?.id:undefined:j.sessionId,cwd=expected.provider==='codex'?j.payload?.cwd:j.cwd;if(id&&cwd===expected.cwd&&hash(JSON.stringify([expected.provider,'id',id]))===expected.sessionHash){identity=true;break;}}if(!identity)throw Error('Native identity not proven in bounded header');}
  }
  if(statKey(before)!==statKey(fstatSync(fd)))throw Error('Native history changed while hashing');return {bytes:total,sha256:digest.digest('hex')};
 }finally{closeSync(fd);}
}
/** Only the adoption operator may attest a known suggestion. This normalizes a
 * read-only copy, never the terminal, and never changes the shared draft guard. */
export function confirmedSuggestionView(raw:unknown,detection:unknown,c:SuggestionConfirmation,expected:SuggestionConfirmation['target'],physical:{pid:number;generation:string},now=Date.now()){
 const result=raw as {read?:{pane_id?:string;workspace_id?:string;source?:string;format?:string;truncated?:boolean;text?:string;revision?:number;tab_id?:string}},view=result?.read;
 const detected=(detection as typeof result)?.read;
 if(c?.kind!=='user-confirmed-suggestion'||typeof c.reference!=='string'||!c.reference.trim()||c.reference.length>256||!Number.isFinite(c.confirmedAt)||c.confirmedAt>now||now-c.confirmedAt>3600000||stable(c.target)!==stable(expected)||c.process?.pid!==physical.pid||c.process.generation!==physical.generation||typeof c.suggestion!=='string'||! /^[^\x00-\x1f\x7f]{1,200}$/.test(c.suggestion)||! /^[a-f0-9]{64}$/.test(c.ansiLineSHA256))throw Error('Exact fresh user-confirmed suggestion/target/process binding required');
 if(!view||view.pane_id!==expected.paneId||view.workspace_id!==expected.workspaceId||view.source!=='visible'||view.format!=='ansi'||view.truncated!==false||typeof view.text!=='string'||view.text.length>32768)throw Error('Exact complete ANSI suggestion view required');
 const clean=(v:string)=>v.replace(/\x1b\[[0-9;]*m/g,'').replace(/\r/g,'');
 const rendered=(v:string)=>clean(v).split('\n').filter((line,i,all)=>i<all.length-1||line!=='').join('\n');
 if(!detected||detected.source!=='detection'||detected.pane_id!==view.pane_id||detected.workspace_id!==view.workspace_id||!view.tab_id||detected.tab_id!==view.tab_id||!Number.isSafeInteger(view.revision)||view.revision!<0||detected.revision!==view.revision||detected.truncated!==false||typeof detected.text!=='string'||rendered(detected.text)!==rendered(view.text))throw Error('Matching complete visible/detection frame required');
 const lines=view.text.split('\n'),index=lines.flatMap((v,i)=>/^\s*[❯›>]/.test(clean(v))?[i]:[]).at(-1)??-1,line=lines[index];
 if(index<0||!line||hash(line)!==c.ansiLineSHA256||!/^❯\u00a0\x1b\[0m\x1b\[2m[^\x1b]+\x1b\[0m\r?$/.test(line)||clean(line)!=='❯\u00a0'+c.suggestion)throw Error('Confirmed suggestion changed or input is not the attested dim placeholder');
 const normalized=lines.map(clean);if(normalized.some(v=>v.includes('\x1b')))throw Error('Unknown ANSI controls cannot prove readiness');normalized[index]='❯';
 // Known passive context hint in the right footer column; no dialog, mode,
 // authentication or quota text is removed. Other footer checks stay unchanged.
 for(let i=index+1;i<normalized.length;i++)normalized[i]=normalized[i]!.replace(/\s{2,}new task\? \/clear to save [0-9.,]+[km]? tokens\s*$/i,'');
 return {...result,read:{...detected,format:'text',text:normalized.join('\n')}};
}
export function freshTargetRuntime(r:AdoptionRequest,deps:{client?:DrovrClient;home?:string;show?:(unit:string)=>Record<string,string>;processIdentity?:typeof processProof}={}):AdoptionIO{
 const ownerHome=deps.home??homedir(),identify=deps.processIdentity??processProof;
 for(const p of [r.state,r.permit,r.socket,r.runtime,r.workspaces,r.repository,r.sourceHistory,r.nativeRoot,r.targetExecutable])canonical(p);
 if(r.nativeRoot!==join(ownerHome,'.claude/projects',basename(r.nativeRoot))||!r.sourceHistory.startsWith(join(ownerHome,'.codex/sessions')+'/')||basename(r.targetExecutable)!=='claude')throw Error('Exact owner native roots and Claude image required');
 const client=deps.client??new DrovrClient({socketPath:r.socket,timeoutMs:5000});
 const show=deps.show??((unit:string)=>Object.fromEntries(execFileSync('systemctl',['--user','show',unit,'-p','MainPID','-p','ActiveState','-p','SubState','-p','Job','-p','WorkingDirectory','-p','ExecStart'],{encoding:'utf8',timeout:5000}).trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];})));
 return {
  async assertStopped(){assertRetirementServicesStopped(r.runtime,r.unit,show);},
  async capture(permit){
   const expected=permit.continuation!.target,workspace=canonical(expected.cwd),ws=lstatSync(workspace);
   if(!ws.isDirectory()||ws.uid!==process.getuid?.()||agentIdOfWorkspacePath(workspace,r.workspaces)!==permit.workerKey)throw Error('Managed workspace ownership differs');
   const rel=relative(workspace,r.repository);if(!rel||rel.startsWith('..')||isAbsolute(rel)||realpathSync(r.repository)!==r.repository)throw Error('Explicit nested workspace repository required');
   const freeze=inspectFreezeRoot(r.freezeRoot);noHold(join(freeze.path,hash('butchr:'+permit.workerKey)+'.json'));noHold(join(workspace,'.butchr-stop-cause.json'));
   const getAgent=async(pane:string)=>(await client.agent.get(pane)).agent;
   const [{agents},{panes},target,paneRaw]=await Promise.all([client.agent.list(),client.pane.list(),getAgent(expected.paneId),client.pane.get(expected.paneId)]),pane=paneRaw.pane;
   if(new Set(panes.map(p=>p.pane_id)).size!==panes.length||agents.some(a=>!panes.some(p=>p.pane_id===a.pane_id))||panes.some(p=>p.pane_id===permit.source.paneId||p.workspace_id===permit.source.paneId.split(':')[0])||agents.some(a=>a.pane_id===permit.source.paneId)||agents.filter(a=>a.cwd===workspace).length!==1||target.workspace_id!==expected.workspaceId||pane.terminal_id!==expected.terminalId||pane.cwd!==workspace||nativeSessionHash(target.agent_session)!==expected.sessionHash||stable(target.agent_session)!==stable(pane.agent_session)||panes.filter(p=>p.workspace_id===expected.workspaceId).length!==1)throw Error('Source still exists, duplicate target or ambiguous pane/native ownership');
   const response=await client.pane.processInfo({pane_id:expected.paneId}) as unknown as {process_info?:{foreground_processes?:unknown}};
   if(!Array.isArray(response.process_info?.foreground_processes))throw Error('Foreground process proof unavailable');
   const rows=response.process_info.foreground_processes as {pid:number;name:string;argv:string[]}[];
   if(rows.some(v=>!Number.isSafeInteger(v.pid)||!Array.isArray(v.argv)||v.argv.some(a=>typeof a!=='string')))throw Error('Malformed process identity/argv');
   if(rows.length!==1||rows[0]!.name!=='claude')throw Error('One exact foreground Claude process required');
   const argv=rows[0]!.argv??[],flag=(name:string)=>{const positions=argv.flatMap((v,i)=>v===name?[i]:[]);if(positions.length!==1||!argv[positions[0]!+1])throw Error('Explicit unique launch preference required');return argv[positions[0]!+1]!;};
   const preferences={model:flag('--model'),effort:flag('--effort')},physical=identify(rows[0]!.pid,workspace,r.targetExecutable);
   const readPrompt=async(paneId:string)=>{if(!r.suggestionConfirmation)return client.pane.read({pane_id:paneId,source:'detection',strip_ansi:true});const before=(await client.pane.get(paneId)).pane;const detection=await client.pane.read({pane_id:paneId,source:'detection',strip_ansi:true});const raw=await client.pane.read({pane_id:paneId,source:'visible',format:'ansi',strip_ansi:false});const after=(await client.pane.get(paneId)).pane;const binding=(p:typeof pane)=>({pane:p.pane_id,workspace:p.workspace_id,terminal:p.terminal_id,cwd:p.cwd,native:p.agent_session,revision:p.revision});if(stable(binding(before))!==stable(binding(after))||before.terminal_id!==expected.terminalId||nativeSessionHash(before.agent_session)!==expected.sessionHash||(raw as any).read?.revision!==before.revision||stable(physical)!==stable(identify(rows[0]!.pid,workspace,r.targetExecutable)))throw Error('Suggestion pane/native/process generation changed');return confirmedSuggestionView(raw,detection,r.suggestionConfirmation,expected,physical);};
   await assertClaudeTargetReady(expected,{getAgent,readPrompt});
   const source=nativeFile(r.sourceHistory,{provider:'codex',cwd:workspace,sessionHash:permit.source.sessionHash,max:64*1024*1024});
   if(source.bytes!==permit.continuation!.snapshot.bytes||source.sha256!==permit.continuation!.snapshot.sha256)throw Error('Preserved original source snapshot differs');
   const ref=target.agent_session;if(!ref||ref.kind!=='id'||typeof ref.value!=='string'||! /^[a-f0-9-]{36}$/.test(ref.value))throw Error('Exact registered target native id required');
   const history=nativeFile(join(r.nativeRoot,ref.value+'.jsonl'),{provider:'claude',cwd:workspace,sessionHash:expected.sessionHash,max:64*1024*1024});
   const git=['--no-optional-locks','-c','core.fsmonitor=false','-C',r.repository],run=(args:string[])=>execFileSync('git',[...git,...args],{timeout:10000,maxBuffer:16*1024*1024});
   if(run(['rev-parse','--show-toplevel']).toString().trim()!==r.repository)throw Error('Repository ownership differs');
   const repo={head:run(['rev-parse','HEAD']).toString().trim(),statusSHA256:hash(run(['status','--porcelain=v1','-z']).toString()),diffSHA256:hash(run(['diff','--no-ext-diff','--no-textconv','--binary','HEAD']).toString())};
   const inventory={agents:agents.map(a=>({paneId:a.pane_id,workspaceId:a.workspace_id,cwd:a.cwd,provider:a.agent,native:a.agent_session??null})).sort((a,b)=>a.paneId.localeCompare(b.paneId)),panes:panes.map(p=>({paneId:p.pane_id,workspaceId:p.workspace_id,terminalId:p.terminal_id})).sort((a,b)=>a.paneId.localeCompare(b.paneId))};
   await assertClaudeTargetReady(expected,{getAgent,readPrompt});
   if(stable(physical)!==stable(identify(rows[0]!.pid,workspace,r.targetExecutable)))throw Error('Target process generation changed');
   return {target:structuredClone(expected),sourceAbsent:true,workspaceKey:permit.workerKey,preferences,process:physical,workspace:{path:workspace,device:ws.dev,inode:ws.ino,repository:r.repository,...repo},histories:{source,target:history},inventory,independentHolds:{freezeRoot:freeze,freezeAbsent:true,intentionalStopAbsent:true,...(r.suggestionConfirmation?{confirmedSuggestion:r.suggestionConfirmation}:{})},holdsClear:true};
  }
 };
}
