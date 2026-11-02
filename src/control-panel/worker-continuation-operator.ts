import {assertClaudeTargetReady} from './worker-target-readiness.js';
import {createHash} from 'node:crypto';
import {readNativeTranscript,continuationChunkCount,type NativeTranscriptOptions} from '@brooswit/drovr';
import {issueExistingTargetContinuationPermit,nativeSessionHash,type ContinuationPermitRequest,type ExistingTargetContinuationProof} from './worker-rollout.js';
import type {ContinuationPolicyProof} from './worker-continuation-policy.js';
import {REPLACEMENT_HISTORY_LIMITS,type ReplacementHistoryIO} from './worker-replacement-operator.js';
/** Uses existing configured runtime identity; no transcript leaves the process. */
export function prepareExistingTargetContinuationOperator(request:Omit<ContinuationPermitRequest,'inspectExisting'>,io:ReplacementHistoryIO&{readPolicy:()=>Promise<ContinuationPolicyProof>;readTargetPrompt:(pane:string)=>Promise<unknown>},now=()=>Date.now()){
 const r={...request,next:structuredClone(request.next),ancestorReceipts:structuredClone(request.ancestorReceipts)},spec=r.next.continuation;
 if(!spec||r.next.version!==2)throw Error('Existing-target continuation permit required');
 const get=io.getAgent,reader=io.readTranscript??readNativeTranscript,policy=io.readPolicy;
 let cached:{source:Awaited<ReturnType<typeof request.inspect>>;target:ExistingTargetContinuationProof}|undefined;
 const exactSource=async()=>{const a=await get(r.next.source.paneId);if(a.pane_id!==r.next.source.paneId||a.cwd!==r.next.source.cwd||a.agent!==r.next.source.provider||!['idle','done'].includes(a.agent_status)||a.interactive_ready!==true||nativeSessionHash(a.agent_session)!==r.next.source.sessionHash||!['id','path'].includes(a.agent_session?.kind??'')||typeof a.agent_session?.value!=='string')throw Error('Continuation source native identity/status differs');return {kind:a.agent_session.kind as 'id'|'path',value:a.agent_session.value};};
 const exactTarget=()=>assertClaudeTargetReady(spec.target,{getAgent:get,readPrompt:io.readTargetPrompt},now);
 const fit=async(session:{kind:'id'|'path';value:string})=>{const text=await reader({provider:r.next.source.provider as NativeTranscriptOptions['provider'],cwd:r.next.source.cwd,session,maxBytes:REPLACEMENT_HISTORY_LIMITS.maxBytes});if(typeof text!=='string'||!text.trim()||text.trim()==='[]'||Buffer.byteLength(text)>REPLACEMENT_HISTORY_LIMITS.maxBytes||text.length>REPLACEMENT_HISTORY_LIMITS.maxChars)throw Error('Full continuation history exceeds finite bound; no truncation');return {sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),chars:text.length,chunks:continuationChunkCount(text)};};
 const inspect=async()=>{
  cached=undefined;await r.assertStopped();const ref=await exactSource();await exactTarget();const first=await fit(ref);
  // Slow configured checks precede an actual second read; nothing is restamped.
  const source=await r.inspect();
  // Process/hold inspection can be slow. Perform a NEW policy read afterward;
  // never reuse or restamp a proof begun before those checks.
  const currentPolicy=await policy();
  const finalRef=await exactSource();if(JSON.stringify(ref)!==JSON.stringify(finalRef))throw Error('Source native reference drifted');
  const final=await fit(finalRef);await exactSource();await exactTarget();
  if(JSON.stringify(first)!==JSON.stringify(final)||JSON.stringify(final)!==JSON.stringify(spec.snapshot))throw Error('Complete continuation history differs from reviewed snapshot');
  if(source.enabled!==true||source.notHeld!==true||source.desiredToken!==r.next.desiredToken||source.targetProvider!==r.next.targetProvider||JSON.stringify(source.authority)!==JSON.stringify(r.next.authority)||JSON.stringify(source.source)!==JSON.stringify(r.next.source)||JSON.stringify(currentPolicy.binding)!==JSON.stringify(spec.policy))throw Error('Continuation independent source/policy binding differs');
  const current=now();if(!Number.isFinite(current)||![source.checkedAt,currentPolicy.checkedAt].every(t=>Number.isFinite(t)&&t<=current&&current-t<=5000))throw Error('Continuation inspection aged during full history read');
  cached={source:structuredClone(source),target:{checkedAt:current,target:structuredClone(spec.target),ready:true,policy:structuredClone(currentPolicy),history:final}};
  return structuredClone(source);
 };
 const inspectExisting=async()=>{if(!cached)throw Error('Full continuation inspection must precede target proof');return structuredClone(cached.target);};
 return {inspectOnly:async()=>{await inspect();return {source:structuredClone(cached!.source),target:structuredClone(cached!.target)};},issueOnlyWhenApproved:async()=>{cached=undefined;try{return await issueExistingTargetContinuationPermit({...r,inspect,inspectExisting},now);}finally{cached=undefined;}}};
}
