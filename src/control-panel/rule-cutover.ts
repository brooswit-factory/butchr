import {briefFor} from "../agents/workspace.js";
/** Preparation only. No daemon import, disk writes, provider calls or worker lifecycle actions. */
import {createHash} from 'node:crypto';
import {parseRules,type Rule} from '../rules/rules.js';
import type {RemoteRule} from './remote-rules.js';
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(value)??'null';
export const effectiveRule=(rule:Rule):Rule=>({...rule,brief:rule.brief.startsWith("@builtin:")?briefFor(rule.brief.slice(9)):rule.brief});
export const ruleFingerprint=(rule:Rule)=>createHash("sha256").update(canonical(effectiveRule(rule))).digest("hex");
const digest=(rules:Rule[])=>createHash('sha256').update(canonical([...rules].sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');
export interface RuleCutoverPlan{equivalent:boolean;problems:string[];localDigest:string|null;remoteDigest:string|null;bindings:{localRuleId:string;remoteId:string;resourceProvider:string}[];rules:Rule[]}
/** Full-account migration preflight. An equivalent document is necessary, never sufficient authority to activate. */
export function prepareRuleCutover(localDocument:unknown,remote:readonly RemoteRule[],expected:{serverId:string;authorizationId:string}):RuleCutoverPlan{
 const blocked=(problems:string[]):RuleCutoverPlan=>({equivalent:false,problems,localDigest:null,remoteDigest:null,bindings:[],rules:[]});
 let local:Rule[],received:Rule[];const warnings:string[]=[];
 try{local=parseRules(localDocument,'local migration');}catch{return blocked(['Local document is invalid or contains unsupported fields; inspect field names without logging values']);}
 if(local.some(r=>r.resourceProvider==='filesystem'&&r.id==='managed-sessions'))return blocked(['Reserved built-in rule namespace']);
 if(warnings.length)return blocked(['Local document contains legacy fields with changed semantics; explicit review is required']);
 if(remote.some(r=>r.serverId!==expected.serverId||r.authorizationId!==expected.authorizationId||r.source!=='remote'||r.sourceRuleId!==r.definition.id||r.id!==`remote:${expected.serverId}:${expected.authorizationId}:${r.sourceRuleId}`))return blocked(['Remote provenance does not match the intended server/authorization']);
 try{received=parseRules({rules:remote.map(r=>r.definition)},'remote migration');}catch{return blocked(['Remote document is invalid or incomplete']);}
 const localDigest=digest(local.map(effectiveRule)),remoteDigest=digest(received.map(effectiveRule));if(localDigest!==remoteDigest)return {equivalent:false,problems:['Normalized rule definitions differ; no active local copy may be removed'],localDigest,remoteDigest,bindings:[],rules:[]};
 return {equivalent:true,problems:[],localDigest,remoteDigest,bindings:received.map(rule=>({localRuleId:rule.id,remoteId:remote.find(r=>r.sourceRuleId===rule.id)!.id,resourceProvider:rule.resourceProvider})),rules:structuredClone(received)};
}
/** A transport/config override affects new discovery only. Existing-agent policy must retain its admitted snapshot. */
export function remoteDiscoveryRules(plan:RuleCutoverPlan,control:{enabled:boolean;disabledRules:readonly string[]}):Rule[]{
 if(!plan.equivalent)throw new Error('Unverified remote rule cutover');
 return plan.rules.map(rule=>({...structuredClone(rule),enabled:rule.enabled&&control.enabled&&!control.disabledRules.includes(plan.bindings.find(b=>b.localRuleId===rule.id)!.remoteId)}));
}
