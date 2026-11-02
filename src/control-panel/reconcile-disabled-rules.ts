import type {Herd} from '../agents/herd.js';

const stopping = new WeakMap<Herd, Map<string, Promise<void>>>();
/** Configuration reconciliation runs even when discovery is fenced by the last rule being OFF. */
export async function reconcileDisabledRules(herd:Herd, owns:(id:string)=>boolean, onStopped?:(id:string)=>void|Promise<void>):Promise<void> {
 const policy=herd.ruleRuntime?.();
 if(!policy)return;
 if(!herd.ruleCensus){policy.census({ids:[],complete:false});return;}
 try{policy.census(await herd.ruleCensus());}
 catch(error){policy.census({ids:[],complete:false});throw error;}
 const lease=policy.generation();
 const pending=stopping.get(herd)??new Map<string,Promise<void>>();stopping.set(herd,pending);
 for(const id of policy.disabledWorkers(lease).filter(owns)){
  let work=pending.get(id);
  if(!work){
   work=(async()=>{
    // HerdrHerd rechecks this same numeric lease at every effectful RPC after asynchronous waits.
    if(policy.protectStop(id,lease))return;
    await herd.stop(id,lease);
    await onStopped?.(id);
   })();
   pending.set(id,work);
  }
  try{await work;}finally{if(pending.get(id)===work)pending.delete(id);}
 }
}
