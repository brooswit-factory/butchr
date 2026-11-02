/** Bounded observation edges with captured decisions and ordered recipient lanes. */
export function createObservationJournal<T,I>(options:{valid:(next:T)=>boolean;prepare:(previous:T,next:T)=>Promise<I[]>;capture?:(intent:I)=>Promise<void>;deliver:(intent:I)=>Promise<boolean>;key?:(intent:I)=>string;onError?:(error:unknown)=>void;onSuccess?:(next:T)=>void;limit?:number}){
 let committed:T|undefined,latest:T|undefined,running:Promise<void>|null=null,pending:I[]=[],staging:{next:T;intents:I[];captured:number}|null=null;const limit=options.limit??10000;
 async function flush(){let success=true;const blocked=new Set<string>(),keep:I[]=[];for(const intent of pending){const lane=options.key?.(intent);if(lane!==undefined&&blocked.has(lane)){keep.push(intent);continue;}try{if(await options.deliver(intent))continue;}catch(error){success=false;options.onError?.(error);}keep.push(intent);if(lane!==undefined)blocked.add(lane);}pending=keep;return success;}
 async function drain(){let healthy=await flush(),completed:T|undefined,observed=false;while(staging||latest!==undefined){
  if(staging){try{while(staging.captured<staging.intents.length){await options.capture?.(staging.intents[staging.captured]!);staging.captured++;}}catch(error){options.onError?.(error);return;}pending.push(...staging.intents);committed=staging.next;completed=committed;observed=true;staging=null;healthy=(await flush())&&healthy;continue;}
  const next=latest!;if(!options.valid(next))return;latest=undefined;if(committed===undefined){committed=next;completed=next;observed=true;continue;}
  try{const intents=await options.prepare(committed,next);if(pending.length+intents.length>limit)throw Error('Observation intent bound reached before decisions or delivery');staging={next,intents,captured:0};}catch(error){latest=latest??next;options.onError?.(error);return;}
 }if(observed&&healthy&&options.valid(completed!))options.onSuccess?.(completed!);}
 function submit(next:T,seed?:T){if(committed===undefined&&seed!==undefined)committed=seed;latest=next;if(!running){running=drain();void running.finally(()=>{running=null;});}return running;}
 return {submit,idle:()=>running??Promise.resolve(),status:()=>({hasCommitted:committed!==undefined,pending:pending.length>0||!!staging||latest!==undefined,remaining:pending.length+(staging?.intents.length??0)})};
}
