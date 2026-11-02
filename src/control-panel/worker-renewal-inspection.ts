import {execFileSync} from 'node:child_process';
import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync,readlinkSync,realpathSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {connect} from 'node:net';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {nativeSessionHash,type CanaryPermit,type CanaryRenewalSnapshot} from './worker-rollout.js';
const stable=(x:unknown)=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const renewalEvidenceHash=(x:unknown)=>createHash('sha256').update(stable(x)).digest('hex');
export interface OwnerRenewalReadback{checkedAt:number;origin:string;authorizationId:string;sourceEtag:string;taskHash:string;reviewerHash:string;}
/** Browser adapter consumes visible authenticated owner JSON pages; never cookies, hidden state or fetch. */
export interface OwnerReadbackTab{
 url:()=>Promise<string|undefined>;goto:(url:string)=>Promise<void>;getAXState:(options?:{emit?:boolean})=>Promise<unknown>;
 playwright:{getByRole:(role:string,options:{name:string;exact:boolean})=>{isVisible:()=>Promise<boolean>};getByText:(text:string,options:{exact:boolean})=>{isVisible:()=>Promise<boolean>};locator:(selector:string)=>{innerText:()=>Promise<string>}};
}
export async function readOwnerRenewalViaBrowser(tab:OwnerReadbackTab,origin:string,authorizationId:string,now=()=>Date.now()):Promise<OwnerRenewalReadback>{
 const rules=origin+'/authorizations/'+authorizationId+'/rules';
 if(new URL(origin).origin!==origin||!origin.startsWith('https://')||! /^[a-f0-9-]{36}$/.test(authorizationId)||await tab.url()!==rules||!await tab.playwright.getByRole('button',{name:'Log out',exact:true}).isVisible())throw Error('Authenticated exact owner page required');
 if(!await tab.playwright.getByRole('button',{name:'Review and save',exact:true}).isVisible()||!await tab.playwright.getByText('No unsaved changes',{exact:true}).isVisible())throw Error('Owner rules page missing');
 const base=origin+'/api/authorizations/'+authorizationId+'/rules';let completed=false;
 const read=async(path:string)=>{await tab.goto(path);await tab.getAXState({emit:false});if(await tab.url()!==path)throw Error('Owner readback redirected');return JSON.parse(await tab.playwright.locator('pre').innerText());};
 try{
  const before=await read(base),task=await read(base+'/tasks/details'),reviewer=await read(base+'/task-review-opus/details'),after=await read(base);
  if(typeof before.sourceEtag!=='string'||! /^[a-f0-9]{64}$/.test(before.sourceEtag)||after.sourceEtag!==before.sourceEtag||before.stale!==false||after.stale!==false||before.fileEtag!==before.sourceEtag||after.fileEtag!==after.sourceEtag||before.errors?.length!==0||after.errors?.length!==0)throw Error('Owner definitions changed or are uncertain');
  if(task.fields?.id!=='tasks'||task.fields.resourceProvider!=='jira-work'||task.fields.enabled!==true||stable(task.fields.agentPreferences)!==stable([{harness:'claude',model:'sonnet',effort:'high'}])||reviewer.fields?.id!=='task-review-opus'||reviewer.fields.enabled!==true||stable(reviewer.fields.agentPreferences)!==stable([{harness:'codex',model:'gpt-5.6-terra',effort:'medium'}]))throw Error('Owner task/reviewer intent differs');
  completed=true;return {checkedAt:now(),origin,authorizationId,sourceEtag:after.sourceEtag,taskHash:renewalEvidenceHash(task.fields),reviewerHash:renewalEvidenceHash(reviewer.fields)};
 }finally{if(!completed){await tab.goto(rules);await tab.getAXState({emit:false});}}
}
export interface RenewalInspectionIO{
 service:()=>Record<string,string>;competingPids:()=>number[]|Promise<number[]>;readPrivate:(path:string)=>string;exists:(path:string)=>boolean;rpc:(method:string,params:object)=>Promise<any>;
}
export function splitServiceEnvironment(text:string):string[]{const out:string[]=[];let token='',quoted=false,escaped=false;for(const c of text.trim()){if(escaped){if(c!=='\\'&&c!=='"'&&c!==' ')throw Error('Unsupported service environment escape');token+=c;escaped=false;}else if(c==='\\')escaped=true;else if(c==='"')quoted=!quoted;else if(/\s/.test(c)&&!quoted){if(token){out.push(token);token='';}}else token+=c;}if(quoted||escaped)throw Error('Malformed service environment');if(token)out.push(token);return out;}
/** Narrow host compatibility: files with ANY path-variable mention remain unsupported.
 * Raw contents/credentials are never returned or logged; no shell evaluation occurs. */
