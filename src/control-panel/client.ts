import {readRegisteredRuleIntent} from './registered-rule-readback.js';
import {createRuleRuntime,type RuntimeLocal,type RuleRuntime} from "./rule-runtime.js";
import {acquireRuntimeWriter,syncDirectory,writeDurableFile,unsafeGroupOtherBits} from "./writer.js";
import {lockDownAcl,unsafeWindowsAcl} from "./windows-acl.js";
import {createTelemetryOutbox,type OperationalSnapshot,type TelemetrySource} from "./telemetry.js";
import {createRemoteOverrides} from "./overrides.js";
import { type RemoteRule } from "./remote-rules.js";
import { readLimitedResponse } from "./read-response.js";
import {boundEventStream} from "./bounded-event-stream.js";
import {EventSource} from "eventsource";
import {createStreamState,MAX_EVENT_BYTES} from "./stream-state.js";
/** Sprint one: only identity registration and remote brief delivery. No commands. */
import { mkdirSync, readFileSync, renameSync, lstatSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Brief } from "./brief.js";
interface Configuration { serverUrl: string; key: string }
import {validateServerUrl} from "./server-origin.js";
export {validateServerUrl} from "./server-origin.js";

export function createControlPanelClient(directory: string, fetchFn: typeof fetch = fetch) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const deploymentPath=join(directory,"deployment-id"), configurationPath=join(directory,"control-panel.json");
  // Determining whether this directory already holds ANY control-panel state (not just
  // deployment-id — a review finding noted that file alone is not proof the directory
  // holds nothing else sensitive) is a pure read, and so is VERIFYING an already-
  // provisioned directory's ACL — both safe to do before any locking, and done here,
  // BEFORE acquireRuntimeWriter ever creates or touches anything inside this directory.
  // A review finding: mutating (creating the sqlite lock file, chmod, beginning a
  // transaction) inside an unsafe, already-provisioned directory before refusing it
  // violates verify-without-mutation — refusing happens here, first, unconditionally.
  //
  // .control-panel-writer.sqlite is deliberately EXCLUDED from this list (a second
  // review finding, native-reproduced): it is the locking mechanism's OWN marker, created
  // as the very FIRST step of ANY attempt at this directory — fresh or not — strictly
  // before the directory is ever locked down (that happens only after acquireRuntimeWriter
  // below succeeds). Treating its mere existence as "provisioned" means a losing racer in
  // a concurrent FRESH startup could observe the winner's just-created lock file, see the
  // directory's still-ambient ACL, and wrongly refuse it as unsafe instead of reaching the
  // normal "Another control-panel client owns this runtime directory" contention path.
  // Only deployment-id/control-panel.json/overrides/outbox/manifest — written AFTER a
  // startup has actually completed at least once — indicate real provisioned, sensitive
  // state worth refusing-without-mutation over.
  const alreadyProvisioned=["deployment-id","control-panel.json","remote-overrides.json","event-outbox.json","remote-rule-authority.json"].some(name=>existsSync(join(directory,name)));
  if(alreadyProvisioned&&unsafeWindowsAcl(directory))throw new Error("Unsafe Windows ACL on the control-panel directory; fix its ACL (or remove the directory and let it be recreated) before starting");
  const releaseWriter=acquireRuntimeWriter(directory);try{
  // Only an actual LOCKDOWN (a write) of a genuinely fresh (not-yet-provisioned)
  // directory needs serializing — reached only by the single process that just won
  // acquireRuntimeWriter's exclusive lock, never concurrently with another process
  // trying the same directory. Native testing found that two racing lockDownAcl calls
  // against the SAME directory (before any exclusivity mechanism serialized them) could
  // spuriously hit "SeSecurityPrivilege"; doing it here, after the real exclusivity gate,
  // removes the race entirely rather than chasing that error's exact cause.
  //
  // alreadyProvisioned above was read BEFORE acquiring that exclusivity, and native
  // testing found it can be stale by the time we reach here: a competitor can observe
  // `false`, then only actually win acquireRuntimeWriter once the real winner has
  // already provisioned the directory and released it. Acting on the stale `false`
  // would call lockDownAcl against a directory that's already provisioned — re-derive
  // it now, under our own held exclusivity, and apply the SAME unsafe-ACL refusal an
  // already-provisioned caller hit above instead of silently trusting a directory we
  // didn't originally observe as provisioned.
  const provisionedNow=alreadyProvisioned||["deployment-id","control-panel.json","remote-overrides.json","event-outbox.json","remote-rule-authority.json"].some(name=>existsSync(join(directory,name)));
  if(provisionedNow){
    if(unsafeWindowsAcl(directory))throw new Error("Unsafe Windows ACL on the control-panel directory; fix its ACL (or remove the directory and let it be recreated) before starting");
  }else{
    lockDownAcl(directory);
  }
  if(!existsSync(deploymentPath)){
    const candidateIdentity=join(directory,`.deployment-${randomUUID()}.tmp`);
    writeDurableFile(candidateIdentity,randomUUID()+"\n","wx",0o600);
    try{linkSync(candidateIdentity,deploymentPath);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}finally{unlinkSync(candidateIdentity);}
  }
  if(!lstatSync(deploymentPath).isFile() || lstatSync(deploymentPath).isSymbolicLink())throw new Error("Unsafe deployment identity file");
  const deploymentId=readFileSync(deploymentPath,"utf8").trim();
  if(!/^[0-9a-f-]{36}$/.test(deploymentId))throw new Error("Invalid deployment identity; repair it explicitly");
  const sessionId=randomUUID();
  const overrides=createRemoteOverrides(directory);
  const telemetry=createTelemetryOutbox(directory);let telemetrySource:TelemetrySource|null=null,observe:(()=>Omit<OperationalSnapshot,"remoteConfigsEnabled"|"transportConnected">)|null=null,publishing=false;
  let runtime:RuleRuntime|undefined;
  let config: Configuration|null=null, remote: Brief[]=[], remoteRules:RemoteRule[]=[],rulesRevision:string|null=null, status="Not configured", lastSeen:string|null=null, generation=0;
  let source:EventSource|null=null,retry:ReturnType<typeof setTimeout>|undefined,watchdog:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>|null=null,stopped=false,attempt=0,streamGeneration=0,streamRevision:string|null=null,snapshotEvents=0,patchEvents=0,settleConnection:()=>void=()=>{};
  function clearRemote(){remote=[];remoteRules=[];rulesRevision=null;streamRevision=null;}
  function closeStream(){settleConnection();settleConnection=()=>{};streamGeneration++;source?.close();source=null;clearTimeout(retry);clearTimeout(watchdog);}
  function disconnected(){clearRemote();status=config?'Disconnected — check server and authorization':'Not configured';notifyRuntime();}

  try{const stat=lstatSync(configurationPath);if(!stat.isFile()||stat.isSymbolicLink()||unsafeGroupOtherBits(stat.mode)||unsafeWindowsAcl(configurationPath))throw new Error("Control-panel configuration must be a private regular file");const value=JSON.parse(readFileSync(configurationPath,"utf8"));config=value===null?null:{serverUrl:validateServerUrl(value.serverUrl),key:validKey(value.key)};}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  function validKey(value:unknown):string {if(typeof value!=="string"||!/^bsv1_[A-Za-z0-9_-]{43}$/.test(value))throw new Error("Invalid authorization key format");return value;}
  function notifyRuntime(){runtime?.update({connected:status==='Connected',rules:remoteRules,revision:rulesRevision,control:overrides.snapshot(),source:telemetrySource??undefined});}
  function summary(){return {serverUrl:config?.serverUrl??"",configured:!!config,deploymentId,sessionId,status,lastSeen,remoteBriefCount:remote.length,remoteRuleCount:remoteRules.length,remoteConfigsEnabled:overrides.snapshot().enabled,telemetry:telemetry.summary(),transport:"eventsource-json-patch",streamRevision,snapshotEvents,patchEvents,ruleRuntime:runtime?.summary()??null};}
  function activateConfiguration(candidate:Configuration|null){cancelRequests();generation++;closeStream();pending=null;telemetrySource=null;config=candidate;clearRemote();lastSeen=null;status=config?"Connecting":"Not configured";notifyRuntime();void connect();}
  function configure(input:unknown){if(stopped)throw Error("Client stopped");
    if(!input||typeof input!=="object")throw new Error("Expected configuration");const b=input as Record<string,unknown>;
    const candidate=b.disconnect===true?null:{serverUrl:validateServerUrl(b.serverUrl),key:b.key===""&&config?config.key:validKey(b.key)};
    if(candidate && b.key==="" && config && candidate.serverUrl!==config.serverUrl)throw new Error("Enter a key when changing servers");
    const temp=join(directory,`.control-panel-${randomUUID()}.tmp`);
    let installed=false;
    try{writeDurableFile(temp,JSON.stringify(candidate),"wx",0o600);renameSync(temp,configurationPath);installed=true;syncDirectory(directory);}catch(error){if(installed)activateConfiguration(candidate);throw error;}finally{try{unlinkSync(temp);}catch{}}
    activateConfiguration(candidate);return summary();
  }
  const requests=new Set<AbortController>();
  function cancelRequests(){for(const request of requests)request.abort();requests.clear();}
  async function requestJson(url:string,init:RequestInit,limit=4096){const controller=new AbortController();requests.add(controller);try{const response=await fetchFn(url,{...init,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});if(!response.ok)throw Error('Request refused');return JSON.parse(await readLimitedResponse(response,limit));}finally{requests.delete(controller);}}
  async function register(current:Configuration){
    const receipt=await requestJson(`${current.serverUrl}/v1/register`,{method:"POST",redirect:"error",headers:{"content-type":"application/json",authorization:`Bearer ${current.key}`},body:JSON.stringify({deploymentId,sessionId})});
    if(receipt.registered!==true||typeof receipt.serverId!=='string'||typeof receipt.authorizationId!=='string')throw Error('Invalid registration');return {serverId:receipt.serverId as string,authorizationId:receipt.authorizationId as string};
  }
  function connect():Promise<void>{
    if(stopped||!config)return Promise.resolve();if(pending)return pending;
    closeStream();disconnected();const current=config,version=generation,connection=streamGeneration;
    const active=()=>!stopped&&version===generation&&connection===streamGeneration;
    const work=new Promise<void>(resolve=>{
      let settled=false;const done=()=>{if(!settled){settled=true;resolve();}};settleConnection=done;
      const fail=()=>{if(!active()){done();return;}closeStream();disconnected();done();const delay=Math.min(30000,1000*2**Math.min(attempt++,5))*(0.75+Math.random()*0.25);retry=setTimeout(()=>void connect(),delay);retry.unref();};
      const touch=()=>{clearTimeout(watchdog);watchdog=setTimeout(fail,30000);watchdog.unref();};
      touch();
      void register(current).then(expected=>{
        if(!active()){done();return;}
        telemetrySource={origin:current.serverUrl,...expected};
        const state=createStreamState(expected);
        const events=new EventSource(`${current.serverUrl}/v1/events`,{fetch:async(input,init)=>{
          const response=await fetchFn(input,{...init,redirect:'error',headers:{...Object.fromEntries(new Headers(init?.headers)),authorization:`Bearer ${current.key}`,'x-butchr-deployment-id':deploymentId,'x-butchr-session-id':sessionId}});
          if(!response.body)return response;
          // Bound parser buffering across arbitrary chunks and multiline SSE frames before EventSource.
          const bounded=boundEventStream(response.body,MAX_EVENT_BYTES);
          return new Response(bounded,{status:response.status,headers:response.headers});
        }});source=events;
        for(const type of ['snapshot','patch'])events.addEventListener(type,event=>{
          if(!active())return;
          try{if(event.data.length>MAX_EVENT_BYTES)throw Error('Event too large');const decoded=state.receive(type,event.lastEventId,JSON.parse(event.data));if(decoded){remote=decoded.briefs;remoteRules=decoded.rules;rulesRevision=decoded.revision;streamRevision=state.revision();type==='snapshot'?snapshotEvents++:patchEvents++;status='Connected';lastSeen=new Date().toISOString();attempt=0;notifyRuntime();}touch();done();if(type==='snapshot')void publishTelemetry();}catch{fail();}
        });
        events.addEventListener('heartbeat',event=>{if(!active())return;try{const message=JSON.parse(event.data);if(message.revision!==state.revision()||!state.revision())throw Error('Heartbeat gap');lastSeen=new Date().toISOString();touch();}catch{fail();}});
        events.addEventListener('revoked',fail);events.addEventListener('error',fail);
      }).catch(fail);
    });
    pending=work;void work.finally(()=>{if(pending===work)pending=null;});return work;
  }
  async function publishTelemetry(){
    if(publishing||stopped||!config||!telemetrySource)return;publishing=true;const version=generation,current=config,expected=telemetrySource;
    try{const observation=observe?.()??{mode:'unknown' as const,controllersEnabled:null,agentsChecked:false,agentsTruncated:false,agents:[]};
      telemetry.enqueue(expected,deploymentId,sessionId,{...observation,remoteConfigsEnabled:overrides.snapshot().enabled,transportConnected:status==='Connected'});
      await telemetry.flush(expected,async records=>{
        if(stopped||version!==generation||config!==current)throw Error('Connection changed');
        const first=records[0]!;const receipt=await requestJson(`${current.serverUrl}/v1/instance-events`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${current.key}`},body:JSON.stringify({deploymentId:first.deploymentId,sessionId:first.sessionId,events:records.map(r=>r.event)})});return receipt.acknowledgedSequence;
      });
    }catch{}finally{publishing=false;}
  }
  async function heartbeat(){if(!config||stopped)return;const version=generation,current=config;try{const expected=await register(current);if(version!==generation||config!==current)return;telemetrySource={origin:current.serverUrl,...expected};await publishTelemetry();}catch{if(version===generation){closeStream();disconnected();pending=null;void connect();}}}

  const timer=setInterval(()=>void heartbeat(),15000);timer.unref();void connect();
  const readContinuationIntent=async(authority:{serverId:string;authorizationId:string;deploymentId:string})=>{
    const current=config,version=generation,expected=telemetrySource;
    if(!current||!expected||stopped||status!=='Connected'||!overrides.snapshot().enabled||expected.serverId!==authority.serverId||expected.authorizationId!==authority.authorizationId||deploymentId!==authority.deploymentId)throw Error('Continuation canonical client authority unavailable or disabled');
    const result=await readRegisteredRuleIntent({origin:current.serverUrl,key:current.key,serverId:authority.serverId,authorizationId:authority.authorizationId,deploymentId,sessionId},fetchFn);
    if(stopped||version!==generation||config!==current||status!=='Connected'||!overrides.snapshot().enabled||telemetrySource?.serverId!==authority.serverId||telemetrySource.authorizationId!==authority.authorizationId)throw Error('Continuation authority changed during read');
    return result;
  };
  return {summary,configure,connect,readContinuationIntent,attachRuleRuntime:(local:RuntimeLocal)=>{if(runtime)throw Error("Rule runtime already attached");runtime=createRuleRuntime(directory,{...local,deploymentId});notifyRuntime();return runtime;},ruleRuntime:()=>runtime,setTelemetrySource:(source:NonNullable<typeof observe>)=>{observe=source;void publishTelemetry();},publishTelemetry,remoteConfig:overrides.snapshot,setRemoteConfig:(value:unknown)=>{if(stopped)throw Error("Client stopped");try{const result=overrides.update(value);void publishTelemetry();return result;}finally{notifyRuntime();}},remoteBriefs:()=>overrides.snapshot().enabled?remote:[],remoteRules:()=>({rules:remoteRules.map(rule=>({...rule,executionState:runtime?.summary().authority==="remote"?"active" as const:"staged" as const,remoteConfigsEnabled:overrides.snapshot().enabled,locallyDisabled:overrides.isDisabled(rule.id),effectiveEnabled:overrides.snapshot().enabled&&!overrides.isDisabled(rule.id)&&rule.definition.enabled&&(!runtime||runtime.summary().authority!=="remote"||runtime.summary().phase==="active"),disabledReason:!overrides.snapshot().enabled?"master-off":overrides.isDisabled(rule.id)?"local-override":!rule.definition.enabled?"server-disabled":null})),revision:rulesRevision,executionState:runtime?.summary().authority==="remote"?"active" as const:"staged" as const}),stop:()=>{stopped=true;cancelRequests();telemetry.stop();generation++;closeStream();clearInterval(timer);clearRemote();status="Stopped";notifyRuntime();releaseWriter();},deploymentId,sessionId};
  }catch(error){releaseWriter();throw error;}
}
export type ControlPanelClient=ReturnType<typeof createControlPanelClient>;
