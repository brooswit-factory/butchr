import {test,expect} from 'bun:test';
import {createWorkerReconciler,type WorkerChange,type WorkerChangeState} from '../../src/control-panel/worker-reconciliation.js';
const change=(token:string,id='task'):WorkerChange=>({id,token,spec:{key:id,issuetype:'Task',summary:'Synthetic work',parent:null}});
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};}
const target={paneId:'new',provider:'claude'};
test('handoffs globally serialize, coalesce duplicate intents and preserve latest queued revision',async()=>{
 const hold=gate(),started=gate(),calls:string[]=[],states:string[]=[];let active=0,peak=0;
 const q=createWorkerReconciler({valid:()=>true,state:(c,s)=>states.push(c.token+':'+s.status),apply:async(c)=>{calls.push(c.token);peak=Math.max(peak,++active);if(c.token==='one'){started.release();await hold.promise;}active--;return {status:'applied',current:target};}});
 q.request(change('one'));await started.promise;q.request(change('one'));q.request(change('two'));q.request(change('three'));q.request(change('review','reviewer'));hold.release();await q.idle();
 expect(calls).toEqual(['one','three','review']);expect(peak).toBe(1);expect(states).toContain('one:superseded');expect(states).not.toContain('one:applied');q.request(change('three'));await q.idle();expect(calls.length).toBe(3);
});
test('OFF then ON identical configuration never revives a cancelled in-flight incarnation',async()=>{
 const hold=gate(),started=gate(),guards:boolean[]=[],states:WorkerChangeState[]=[],calls:string[]=[];
 const q=createWorkerReconciler({valid:()=>true,state:(_c,s)=>states.push(s),apply:async(c,current)=>{calls.push(c.token);if(calls.length===1){started.release();await hold.promise;guards.push(current());return {status:'blocked',reason:'superseded'};}return {status:'applied',current:target};}});
 q.request(change('same'));await started.promise;q.cancel('task');q.request(change('same'));hold.release();await q.idle();expect(guards).toEqual([false]);expect(calls).toEqual(['same','same']);expect(states.filter(s=>s.status==='applied').length).toBe(1);expect(states.some(s=>s.status==='superseded')).toBe(true);
});
test('disable cancels active guard and queued work without removing physical worker',async()=>{
 const hold=gate(),started=gate(),calls:string[]=[];let valid=true;
 const q=createWorkerReconciler({valid:()=>valid,state:()=>{},apply:async(c,current)=>{calls.push(c.token);started.release();await hold.promise;expect(current()).toBe(false);return {status:'blocked',reason:'disabled',current:{paneId:'old',provider:'codex'}};}});
 q.request(change('one'));await started.promise;q.request(change('two'));valid=false;q.cancel('task');hold.release();await q.idle();expect(calls).toEqual(['one']);
});
test('blocked attempts require explicit retry and retain prior physical identity',async()=>{
 let calls=0;const q=createWorkerReconciler({valid:()=>true,state:()=>{},apply:async()=>++calls===1?{status:'blocked',reason:'missing history',current:{paneId:'old',provider:'codex'}}:{status:'applied',current:target}});
 q.request(change('one'));await q.idle();expect(q.state('task')?.current?.paneId).toBe('old');q.request(change('one'));await q.idle();expect(calls).toBe(1);q.request(change('one'),true);await q.idle();expect(calls).toBe(2);expect(q.state('task')?.status).toBe('applied');
});
test('failed pending persistence prevents effects; failed ACK persistence records partial target',async()=>{
 let calls=0,failPending=true;const states:WorkerChangeState[]=[];
 const q=createWorkerReconciler({valid:()=>true,state:(_c,s)=>{states.push(s);if(s.status==='pending'&&failPending)throw Error('pending write');if(s.status==='applied')throw Error('applied write');},apply:async()=>{calls++;return {status:'applied',current:target};}});
 q.request(change('one'));await q.idle();expect(calls).toBe(0);failPending=false;q.request(change('one'),true);await q.idle();expect(calls).toBe(1);expect(states.at(-1)).toMatchObject({status:'blocked',partial:true,current:target});
});

test('acknowledged terminal validation cannot bypass cancelled request incarnation',async()=>{const started=gate(),wait=gate(),states:WorkerChangeState[]=[];let valid=true;const q=createWorkerReconciler({valid:()=>valid,validResult:()=>true,state:(_c,s)=>states.push(s),apply:async()=>{started.release();await wait.promise;return {status:'applied',current:target};}});q.request(change('same'));await started.promise;q.cancel('task');valid=false;wait.release();await q.idle();expect(states.some(s=>s.status==='applied')).toBe(false);expect(states.at(-1)).toMatchObject({status:'superseded',partial:true,current:target});});
test('terminal result validation cannot admit work and only validates exact returned identity',async()=>{let valid=false,calls=0;const q=createWorkerReconciler({valid:()=>valid,validResult:(_c,r)=>r.status==='applied'&&r.current.paneId===target.paneId,state:()=>{},apply:async()=>{calls++;valid=false;return {status:'applied',current:target};}});q.request(change('one'));await q.idle();expect(calls).toBe(0);valid=true;q.request(change('two'));await q.idle();expect(calls).toBe(1);expect(q.state('task')?.status).toBe('applied');});
