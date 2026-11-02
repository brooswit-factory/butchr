import { parseRules, type Rule } from "../rules/rules.js";
export interface RemoteRule { id:string;source:"remote";serverId:string;authorizationId:string;sourceRuleId:string;definition:Rule;executionState:"staged"|"active";remoteConfigsEnabled?:boolean;locallyDisabled?:boolean;effectiveEnabled?:boolean;disabledReason?:string|null }
export function decodeRemoteRules(value:unknown,serverId:unknown,authorizationId:unknown):{rules:RemoteRule[];revision:string|null}{
 if(value===undefined)return {rules:[],revision:null};
 if(!value||typeof value!=="object"||!Array.isArray((value as any).rules)||(value as any).rules.length>100||!/^[0-9a-f]{64}$/.test((value as any).revision))throw new Error("Invalid remote rule snapshot");
 if(typeof serverId!=="string"||typeof authorizationId!=="string"||!/^([0-9a-f-]{36})$/.test(serverId)||!/^([0-9a-f-]{36})$/.test(authorizationId))throw new Error("Invalid source identity");
 const entries=(value as any).rules as any[];
 for(const entry of entries){if(!entry||entry.source!=="remote"||entry.serverId!==serverId||entry.authorizationId!==authorizationId||!entry.definition||typeof entry.definition.enabled!=="boolean"||entry.sourceRuleId!==entry.definition.id||entry.id!==`remote:${serverId}:${authorizationId}:${entry.sourceRuleId}`)throw new Error("Invalid remote rule provenance");}
 if(entries.some(entry=>entry.definition.resourceProvider==='filesystem'&&entry.definition.id==='managed-sessions'))throw new Error('Reserved built-in rule namespace');
 const rules=parseRules({rules:entries.map(entry=>entry.definition)},"remote rules");
 return {rules:rules.map((definition,index)=>({id:entries[index].id,source:"remote",serverId,authorizationId,sourceRuleId:definition.id,definition,executionState:"staged"})),revision:(value as any).revision};
}
