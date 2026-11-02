import {applyPatch,type Operation} from 'fast-json-patch';
import type {Brief} from './brief.js';
import {decodeRemoteRules} from './remote-rules.js';
export const MAX_EVENT_BYTES=96_000_000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function decodeState(data:any,expected:{serverId:string;authorizationId:string}){
 if(!data||data.serverId!==expected.serverId||data.authorizationId!==expected.authorizationId||!uuid.test(data.serverId)||!uuid.test(data.authorizationId)||!Array.isArray(data.briefs)||data.briefs.length>1000)throw Error('Invalid stream source');
 const seen=new Set<string>();
 const briefs:Brief[]=data.briefs.map((b:any)=>{const prefix=`remote:${data.serverId}:${data.authorizationId}:`;if(!b||typeof b.id!=='string'||!b.id.startsWith(prefix)||!uuid.test(b.id.slice(prefix.length))||seen.has(b.id)||b.source!=='remote'||b.builtin!==false||typeof b.name!=='string'||!b.name.trim()||b.name.length>100||/[\x00-\x1f\x7f]/.test(b.name)||typeof b.text!=='string'||!b.text.trim()||b.text.length>200000||b.text.includes('\0')||b.text.startsWith('@builtin:'))throw Error('Invalid remote brief');seen.add(b.id);return {id:b.id,name:b.name,text:b.text,builtin:false,source:'remote'};});
 if(data.remoteRules===undefined)throw Error('Missing rule state');
 return {briefs,...decodeRemoteRules(data.remoteRules,data.serverId,data.authorizationId)};
}
export function createStreamState(expected:{serverId:string;authorizationId:string}){
 let document:any=null,revision:string|null=null;
 function id(value:unknown):{epoch:string;sequence:number}{if(typeof value!=='string')throw Error('Missing revision');const match=/^([0-9a-f-]{36}):(0|[1-9][0-9]{0,14})$/.exec(value);if(!match||!uuid.test(match[1]!))throw Error('Invalid revision');return {epoch:match[1]!,sequence:Number(match[2])};}
 return {receive(type:string,eventId:string,value:any){
  const next=id(value?.revision);if(eventId!==value.revision)throw Error('Event revision mismatch');
  if(type==='snapshot'){if(document||next.sequence!==0||value.resync!==true)throw Error('Invalid snapshot');const decoded=decodeState(value.state,expected);document=structuredClone(value.state);revision=value.revision;return decoded;}
  if(type!=='patch'||!document||!revision)throw Error('Snapshot required');
  const old=id(revision);
  if(next.epoch===old.epoch&&next.sequence<=old.sequence)return null;
  if(next.epoch!==old.epoch||next.sequence!==old.sequence+1||value.baseRevision!==revision)throw Error('Stream revision gap');
  if(!Array.isArray(value.patch)||value.patch.length>8||!value.patch.length)throw Error('Invalid patch');
  // Protocol v1 deliberately emits only whole-collection replace operations. These are RFC6902
  // operations, not merge patch or LaunchDarkly flag updates. Limit paths before library traversal.
  for(const operation of value.patch)if(operation?.op!=='replace'||!['/briefs','/remoteRules'].includes(operation.path))throw Error('Unsupported patch operation');
  const candidate=applyPatch(structuredClone(document),value.patch as Operation[],true,true,true).newDocument;
  const decoded=decodeState(candidate,expected);document=candidate;revision=value.revision;return decoded;
 },revision:()=>revision};
}
