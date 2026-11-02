import {AsyncLocalStorage} from 'node:async_hooks';
/** Guard effectful RPCs after every asynchronous wait, including SDK retries. */
export function createLifecycleFence<T extends object>(client:T){
 const context=new AsyncLocalStorage<()=>void>();
 const effects:Record<string,ReadonlySet<string>>={agent:new Set(['start','stop','prompt']),workspace:new Set(['create','close','rename','reportMetadata']),pane:new Set(['close','sendText','sendKeys','reportAgentSession'])};
 const wrapped=new Map<PropertyKey,unknown>();
 const proxy=new Proxy(client,{get(target,group,receiver){const value=Reflect.get(target,group,receiver);if(typeof group!=='string'||!effects[group]||!value||typeof value!=='object')return value;if(!wrapped.has(group))wrapped.set(group,new Proxy(value,{get(surface,method){const fn=Reflect.get(surface,method);if(typeof fn!=='function')return fn;return (...args:unknown[])=>{if(typeof method==='string'&&effects[group]!.has(method))context.getStore()?.();return Reflect.apply(fn,surface,args);};}}));return wrapped.get(group);}});
 return {client:proxy,run:<R>(guard:()=>void,action:()=>Promise<R>)=>context.run(guard,async()=>{guard();return action();})};
}
