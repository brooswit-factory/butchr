import {renewalEvidenceHash,type OwnerRenewalReadback} from './worker-renewal-inspection.js';
import type {JiraIssueDetail} from '../atlassian/client.js';import type {JiraComment} from '../atlassian/types.js';
export interface ContinuationPolicyBinding {origin:string;issueKey:string;issueHash:string;taskHash:string;reviewerHash:string;}
export interface ContinuationPolicyProof {checkedAt:number;binding:ContinuationPolicyBinding;}
export interface ContinuationPolicyIO {intent:()=>Promise<OwnerRenewalReadback>;issue:()=>Promise<JiraIssueDetail>;comments:()=>Promise<JiraComment[]>;}
/** No semantic guessing: any change from the independently reviewed issue/comments stops the operation. */
export function continuationIssueHash(issue:JiraIssueDetail,comments:JiraComment[]):string {
 if(!issue||!issue.key||!issue.status||!issue.updated||typeof issue.description!=='string'||!Array.isArray(issue.labels)||!Array.isArray(comments)||comments.length>1000||new Set(comments.map(c=>c.id)).size!==comments.length||comments.some(c=>typeof c.id!=='string'||!c.id||typeof c.body!=='string'||!c.created))throw Error('Complete bounded issue policy evidence required');
 const value={issue,comments};if(Buffer.byteLength(JSON.stringify(value))>16*1024*1024)throw Error('Issue policy evidence exceeds bound');return renewalEvidenceHash(value);
}
/** Uses existing configured clients, not the main poll loop or copied credentials. */
export function createContinuationPolicyReader(expectedIn:ContinuationPolicyBinding,io:ContinuationPolicyIO,now=()=>Date.now()){
 const expected=structuredClone(expectedIn);
 if(!/^https:\/\//.test(expected.origin)||!expected.issueKey||![expected.issueHash,expected.taskHash,expected.reviewerHash].every(x=>/^[a-f0-9]{64}$/.test(x)))throw Error('Reviewed continuation policy binding required');
 return async():Promise<ContinuationPolicyProof>=>{
  const started=now();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const [intent,issue,comments]=await Promise.race([Promise.all([io.intent(),io.issue(),io.comments()]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Continuation policy read deadline expired')),10000);})]);
   if(!Number.isFinite(started)||!Number.isFinite(now())||now()<started||now()-started>5000||!Number.isFinite(intent.checkedAt)||intent.checkedAt<started||intent.checkedAt>now()||intent.origin!==expected.origin||intent.taskHash!==expected.taskHash||intent.reviewerHash!==expected.reviewerHash||issue.key!==expected.issueKey||continuationIssueHash(issue,comments)!==expected.issueHash)throw Error('Fresh complete continuation policy differs or is stale');
   // Timestamp the START of the complete read, never restamp old evidence.
   return {checkedAt:started,binding:structuredClone(expected)};
  }finally{if(timer!==undefined)clearTimeout(timer);}
 };
}
