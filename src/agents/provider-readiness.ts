import {execFile} from 'node:child_process';
import type {ManagedAgentProvider} from '@brooswit/drovr';
import {parseIntegrationStatus} from '../operator/native-session.js';
export interface ProviderReadiness {ready:boolean;reason?:string;}
/** Read-only official status, never installation or credential inspection. Cache
 * unavailable/missing results too: repeated census retries cannot spawn or flood CLI. */
export function createProviderReadiness(options:{inspect?:()=>Promise<string>;now?:()=>number;cacheMs?:number}={}){
 const now=options.now??(()=>performance.now()),cacheMs=options.cacheMs??30_000;
 if(!Number.isFinite(cacheMs)||cacheMs<=0)throw Error('Readiness cache duration must be positive');
 const inspect=options.inspect??(()=>new Promise<string>((resolve,reject)=>execFile('herdr',['integration','status'],{encoding:'utf8',timeout:5000,maxBuffer:65536},(error,stdout)=>error?reject(error):resolve(stdout))));
 let cached:{until:number;text:string|null}|undefined,pending:Promise<void>|undefined;
 return async(provider:ManagedAgentProvider):Promise<ProviderReadiness>=>{
  if(provider!=='claude'&&provider!=='codex')return {ready:true};
  if(!cached||now()>=cached.until){
   pending??=(async()=>{let text:string|null=null;try{text=await inspect();}catch{}cached={text,until:now()+cacheMs};})().finally(()=>{pending=undefined;});await pending;
  }
  const status=cached?.text===null?'unknown':parseIntegrationStatus(cached?.text??'').integrations.find(i=>i.name===provider)?.status??'unknown';
  return status==='installed'?{ready:true}:{ready:false,reason:`Official ${provider} integration ${status}; paid launch blocked before workspace creation. Install/approve through the supported operator workflow; status rechecks within ${Math.ceil(cacheMs/1000)}s. No rules changed.`};
 };
}