export function requireFreezeNeutralEnvironmentFiles(spec:string):void{
 const matches=[...spec.matchAll(/([^\s]+) \(ignore_errors=(yes|no)\)/g)];
 if(matches.map(x=>x[0]).join(' ')!==spec)throw Error('Unsupported environment-file specification');
 for(const match of matches){
  const path=match[1]!;if(resolve(path)!==path||realpathSync(dirname(path))!==dirname(path))throw Error('Unsafe environment-file path');
  let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'&&match[2]==='yes')continue;throw e;}
  try{const st=fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>2_000_000)throw Error('Unsafe environment file');
   const text=readFileSync(fd,'utf8');if(text.includes('\\'))throw Error('Unsupported environment-file escape or continuation');if(/\b(?:DROVR_CONTROL_HOME|XDG_STATE_HOME|HOME)\b/.test(text))throw Error('Environment file may change freeze paths; explicit mapping required');
  }finally{closeSync(fd);}
 }
}
export interface ProtectedProcessImage{pid:number;startTicks:number;executable:string;sha256:string;}
export interface ProtectedProcessProof{checkedAt:number;bootId:string;processes:ProtectedProcessImage[];}
export interface ProtectedProcessInspection{bootId:string;expected:ReadonlyArray<ProtectedProcessImage>;operatorAncestorImage?:Pick<ProtectedProcessImage,'executable'|'sha256'>;attest:(expected:ReadonlyArray<ProtectedProcessImage>)=>Promise<ProtectedProcessProof>;}
/** Caller must obtain each proof over the verified administrator operator channel, never from a writable cache. */
export function verifyProtectedProcessProof(proof:ProtectedProcessProof,policy:ProtectedProcessInspection,now:number):void{
 if(proof.bootId!==policy.bootId||!Number.isFinite(proof.checkedAt)||proof.checkedAt>now||now-proof.checkedAt>5000||proof.processes.length!==policy.expected.length||new Set(proof.processes.map(p=>p.pid)).size!==proof.processes.length)throw Error('Protected process attestation stale or incomplete');
 for(const expected of policy.expected){const actual=proof.processes.find(p=>p.pid===expected.pid);if(!actual||actual.startTicks!==expected.startTicks||actual.executable!==expected.executable||actual.sha256!==expected.sha256)throw Error('Protected process image differs');}
}
/** No mutations: the production backend only reads known service/process/file and current-pane evidence. */
export function realRenewalInspectionIO(options:{runtimeDirectory:string;socketPath:string;procRoot?:string;freezeRoot:string;protectedProcesses?:ProtectedProcessInspection}):RenewalInspectionIO{
 const proc=options.procRoot??'/proc';
 return {
  service:()=>{const keys=['MainPID','ActiveState','SubState','Job','EnvironmentFiles','UnsetEnvironment'];const run=(args:string[])=>execFileSync('systemctl',['--user',...args],{encoding:'utf8',timeout:5000,maxBuffer:1_000_000});const text=run(['show','butchr.service',...keys.map(k=>'--property='+k)]);const result=Object.fromEntries(text.trim().split('\n').filter(Boolean).map(l=>{const at=l.indexOf('=');if(at<0)throw Error('Unknown service output');return [l.slice(0,at),l.slice(at+1)];}));requireFreezeNeutralEnvironmentFiles(result.EnvironmentFiles??'');if(splitServiceEnvironment(result.UnsetEnvironment??'').some(v=>['HOME','XDG_STATE_HOME','DROVR_CONTROL_HOME'].includes(v.split('=')[0]!)))throw Error('Selected unset path setting requires explicit mapping');
   // Retain ONLY these three nonsecret path variables; never return/log other environment values.
   const paths:Record<string,string>={};for(const line of run(['show-environment']).split('\n')){const at=line.indexOf('=');if(['DROVR_CONTROL_HOME','XDG_STATE_HOME','HOME'].includes(line.slice(0,at)))paths[line.slice(0,at)]=line.slice(at+1);}
   for(const token of splitServiceEnvironment(run(['show','butchr.service','--property=Environment','--value']))){const at=token.indexOf('=');if(['DROVR_CONTROL_HOME','XDG_STATE_HOME','HOME'].includes(token.slice(0,at)))paths[token.slice(0,at)]=token.slice(at+1);}
   result.FreezeControlRoot=paths.DROVR_CONTROL_HOME||join(paths.XDG_STATE_HOME||join(paths.HOME||homedir(),'.local/state'),'drovr/control');for(const [key,job,unit] of [['WatchdogTimerActive','WatchdogTimerJob','butchr-health-watchdog.timer'],['WatchdogServiceActive','WatchdogServiceJob','butchr-health-watchdog.service']] as const){result[key]=run(['show',unit,'--property=ActiveState','--value']).trim();result[job]=run(['show',unit,'--property=Job','--value']).trim();}return result;},
  competingPids:async()=>{
   const found:number[]=[];const policy=options.protectedProcesses;let dynamic:ProtectedProcessImage[]=[];
   const generation=(id:number)=>{const text=readFileSync(join(proc,String(id),'stat'),'utf8'),tail=text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/);if(tail.length<20||!/^\d+$/.test(tail[19]!))throw Error('Process generation unavailable');return Number(tail[19]);};
   let ancestrySnapshot:string|undefined;
   const ancestorGeneration=(wanted:number)=>{let pid=process.pid;const seen=new Set<number>(),chain:Array<{pid:number;parent:number;startTicks:number}>=[];for(let depth=0;pid>0&&depth<64;depth++){if(seen.has(pid))throw Error('Operator ancestry cycle');seen.add(pid);const text=readFileSync(join(proc,String(pid),'stat'),'utf8'),tail=text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/);if(!/^\d+$/.test(tail[1]??'')||!/^\d+$/.test(tail[19]??''))throw Error('Operator ancestry unavailable');const parent=Number(tail[1]);chain.push({pid,parent,startTicks:Number(tail[19])});pid=parent;}if(pid!==0)throw Error('Operator ancestry incomplete');const snapshot=JSON.stringify(chain);if(ancestrySnapshot!==undefined&&snapshot!==ancestrySnapshot)throw Error('Operator ancestry changed');ancestrySnapshot=snapshot;const row=chain.find(x=>x.pid===wanted);if(!row)throw Error('Inaccessible process is not an operator ancestor');return row.startTicks;};
   const scan=()=>{const protectedRows:number[]=[];dynamic=[];for(const id of readdirSync(proc)){if(!/^\d+$/.test(id))continue;const p=join(proc,id);
    try{if(lstatSync(p).uid!==process.getuid?.())continue;const cwd=readlinkSync(join(p,'cwd'));const args=readFileSync(join(p,'cmdline')).toString().split('\0');if(cwd===options.runtimeDirectory||args.some(a=>{if(!/(?:^|\/)butchr\.js$/.test(a))return false;return realpathSync(resolve(cwd,a))===realpathSync(join(options.runtimeDirectory,'dist/butchr.js'));}))found.push(Number(id));}
    catch(e){
     if((e as NodeJS.ErrnoException).code==='EACCES'&&policy){let expected=policy.expected.find(x=>x.pid===Number(id));if(!expected&&policy.operatorAncestorImage){expected={pid:Number(id),startTicks:ancestorGeneration(Number(id)),...policy.operatorAncestorImage};dynamic.push(expected);}if(!expected||generation(Number(id))!==expected.startTicks)throw Error('Unattested inaccessible process generation');protectedRows.push(Number(id));continue;}
     if(['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??'')){try{lstatSync(p);const stat=readFileSync(join(p,'stat'),'utf8');if(/\) Z /.test(stat))continue;}catch(gone){if(['ENOENT','ESRCH'].includes((gone as NodeJS.ErrnoException).code??''))continue;}}throw Error('Same-user process inspection is uncertain');
    }
   }return protectedRows.sort((a,b)=>a-b);};
   const protectedRows=scan();
   if(protectedRows.length){if(!policy||readFileSync(join(proc,'sys/kernel/random/boot_id'),'utf8').trim()!==policy.bootId)throw Error('Protected process boot differs');const expected=[...policy.expected,...dynamic].sort((a,b)=>a.pid-b.pid),livePolicy={...policy,expected};const proof=await policy.attest(expected);verifyProtectedProcessProof(proof,livePolicy,Date.now());for(const id of protectedRows)if(generation(id)!==expected.find(x=>x.pid===id)!.startTicks)throw Error('Protected process generation changed');if(readFileSync(join(proc,'sys/kernel/random/boot_id'),'utf8').trim()!==policy.bootId)throw Error('Protected process boot changed');if(JSON.stringify(scan())!==JSON.stringify(protectedRows))throw Error('Protected process inventory changed');if(JSON.stringify([...policy.expected,...dynamic].sort((a,b)=>a.pid-b.pid))!==JSON.stringify(expected))throw Error('Operator ancestry changed');verifyProtectedProcessProof(proof,livePolicy,Date.now());}
   return found;
  },
  readPrivate:path=>{if(resolve(path)!==path||realpathSync(dirname(path))!==dirname(path))throw Error('Noncanonical evidence path');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o022)||s.size>8_000_000)throw Error('Unsafe evidence file');return readFileSync(fd,'utf8');}finally{closeSync(fd);}},
  exists:path=>{try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
  rpc:(method,params)=>{if(!['agent.get','agent.list','pane.list','pane.read'].includes(method)||(method==='pane.read'&&((params as any).source!=='detection'||(params as any).strip_ansi!==true)))return Promise.reject(Error('Only read-only metadata/current detection RPC allowed'));return new Promise((ok,no)=>{const id=randomUUID(),socket=connect(options.socketPath);let text='';socket.setTimeout(5000,()=>socket.destroy(Error('Read-only Herdr timeout')));socket.on('connect',()=>socket.write(JSON.stringify({id,method,params})+'\n'));socket.on('error',no);socket.on('end',()=>{if(!text.includes('\n'))no(Error('Incomplete Herdr response'));});socket.on('data',b=>{text+=b.toString();if(text.length>8_000_000){socket.destroy(Error('Herdr response too large'));return;}if(!text.includes('\n'))return;socket.destroy();try{const reply=JSON.parse(text.slice(0,text.indexOf('\n')));if(reply.id!==id||reply.error)throw Error('Read-only Herdr request refused');ok(reply.result);}catch(e){no(e);}});});}
 };
}
export interface RealRenewalInspectionOptions{
 permit:CanaryPermit;stateDirectory:string;runtimeDirectory:string;freezeRoot:string;authoritySHA256:string;protectedCensusHash:string;
 /** Reviewed canonical readback: authenticated owner UI or registered server delivery; never arbitrary flags. */
 readOwner:()=>Promise<OwnerRenewalReadback>;
 /** Fresh ticket/operator policy clearance remains distinct from runtime idle status. */
 assertPolicyClear:()=>Promise<void>;
 artifactHashes:ReadonlyArray<{path:string;sha256:string}>;
}
export function createRealWorkerRenewalInspection(options:RealRenewalInspectionOptions,io:RenewalInspectionIO,now=()=>Date.now()){
 const permit=structuredClone(options.permit),source=permit.source;
 if(options.artifactHashes.length!==2||new Set(options.artifactHashes.map(x=>x.path)).size!==2||!options.artifactHashes.some(x=>x.path===join(options.runtimeDirectory,'dist/butchr.js'))||!options.artifactHashes.some(x=>x.path===join(options.runtimeDirectory,'dist/butchr-mcp.js')))throw Error('Both exact installed artifacts required');
 const checkLocalStopped=()=>{const s=io.service();if(s.MainPID!=='0'||s.ActiveState!=='inactive'||s.SubState!=='dead'||s.Job!=='')throw Error('Daemon service not verifiably stopped');if(s.FreezeControlRoot!==options.freezeRoot)throw Error('Service freeze root is uncertain or changed');if(s.WatchdogTimerActive!=='inactive'||s.WatchdogServiceActive!=='inactive'||s.WatchdogTimerJob!==''||s.WatchdogServiceJob!=='')throw Error('Automatic daemon launcher is active or uncertain');for(const file of options.artifactHashes){if(!file.path.startsWith(options.runtimeDirectory+'/dist/')||! /^[a-f0-9]{64}$/.test(file.sha256)||createHash('sha256').update(io.readPrivate(file.path)).digest('hex')!==file.sha256)throw Error('Installed artifact differs');}};
 const checkStopped=async()=>{checkLocalStopped();if((await io.competingPids()).length)throw Error('Competing daemon process');checkLocalStopped();};
 const assertStopped=async()=>{await checkStopped();};
 const inspect=async():Promise<CanaryRenewalSnapshot>=>{
  await assertStopped();await options.assertPolicyClear();
  const raw=io.readPrivate(join(options.stateDirectory,'remote-rule-authority.json'));if(createHash('sha256').update(raw).digest('hex')!==options.authoritySHA256)throw Error('Retained authority changed');const manifest=JSON.parse(raw);
  if(manifest.active!==true||manifest.source?.serverId!==permit.authority.serverId||manifest.source?.authorizationId!==permit.authority.authorizationId)throw Error('Authority identity differs');
  const expected=structuredClone(manifest.remote.find((x:any)=>x.definition?.id==='tasks')?.definition);if(!expected)throw Error('Task definition absent');expected.enabled=true;const reviewer=manifest.remote.find((x:any)=>x.definition?.id==='task-review-opus')?.definition;if(!reviewer)throw Error('Reviewer definition absent');
  const overrides=join(options.stateDirectory,'remote-overrides.json');let control={enabled:true,disabledRules:[] as string[]};if(io.exists(overrides))control=JSON.parse(io.readPrivate(overrides));if(control.enabled!==true||!Array.isArray(control.disabledRules)||control.disabledRules.length!==0)throw Error('Local master/override hold');
  const token=createHash('sha256').update(JSON.stringify([manifest.source,expected,true,false])).digest('hex');if(token!==permit.desiredToken)throw Error('Exact desired token changed');
  const stop=join(source.cwd,'.butchr-stop-cause.json');if(io.exists(stop))throw Error('Stop/unknown marker hold');const instance='butchr:'+permit.workerKey,freeze=join(options.freezeRoot,createHash('sha256').update(instance).digest('hex')+'.json');
  if(io.exists(freeze)){const f=JSON.parse(io.readPrivate(freeze));if(f.version!==1||f.instanceId!==instance||f.frozen!==false||typeof f.updatedAt!=='string')throw Error('Frozen or uncertain instance hold');}
  const a=(await io.rpc('agent.get',{target:source.paneId}))?.agent;if(a?.pane_id!==source.paneId||a.cwd!==source.cwd||a.agent!==source.provider||!['idle','done'].includes(a.agent_status)||a.interactive_ready!==true||nativeSessionHash(a.agent_session)!==source.sessionHash)throw Error('Exact source session/status changed');
  const checkPrompt=(prompt:unknown)=>{if(typeof prompt!=='string')throw Error('Current prompt unavailable');const tail=prompt.split('\n').filter(Boolean).slice(-15).join('\n');if(/respond to the mcp server request|sign in|not logged in|do you trust|untrusted|usage limit|session limit|quota|out of credits|approval required|waiting for approval|allow this/i.test(tail)||!/(?:^|\n)\s*[›❯>]\s*\S/.test(tail)||!/(gpt-[\w.-]+|claude-(?:opus|sonnet|haiku))/i.test(tail))throw Error('Current source prompt is held or uncertain');};
  checkPrompt((await io.rpc('pane.read',{pane_id:source.paneId,source:'detection',strip_ansi:true}))?.read?.text);
  const agents=(await io.rpc('agent.list',{}))?.agents,panes=(await io.rpc('pane.list',{}))?.panes;if(!Array.isArray(agents)||!Array.isArray(panes))throw Error('Incomplete census');const census={agents:agents.map((x:any)=>({pane:x.pane_id,provider:x.agent,cwd:x.cwd,sessionHash:nativeSessionHash(x.agent_session)})).sort((a:any,b:any)=>String(a.pane).localeCompare(String(b.pane))),panes:panes.map((x:any)=>x.pane_id).sort()};if(renewalEvidenceHash(census)!==options.protectedCensusHash)throw Error('Protected worker/human inventory changed');
  // Recheck physical/hold vetoes after all asynchronous reads. No state is written.
  await assertStopped();const finalStoppedAt=now();await options.assertPolicyClear();
  const owner=await options.readOwner();if(owner.origin!==manifest.source.origin||owner.authorizationId!==permit.authority.authorizationId||! /^[a-f0-9]{64}$/.test(owner.sourceEtag)||!Number.isFinite(owner.checkedAt)||owner.checkedAt>now()||now()-owner.checkedAt>5000||owner.taskHash!==renewalEvidenceHash(expected)||owner.reviewerHash!==renewalEvidenceHash(reviewer))throw Error('Authenticated canonical intent unavailable or changed');
  const final=(await io.rpc('agent.get',{target:source.paneId}))?.agent;if(final?.pane_id!==source.paneId||final.cwd!==source.cwd||final.agent!==source.provider||!['idle','done'].includes(final.agent_status)||final.interactive_ready!==true||nativeSessionHash(final.agent_session)!==source.sessionHash)throw Error('Source changed during inspection');if(io.exists(stop))throw Error('Stop marker appeared');if(io.exists(freeze)){const f=JSON.parse(io.readPrivate(freeze));if(f.version!==1||f.instanceId!==instance||f.frozen!==false)throw Error('Instance hold changed');}
  checkPrompt((await io.rpc('pane.read',{pane_id:source.paneId,source:'detection',strip_ansi:true}))?.read?.text);
  checkLocalStopped();
  if(io.readPrivate(join(options.stateDirectory,'remote-rule-authority.json'))!==raw)throw Error('Authority changed during inspection');
  let finalControl={enabled:true,disabledRules:[] as string[]};if(io.exists(overrides))finalControl=JSON.parse(io.readPrivate(overrides));if(finalControl.enabled!==true||!Array.isArray(finalControl.disabledRules)||finalControl.disabledRules.length!==0)throw Error('Local control changed during inspection');
  if(io.exists(stop))throw Error('Late stop marker hold');if(io.exists(freeze)){const f=JSON.parse(io.readPrivate(freeze));if(f.version!==1||f.instanceId!==instance||f.frozen!==false||typeof f.updatedAt!=='string')throw Error('Late instance hold');}
  if(now()-owner.checkedAt>5000||now()-finalStoppedAt>5000)throw Error('Canonical proof expired during inspection');return {checkedAt:now(),enabled:true,notHeld:true,desiredToken:token,targetProvider:permit.targetProvider,authority:structuredClone(permit.authority),source:structuredClone(source)};
 };
 return {assertStopped,inspect};
}
