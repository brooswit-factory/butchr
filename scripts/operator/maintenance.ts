#!/usr/bin/env bun
import {planFreshTargetAdoption,applyFreshTargetAdoption,freshTargetAdoptionStatus,type AdoptionRequest,type AdoptionPlan} from '../../src/operator/fresh-target-adoption.js';
import {freshTargetRuntime} from '../../src/operator/fresh-target-runtime.js';
import {createProviderReadiness} from '../../src/agents/provider-readiness.js';
/** Explicit local operator workflow. Default commands inspect only; no import-time mutations. */
import {parseArgs} from 'node:util';import {execFileSync} from 'node:child_process';
import {join,isAbsolute} from 'node:path';import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {assertRetirementServicesStopped} from '../../src/operator/retirement-writer.js';
import {inspectFreezeRoot} from '../../src/operator/maintenance-paths.js';
import {DrovrClient} from '@brooswit/drovr';
import {stagedBootstrapRuntime} from '../../src/operator/staged-bootstrap-runtime.js';
import {planBootstrapRollback,applyBootstrapRollback,bootstrapRollbackStatus,type BootstrapRequest,type BootstrapRollbackPlan} from '../../src/operator/staged-bootstrap.js';
import {planValidationRetirement,retireValidationMode,privateText,hash,verifyValidationRetirement,type RetirementIO} from '../../src/operator/validation-retirement.js';
import {planNativeRecovery,applyNativeRecovery,linuxNativeEvidence,nativeReadiness,parseIntegrationStatus,type NativeClient} from '../../src/operator/native-session.js';
export async function runMaintenance(args:string[]){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{'source-history':{type:'string'},repository:{type:'string'},'worker':{type:'string'},'source':{type:'string'},'target':{type:'string'},'daemon-url':{type:'string'},'target-executable':{type:'string'},'plan-file':{type:'string'},socket:{type:'string'},'herdr-bin':{type:'string'},state:{type:'string'},unit:{type:'string'},permit:{type:'string'},runtime:{type:'string'},'freeze-root':{type:'string'},workspaces:{type:'string'},pane:{type:'string'},'native-root':{type:'string',multiple:true},confirm:{type:'string'},'approval-reference':{type:'string'},help:{type:'boolean'}}});
 const [command,action='plan']=positionals;if(values.help||!command){console.log('butchr-operator readiness --socket PATH [--herdr-bin EXISTING_TRUSTED_BINARY]\nbutchr-operator native-session plan|apply --socket PATH --pane ID --native-root PERMITTED_DIRECTORY [--confirm EXACT_PLAN_HASH]\nbutchr-operator retire-validation plan|apply|status --socket PATH --state PRIVATE_DIRECTORY --permit PATH --runtime RELEASE_DIRECTORY --workspaces ROOT --freeze-root ROOT [--confirm EXACT_PLAN_HASH --approval-reference EXPLICIT_AUTHORIZATION]\nstaged-bootstrap plan requires --worker KEY --source PANE --target PANE --state DIR --daemon-url http://127.0.0.1:PORT --socket PATH --native-root EXACT_PROJECT --target-executable EXACT_IMAGE. staged-bootstrap apply|status requires --plan-file PRIVATE_FILE; apply additionally requires --confirm HASH --approval-reference AUTHORIZATION. It closes only a proven empty staged target; normal reconciliation may resume a paid history handoff. Other apply commands never stop services, clear independent holds, install hooks, or start workers. Retirement requires independently stopped daemon/watchdog and no competing runtime. Plan is read-only.\nfresh-target plan requires --state --permit --socket --runtime --workspaces --freeze-root --repository --source-history --native-root --target-executable; daemon/watchdog must already be stopped. apply requires --plan-file --confirm --approval-reference. It adopts only the exact source-absent historical target: no launch, close, prompt or history import. status requires --state --confirm.');return;}
 if(command==='fresh-target'){
  if(action==='status'){if(!values.state||!values.confirm)throw Error('Explicit state and confirmation required');console.log(JSON.stringify(freshTargetAdoptionStatus(values.state,values.confirm),null,2));return;}
  if(action==='plan'){
   if(!values.state||!values.permit||!values.socket||!values.runtime||!values.workspaces||!values['freeze-root']||!values.repository||!values['source-history']||values['native-root']?.length!==1||!values['target-executable'])throw Error('Exact adoption paths required');
   const r:AdoptionRequest={state:values.state,permit:values.permit,socket:values.socket,runtime:values.runtime,unit:values.unit??'butchr.service',workspaces:values.workspaces,freezeRoot:values['freeze-root'],repository:values.repository,sourceHistory:values['source-history'],nativeRoot:values['native-root'][0]!,targetExecutable:values['target-executable']};
   console.log(JSON.stringify(await planFreshTargetAdoption(r,freshTargetRuntime(r)),null,2));return;
  }
  if(action!=='apply'||!values['plan-file'])throw Error('Reviewed owner-private adoption plan file required');const plan=JSON.parse(privateText(values['plan-file'])) as AdoptionPlan;
  console.log(JSON.stringify(await applyFreshTargetAdoption(plan,values.confirm??'',values['approval-reference']??'',freshTargetRuntime(plan.request)),null,2));return;
 }
 if(command==='staged-bootstrap'){
  let plan:BootstrapRollbackPlan;
  if(action==='plan'){
   if(!values.worker||!values.source||!values.target||!values.state||!values['daemon-url']||!values.socket||values['native-root']?.length!==1||!values['target-executable'])throw Error('Explicit exact worker, source, target, state, loopback daemon, socket, project root and image required');
   const request:BootstrapRequest={workerKey:values.worker,sourcePane:values.source,targetPane:values.target,stateDirectory:values.state,daemonOrigin:values['daemon-url'],socketPath:values.socket,nativeRoot:values['native-root'][0]!,targetExecutable:values['target-executable']};
   plan=await planBootstrapRollback(request,stagedBootstrapRuntime(request));console.log(JSON.stringify(plan,null,2));return;
  }
  if(!values['plan-file'])throw Error('Exact owner-private reviewed plan file required');plan=JSON.parse(privateText(values['plan-file'])) as BootstrapRollbackPlan;
  const io=stagedBootstrapRuntime(plan.request);
  if(action==='status'){console.log(JSON.stringify(await bootstrapRollbackStatus(plan,io),null,2));return;}
  if(action!=='apply')throw Error('Unknown staged-bootstrap action');console.log(JSON.stringify(await applyBootstrapRollback(plan,values.confirm??'',values['approval-reference']??'',io),null,2));return;
 }
 if(!values.socket||!isAbsolute(values.socket))throw Error('Explicit existing socket required');const client=new DrovrClient({socketPath:values.socket,timeoutMs:5000});const native=client as unknown as NativeClient;
 if(command==='readiness'){const binary=values['herdr-bin'];const inspected:NativeClient=binary?{agent:native.agent,pane:native.pane,integration:{list:async()=>parseIntegrationStatus(execFileSync(binary,['integration','status'],{encoding:'utf8',timeout:5000,maxBuffer:65536}))}}:native;const paidReadiness=createProviderReadiness(binary?{binary}:{});console.log(JSON.stringify({...await nativeReadiness(inspected),paidLaunchReadiness:{claude:await paidReadiness('claude'),codex:await paidReadiness('codex')}},null,2));return;}
 if(command==='native-session'){if(!values.pane)throw Error('Exact pane required');const io=linuxNativeEvidence(native),plan=await planNativeRecovery(native,values.pane,values['native-root']??[],io);console.log(JSON.stringify(action==='plan'?plan:action==='apply'?await applyNativeRecovery(native,plan,values.confirm??'',io):(()=>{throw Error('Unknown action');})(),null,2));return;}
 if(command==='retire-validation'&&action==='status'){if(!values.state)throw Error('State directory required');console.log(JSON.stringify({retired:verifyValidationRetirement(values.state,values.permit)}));return;}
 if(command!=='retire-validation'||!values.state||!values.permit||!values.runtime||!values.workspaces||!values['freeze-root'])throw Error('Retirement requires explicit existing state, permit, runtime, workspace and freeze roots');
 const state=values.state,permit=values.permit,runtime=realpathSync(values.runtime),workspaces=realpathSync(values.workspaces),freezeRoot=inspectFreezeRoot(values['freeze-root']).path;
 // Supported Linux user unit; no commands stop, restart, edit, disable or install anything.
 const selectedUnit=values.unit??'butchr.service';if(!/^butchr(?:-[A-Za-z0-9_-]+)?\.service$/.test(selectedUnit))throw Error('Existing Butchr user unit required');
 const fingerprint=(path:string)=>{let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}try{if(realpathSync(path)!==path)throw Error('Control path must be canonical');const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o022)||s.nlink!==1||s.size>8_000_000)throw Error('Unsafe selected control file');const text=readFileSync(fd,'utf8'),after=fstatSync(fd);if([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':')!==[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':'))throw Error('Control file changed during read');return hash(text);}finally{closeSync(fd);}};
 const show=(unit:string)=>Object.fromEntries(execFileSync('systemctl',['--user','show',unit,'-p','MainPID','-p','ActiveState','-p','SubState','-p','Job','-p','WorkingDirectory','-p','ExecStart'],{encoding:'utf8',timeout:5000}).trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
 const io:RetirementIO={
  census:async()=>{const [{agents},{panes}]=await Promise.all([client.agent.list(),client.pane.list()]);const full=await Promise.all(panes.map(p=>client.pane.get(p.pane_id)));return {agents,panes:full.map((p:any)=>p.pane??p)};},
  holds:async()=>{const manifest=JSON.parse(privateText(join(state,'remote-rule-authority.json')));const paths=[join(state,'remote-rule-authority.json'),join(state,'remote-overrides.json')];for(const [id] of manifest.retained??[]){if(typeof id!=='string')throw Error('Unknown retained identity');paths.push(join(freezeRoot,hash('butchr:'+id)+'.json'));}
   // Only exact stop-marker names under the explicitly permitted workspace root. No native history or credentials.
   const {agents}=await client.agent.list();for(const a of agents){const cwd=a.cwd;if(!cwd||!isAbsolute(cwd)||!(cwd===workspaces||cwd.startsWith(workspaces+'/')))continue;paths.push(join(cwd,'.butchr-stop-cause.json'));}
   return {freezeRoot:inspectFreezeRoot(freezeRoot),files:[...new Set(paths)].sort().map(path=>({path,sha256:fingerprint(path)}))};},
  assertStopped:async()=>{if(process.platform!=='linux')throw Error('Linux service proof required');assertRetirementServicesStopped(runtime,selectedUnit,show);
  }
 };
 const plan=await planValidationRetirement(state,permit,io);if(action==='plan'){console.log(JSON.stringify(plan,null,2));return;}if(action!=='apply')throw Error('Unknown action');console.log(JSON.stringify(await retireValidationMode(plan,values.confirm??'',values['approval-reference']??'',io),null,2));
}
if(import.meta.main)runMaintenance(process.argv.slice(2)).catch(()=>{console.error('Maintenance refused. Inspect exact plan, permissions, service/hold state and native identity locally. No automatic retry, access fallback or worker launch.');process.exitCode=1;});
