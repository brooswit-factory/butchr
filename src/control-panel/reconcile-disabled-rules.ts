import type {ReconcileFailure} from '../agents/reconcile-failure.js';
import type {Herd} from '../agents/herd.js';

const stopping = new WeakMap<Herd, Map<string, Promise<void>>>();
/** Configuration reconciliation runs even when discovery is fenced by the last rule being OFF. */
export async function reconcileDisabledRules(herd:Herd, owns:(id:string)=>boolean, onStopped?:(id:string)=>void|Promise<void>):Promise<{failures:ReconcileFailure[];running:readonly string[]}> {
 const policy=herd.ruleRuntime?.();
 if(!policy)return {failures:[],running:[]};
 if(!herd.ruleCensus){policy.census({ids:[],complete:false});return {failures:[],running:[]};}
 let running:readonly string[]=[];
 try{const census=await herd.ruleCensus();running=census.ids;policy.census(census);}
 catch(error){policy.census({ids:[],complete:false});throw error;}
 const lease=policy.generation(),failures:ReconcileFailure[]=[];
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
  try{await work;}catch(error){failures.push({id,stage:'stop',error});}
  finally{if(pending.get(id)===work)pending.delete(id);}
 }
 return {failures,running};
}
