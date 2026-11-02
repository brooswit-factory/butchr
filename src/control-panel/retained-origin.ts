import {validAgentProvenance,type AgentProvenance} from './telemetry-wire.js';

type Authority={serverId:string;authorizationId:string;origin?:unknown};
/** Wire provenance excludes transport URL metadata, even when authority carries it. */
export function remoteAdmittedIdentity(authority:Authority){
 return {source:'remote' as const,serverId:authority.serverId,authorizationId:authority.authorizationId};
}
/** One older producer spread transport authority into its persisted admitted identity.
 * Recognize only that exact, same-authority, canonical HTTPS origin extension.
 * This is load-time in-memory compatibility, never a relaxed telemetry validator.
 */
export function restoreRetainedProvenance(value:unknown,authority:Authority):AgentProvenance{
 if(validAgentProvenance(value))return value;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid admitted origin');
 const input=value as Record<string,unknown>,admitted=input.admittedRule;
 if(!admitted||typeof admitted!=='object'||Array.isArray(admitted))throw Error('Invalid admitted origin');
 const legacy=admitted as Record<string,unknown>;
 if(!Object.hasOwn(legacy,'origin')||typeof legacy.origin!=='string'||legacy.source!=='remote'||legacy.origin!==authority.origin||legacy.serverId!==authority.serverId||legacy.authorizationId!==authority.authorizationId)throw Error('Invalid admitted origin');
 let url:URL;try{url=new URL(legacy.origin);}catch{throw Error('Invalid admitted origin');}
 if(url.protocol!=='https:'||url.origin!==legacy.origin)throw Error('Invalid admitted origin');
 const {origin:_,...canonical}=legacy;
 const restored={...input,admittedRule:canonical};
 if(!validAgentProvenance(restored))throw Error('Invalid admitted origin');
 return restored;
}
