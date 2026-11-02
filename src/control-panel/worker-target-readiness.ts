import {createHash} from 'node:crypto';
import type {CanaryPermit} from './worker-rollout.js';
type Target=NonNullable<CanaryPermit['continuation']>['target'];
export interface TargetReadinessIO {getAgent:(pane:string)=>Promise<unknown>;readPrompt:(pane:string)=>Promise<unknown>}
const stable=(v:unknown)=>JSON.stringify(v);
/** Claude's pinned AgentInfo contract makes interactive_ready optional. Absence
 * is not readiness: positively require a fresh exact current detection prompt.
 * An explicit false/null or a busy/ambiguous identity always refuses. */
export async function assertClaudeTargetReady(expectedIn:Target,io:TargetReadinessIO,now=()=>Date.now()){
 const expected=structuredClone(expectedIn),started=now();
 const exact=(value:unknown)=>{const a=value as any,ref=a?.agent_session;
  if(!a||a.pane_id!==expected.paneId||a.workspace_id!==expected.workspaceId||a.terminal_id!==expected.terminalId||a.cwd!==expected.cwd||a.agent!=='claude'||!['idle','done'].includes(a.agent_status)||(a.interactive_ready!==undefined&&a.interactive_ready!==true)||ref?.agent!=='claude'||ref.kind!=='id'||typeof ref.value!=='string'||createHash('sha256').update(stable([ref.agent,ref.kind,ref.value])).digest('hex')!==expected.sessionHash)throw Error('Exact Claude target identity/readiness is uncertain');
  return stable([a.pane_id,a.workspace_id,a.terminal_id,a.cwd,ref.agent,ref.kind,ref.value,a.interactive_ready]);
 };
 const before=exact(await io.getAgent(expected.paneId));const result=await io.readPrompt(expected.paneId) as any,view=result?.read;
 if(!view||view.pane_id!==expected.paneId||view.workspace_id!==expected.workspaceId||view.source!=='detection'||view.truncated!==false||typeof view.text!=='string'||!view.text.trim()||view.text.length>32768||/\x1b/.test(view.text))throw Error('Fresh complete current Claude prompt required');
 const text=view.text,lines=text.split('\n').filter((l:string)=>l.trim()),tail=lines.slice(-15).join('\n');
 const composer=lines.findLastIndex((l:string)=>/^\s*[❯›>]/.test(l));
 if(composer<Math.max(0,lines.length-15)||!/^\s*[❯›>]\s*$/.test(lines[composer]??''))throw Error('Current Claude composer is not unambiguously empty');
 const footer=lines.slice(composer+1);let models=0;
 if(!footer.length||footer.length>5)throw Error('Current Claude status footer is unavailable');
 for(const line of footer){
  if(/^[\s─━╌┄-]+$/.test(line))continue;
  if(/^\s*Sonnet\s+\d+(?:\.\d+)*(?:\s|[|│·]|$)/i.test(line)&&!/(?:opus|haiku|gpt-[a-z0-9.-]+)/i.test(line)){models++;continue;}
  if(/^\s*\? for shortcuts\s*$/.test(line))continue;
  if(/^\s*[^\p{L}\p{N}]*\s*(?:bypass permissions|accept edits|plan mode|default mode)(?: (?:on|off))?\s*\(shift\+tab to cycle\)(?:\s*·\s*← for agents)?\s*$/iu.test(line))continue;
  throw Error('Ambiguous current Claude footer or dialog content');
 }
 const lastLogin=Math.max(text.lastIndexOf('Login successful'),text.lastIndexOf('Successfully logged in'));
 const lastExpired=Math.max(text.lastIndexOf('Login expired'),text.lastIndexOf('Please run /login'),text.lastIndexOf('Not logged in'));
 const authTail=lastLogin>=0?text.slice(lastLogin):tail;
 if(models!==1||lastExpired>lastLogin||/login expired|please run \/login|not logged in|sign in|paste.{0,30}(?:code|token)|select.{0,20}(?:login|method)/i.test(authTail)||/do you trust|untrusted|allow this|waiting for approval|permission required|(?:enable|accept|approve|use|enter).{0,24}bypass permissions|bypass permissions.{0,24}(?:\?|yes|no)|usage limit|session limit|quota|out of credits|hit your limit|yes,?\s*continue/i.test(tail))throw Error('Claude authentication, normal prompt or hold clearance is uncertain');
 const after=exact(await io.getAgent(expected.paneId));
 if(before!==after||!Number.isFinite(started)||!Number.isFinite(now())||now()<started||now()-started>5000)throw Error('Claude readiness changed or expired during inspection');
 return {checkedAt:started,promptSHA256:createHash('sha256').update(text).digest('hex'),optionalMetadata:'positively verified current prompt' as const};
}
