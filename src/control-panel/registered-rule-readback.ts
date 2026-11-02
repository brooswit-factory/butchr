import {createParser} from 'eventsource-parser';
import {createStreamState,MAX_EVENT_BYTES} from './stream-state.js';
import {renewalEvidenceHash,type OwnerRenewalReadback} from './worker-renewal-inspection.js';
import {validateServerUrl} from './server-origin.js';
export interface RegisteredReadback {origin:string;key:string;serverId:string;authorizationId:string;deploymentId:string;sessionId:string;}
/** Server-authoritative machine delivery, not browser-owner authentication. No registration, telemetry or provider subscription. */
export async function readRegisteredRuleIntent(options:RegisteredReadback,fetchFn:typeof fetch=fetch,now=()=>Date.now()):Promise<OwnerRenewalReadback>{
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if(validateServerUrl(options.origin)!==options.origin||!options.origin.startsWith('https://')||![options.serverId,options.authorizationId,options.deploymentId,options.sessionId].every(x=>uuid.test(x))||!/^bsv1_[A-Za-z0-9_-]{43}$/.test(options.key))throw Error('Invalid registered readback scope');
 async function snapshot(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);let reader:Pick<ReadableStreamDefaultReader<Uint8Array>,'read'|'cancel'|'releaseLock'>|undefined;let primary:unknown;
  try{
   const response=await fetchFn(options.origin+'/v1/events',{method:'GET',redirect:'error',signal:controller.signal,headers:{accept:'text/event-stream',authorization:'Bearer '+options.key,'x-butchr-deployment-id':options.deploymentId,'x-butchr-session-id':options.sessionId}});
   if(response.status!==200||!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')||!response.body)throw Error('Registered configuration read refused');
   reader=response.body.getReader();let bytes=0,result:{checkedAt:number;revision:string;taskHash:string;reviewerHash:string}|undefined,failure:unknown;const state=createStreamState(options),decoder=new TextDecoder();
   const parser=createParser({onEvent:event=>{if(result||failure)return;try{if(event.event!=='snapshot')throw Error('Initial snapshot required');const decoded=state.receive('snapshot',event.id??'',JSON.parse(event.data));if(!decoded?.revision)throw Error('Canonical revision absent');const task=decoded.rules.find(r=>r.sourceRuleId==='tasks')?.definition,reviewer=decoded.rules.find(r=>r.sourceRuleId==='task-review-opus')?.definition;
    if(!task||!reviewer||task.resourceProvider!=='jira-work'||task.enabled!==true||renewalEvidenceHash(task.agentPreferences)!==renewalEvidenceHash([{harness:'claude',model:'sonnet',effort:'high'}])||reviewer.enabled!==true||renewalEvidenceHash(reviewer.agentPreferences)!==renewalEvidenceHash([{harness:'codex',model:'gpt-5.6-terra',effort:'medium'}]))throw Error('Canonical task/reviewer intent differs');
    result={checkedAt:now(),revision:decoded.revision,taskHash:renewalEvidenceHash(task),reviewerHash:renewalEvidenceHash(reviewer)};
   }catch(e){failure=e;}},onError:error=>{failure=error;}});
   while(!result&&!failure){const chunk=await reader!.read();if(chunk.done)throw Error('Truncated registered configuration');bytes+=chunk.value.byteLength;if(bytes>MAX_EVENT_BYTES)throw Error('Registered snapshot exceeds bound');parser.feed(decoder.decode(chunk.value,{stream:true}));}
   if(failure)throw failure;if(!result)throw Error('Registered snapshot absent');return result;
  }catch(e){primary=e;throw e;}finally{try{if(reader){try{await reader.cancel();}catch(e){if(!primary)throw Error('Registered stream cleanup failed');}finally{reader.releaseLock();}}}finally{clearTimeout(timer);controller.abort();}}
 }
 const first=await snapshot(),last=await snapshot();
 if(first.revision!==last.revision||first.taskHash!==last.taskHash||first.reviewerHash!==last.reviewerHash)throw Error('Canonical definitions changed between snapshots');
 if(now()-last.checkedAt>5000)throw Error('Registered observation expired during cleanup');
 return {checkedAt:last.checkedAt,origin:options.origin,authorizationId:options.authorizationId,sourceEtag:last.revision,taskHash:last.taskHash,reviewerHash:last.reviewerHash};
}
