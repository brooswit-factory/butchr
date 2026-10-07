import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {Elysia} from 'elysia';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {LATEST_PROTOCOL_VERSION} from '@modelcontextprotocol/sdk/types.js';
import {ResourceConnections} from '../../src/agents/resource-connections.js';
import {workspaceDirFor,type SpawnSpec} from '../../src/agents/workspace.js';
const cleanup:(()=>Promise<void>|void)[]=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'butchr-mcp-'));const old=process.env.BUTCHR_WORKSPACES;process.env.BUTCHR_WORKSPACES=dir;
 cleanup.push(async()=>{if(old===undefined)delete process.env.BUTCHR_WORKSPACES;else process.env.BUTCHR_WORKSPACES=old;await rm(dir,{recursive:true,force:true});});
 const file=join(dir,'config-P.json'), script=join(dir,'server.cjs');
 await writeFile(script,`const rl=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}}});
 else if(m.method==='notifications/initialized')send({jsonrpc:'2.0',method:'notifications/claude/channel',params:{content:'ping',meta:{sender:'test'}}});
 else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'identity',description:'identity',inputSchema:{type:'object'}}]}});
 else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:process.env.TEST_ID}]}});
 });`);
 await writeFile(file,JSON.stringify({mcpServers:{chat:{command:process.execPath,args:[script],env:{TEST_ID:'project-P'}}}}));
 const messages:string[]=[];const logs:string[]=[];
 const registry=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async(_id,text)=>{messages.push(text);return {delivered:true};}},s=>logs.push(s));cleanup.push(()=>registry.close());
 const app=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry.handle(request,params.agent,params.name));
 const spec:SpawnSpec={key:'jira-project:managers:P',resource:'P',issuetype:'project',summary:'P',parent:null,mcpConfigFile:join(dir,'config-{{KEY}}.json')};
 return {dir,file,script,spec,registry,app,messages,logs};
}
test('tools and notifications share one connection, stable gateway authenticates and caches configuration',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 expect(server.name).toBe('resource_chat');expect(server.url).toContain('jira-project%3Amanagers%3AP');
 expect((await f.app.handle(new Request(server.url,{method:'POST'}))).status).toBe(401);
 const client=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client.connect(transport as Parameters<Client["connect"]>[0]);cleanup.push(()=>client.close());
 expect((await client.listTools()).tools[0]!.name).toBe('identity');
 expect(await client.callTool({name:'identity',arguments:{}})).toMatchObject({content:[{type:'text',text:'project-P'}]});
 for(let i=0;i<20&&!f.messages.length;i++)await Bun.sleep(10);
 expect(f.messages).toHaveLength(1);expect(f.messages[0]).toContain('ping');
 expect((await f.registry.prepare(f.spec)).externalMcpServers).toEqual(spec.externalMcpServers);
 await expect(f.registry.prepare({...f.spec,mcpConfigFile:'/other'})).rejects.toThrow('restart');
 await f.registry.retain(new Set());expect((await f.app.handle(new Request(server.url))).status).toBe(401);
});
test('optional or invalid MCP configuration never silently connects another identity',async()=>{
 const f=await fixture();const plain={key:'jira-project:managers:P',issuetype:'project',summary:'P',parent:null};expect(await f.registry.prepare(plain)).toEqual(plain);
 await writeFile(f.file,'{}');await expect(f.registry.prepare(f.spec)).rejects.toThrow('mcpServers');
 await writeFile(f.file,JSON.stringify({mcpServers:{butchr:{url:'http://localhost'}}}));await expect(f.registry.prepare(f.spec)).rejects.toThrow('reserved');
});

/** Writes `.butchr-mcp-<name>.token` directly into the agent's real workspace dir, as `prepare()` would — WITHOUT ever calling `prepare()`, simulating "daemon just restarted, persisted token still on disk, registry empty." */
async function persistToken(agentKey:string,name:string):Promise<string> {
 const dir=workspaceDirFor(agentKey);await mkdir(dir,{recursive:true});
 const token=randomBytes(32).toString('hex');
 await writeFile(join(dir,`.butchr-mcp-${name}.token`),token,{mode:0o600});
 return token;
}
const urlFor=(agentKey:string,name:string)=>`http://local/resource-mcp/${encodeURIComponent(agentKey)}/${encodeURIComponent(name)}`;
async function allFiles(dir:string):Promise<string[]> {
 const out:string[]=[];
 for(const e of await readdir(dir,{withFileTypes:true,recursive:true}))out.push(join((e as any).parentPath??dir,e.name));
 return out.sort();
}

test('empty registry + NOT ready + valid persisted token => 503 + Retry-After + JSON body',async()=>{
 const f=await fixture();
 const token=await persistToken(f.spec.key,'chat');
 const res=await f.app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${token}`}}));
 expect(res.status).toBe(503);
 expect(res.headers.get('retry-after')).toBe('2');
 expect(await res.json()).toEqual({error:'butchr is starting; connection not ready, retry'});
});

test('an agent retired BEFORE a restart (never prepared in the new instance) still gets 401 once the global startup deadline elapses — not 503 forever',async()=>{
 const f=await fixture();
 // simulates: agent was retired before the daemon restarted — token file left on disk by the old instance, but this NEW instance's reconcile loop never matches/prepares it again.
 const token=await persistToken(f.spec.key,'chat');
 let t=0;const now=()=>t;
 const registry=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{},now,1000);
 cleanup.push(()=>registry.close());
 const app=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry.handle(request,params.agent,params.name));
 const withinWindow=await app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${token}`}}));
 expect(withinWindow.status).toBe(503); // still inside the startup window
 t=1000; // deadline elapsed; this agent's own prepare() STILL never ran
 const pastDeadline=await app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${token}`}}));
 expect(pastDeadline.status).toBe(401);
});

/**
 * FACTORY-700 cliff analysis, UPDATED by FACTORY-702 (work item 3) rather
 * than quietly deleted: the test above models a RETIRED agent (never
 * re-`prepare()`d in the new instance at all) — the deadline backstop must
 * still flip that case to 401, and still does (unchanged above). This one
 * models the OTHER half of FACTORY-700's hypothesis — an agent whose
 * `prepare()` is simply SLOW (still actively in flight, not abandoned) when
 * `startupDeadlineMs` elapses. Before FACTORY-702, `isReady()` could not
 * distinguish the two (both just read as `readyAgents.has(agent) === false`
 * to the deadline check), so this case ALSO got a wrongful 401 — FACTORY-700
 * confirmed that by measurement, not merely inference. FACTORY-702 fixes
 * it: `inFlightPrepares` (resource-connections.ts) now tracks exactly this
 * case, so the deadline cannot fire while a `prepare()` round for this
 * agent is genuinely running, and `handle()` HOLDS the request until that
 * round finishes instead of answering at all while it's indeterminate. The
 * request below is a bare GET (the SDK client's SSE probe, no session id)
 * — once the held round finishes and the connection comes up, `forward()`
 * answers it `405` (the spec-correct, non-fatal-to-the-client outcome for
 * that probe — FACTORY-696/697/698), which is the proof: a 401 here would
 * mean the cliff fired again despite `prepare()` only being slow, not dead.
 */
test('FACTORY-700/702: an agent whose prepare() is still IN FLIGHT (not abandoned) when the global deadline elapses is HELD, not flipped to 401 — the cliff no longer fires for "slow", only for "never coming back"',async()=>{
 const f=await fixture();
 // Replace the fixture's instant-reply script with one whose `initialize` response is deliberately delayed well past the injected deadline below, so prepare() is still genuinely in flight (not merely unstarted) when the request lands.
 await writeFile(f.script,`const rl=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}}}),300);
 });`);
 let t=0;const now=()=>t;
 const registry=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{},now,1000,5000);
 cleanup.push(()=>registry.close());
 const app=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry.handle(request,params.agent,params.name));
 // Persisted BEFORE prepare() runs, exactly as a real restart finds it: the token file already exists on disk from a prior generation, so prepare() just re-reads it (no race with its own ENOENT-triggered write).
 const token=await persistToken(f.spec.key,'chat');
 const prepared=registry.prepare(f.spec); // NOT awaited: prepare() is genuinely running (blocked on the slow stdio `initialize`), not abandoned.
 t=1000; // deadline elapsed per the injected clock, while prepare() above is still in flight.
 const start=Date.now();
 const res=await app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${token}`}}));
 expect(Date.now()-start).toBeGreaterThanOrEqual(250); // held for roughly the real 300ms prepare() delay, not answered instantly
 expect(res.status).toBe(405); // forwarded once ready — NOT 401: the cliff no longer fires while prepare() is genuinely in flight
 await prepared; // let the in-flight prepare() finish before the fixture's own cleanup closes the registry.
});

test('wrong token, at any readiness, is 401',async()=>{
 const f=await fixture();
 const token=await persistToken(f.spec.key,'chat');
 // not ready yet (prepare() never ran) — wrong bearer still 401, not 503
 const notReady=await f.app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${token}wrong`}}));
 expect(notReady.status).toBe(401);
 // same-LENGTH wrong token exercises the constant-time compare path without throwing on a length mismatch
 const sameLength=await f.app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${'0'.repeat(token.length)}`}}));
 expect(sameLength.status).toBe(401);
 // now ready (prepare() completed) — still 401 for a wrong bearer
 await f.registry.prepare(f.spec);
 const ready=await f.app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:'Bearer nope'}}));
 expect(ready.status).toBe(401);
});

test('unknown agent / unknown name / no token file => 401, never 503, identical response to a wrong-token 401 (no existence leak)',async()=>{
 const f=await fixture();
 const wrongTokenRes=await (async()=>{const token=await persistToken(f.spec.key,'chat');return f.app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${token}wrong`}}));})();
 const noTokenFile=await f.app.handle(new Request(urlFor(f.spec.key,'ghost'),{headers:{authorization:'Bearer whatever'}}));
 const unknownAgentKey='jira-project:managers:NOPE';
 const unknownAgent=await f.app.handle(new Request(urlFor(unknownAgentKey,'chat'),{headers:{authorization:'Bearer whatever'}}));
 for(const res of [noTokenFile,unknownAgent]) {
  expect(res.status).toBe(401);
  expect(res.status).toBe(wrongTokenRes.status);
  expect(await res.text()).toBe(await wrongTokenRes.clone().text());
  expect([...res.headers.keys()].sort()).toEqual([...wrongTokenRes.headers.keys()].sort());
 }
});

test('READY + absent connection + valid persisted token => 401, not 503 (the retire path — retain() leaves the token file on disk)',async()=>{
 const f=await fixture();await f.registry.prepare(f.spec);
 const dir=workspaceDirFor(f.spec.key);const token=(await Bun.file(join(dir,'.butchr-mcp-chat.token')).text()).trim();
 await f.registry.retain(new Set()); // closes the connection, does NOT delete the token file
 const res=await f.app.handle(new Request(urlFor(f.spec.key,'chat'),{headers:{authorization:`Bearer ${token}`}}));
 expect(res.status).toBe(401);
});

test('path-traversal and reserved-name attempts in agent and name are 401 and touch nothing outside the workspace',async()=>{
 const f=await fixture();
 const before=await allFiles(f.dir);
 const attempts:[string,string][]=[
  ['../../../../etc/passwd','chat'],
  [f.spec.key,'../../../../etc/passwd'],
  [f.spec.key,'butchr'],
  ['not-a-real-agent-key','chat'],
  [f.spec.key,'has/slash'],
 ];
 for(const [agent,name] of attempts) {
  const res=await f.app.handle(new Request(urlFor(agent,name),{headers:{authorization:'Bearer whatever'}}));
  expect(res.status).toBe(401);
 }
 expect(await allFiles(f.dir)).toEqual(before); // nothing created
});

test('GET with no Mcp-Session-Id => 405 (not 400), JSON body — the status the SDK client special-cases as "no SSE, carry on"',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const res=await f.app.handle(new Request(server.url,{method:'GET',headers:server.headers!}));
 expect(res.status).toBe(405);
 expect(res.headers.get('content-type')).toContain('application/json');
 expect((await res.json()) as any).toMatchObject({jsonrpc:'2.0',error:{message:expect.any(String)}});
 // FACTORY-697 pre-review #5: listing the rejected method in Allow is self-contradictory to a strict client.
 expect(res.headers.get('allow')).toBe('POST, DELETE');
});

test('FACTORY-696/697/698 regression: a client holding its PRE-restart Mcp-Session-Id completes a real tools/call with no re-initialize, no 404, and an unchanged session id',async()=>{
 const f=await fixture();
 const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;

 // Generation 1: a real client connects, initializes, and holds a session id.
 const client1=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport1=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client1.connect(transport1 as Parameters<Client["connect"]>[0]);
 const staleSessionId=transport1.sessionId;
 expect(staleSessionId).toBeTruthy();
 expect((await client1.listTools()).tools[0]!.name).toBe('identity');
 // Do NOT close client1 — a real restart leaves no DELETE behind either.

 // "daemon restart": a BRAND NEW ResourceConnections + prepare(), same BUTCHR_WORKSPACES — this MUST fail on
 // current (pre-fix) code: the new proxy generation's session map is empty, so replaying the stale id 404s.
 const registry2=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{});
 cleanup.push(()=>registry2.close());
 const app2=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry2.handle(request,params.agent,params.name));
 await registry2.prepare(f.spec); // reconcile already re-prepared this agent before the client's next request arrives

 // Replay the GEN-1 session id against the GEN-2 registry, as a raw tools/call — exactly what the client's
 // existing (un-reinitialized) transport would send next. No initialize, no re-connect.
 const toolsCallReq=new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':staleSessionId!,'mcp-protocol-version':transport1.protocolVersion??''},
  body:JSON.stringify({jsonrpc:'2.0',id:'r1',method:'tools/call',params:{name:'identity',arguments:{}}})});
 const res=await app2.handle(toolsCallReq);
 expect(res.status).toBe(200); // not 404 — the whole point of the fix
 const returnedSessionId=res.headers.get('mcp-session-id');
 // the real contract, checked unconditionally: the client must never see a session id other than its own.
 expect(returnedSessionId===null||returnedSessionId===staleSessionId).toBe(true);
 const text=await res.text();
 expect(text).toContain('project-P'); // a REAL tools/call reached the real upstream server, through the gen-2 proxy

 // A second request with the SAME stale id reuses the now-bound proxy session — still no 404, still the same id.
 const res2=await app2.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':staleSessionId!},
  body:JSON.stringify({jsonrpc:'2.0',id:'r2',method:'tools/call',params:{name:'identity',arguments:{}}})}));
 expect(res2.status).toBe(200);

 await client1.close().catch(()=>{}); // against gen1's own (still-open) registry; harmless either way
});

test('rewriteSessionHeader: a post-adoption response carrying the PROXY-minted Mcp-Session-Id is rewritten to the client\'s own id',async()=>{
 // What would make this fail: if rewriteSessionHeader were a no-op (e.g. `return response` unconditionally),
 // the header asserted below would come back as the PROXY's id, not the client's — this test would then fail
 // at the `toBe(staleSessionId)` assertion. Confirmed by temporarily reverting rewriteSessionHeader to a no-op
 // and observing exactly that failure.
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const client1=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport1=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client1.connect(transport1 as Parameters<Client["connect"]>[0]);
 const staleSessionId=transport1.sessionId!;

 // A new generation (adoption required) so the proxy mints a session id that DIFFERS from the client's.
 const registry2=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{});
 cleanup.push(()=>registry2.close());
 const app2=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry2.handle(request,params.agent,params.name));
 await registry2.prepare(f.spec);

 const res=await app2.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':staleSessionId},
  body:JSON.stringify({jsonrpc:'2.0',id:'r1',method:'tools/call',params:{name:'identity',arguments:{}}})}));
 expect(res.status).toBe(200);

 const bindings=((registry2 as unknown) as {connections:Map<string,{sessions:{clientToProxy:Map<string,string>}}>}).connections.get(f.spec.key+'/chat')!.sessions.clientToProxy;
 const proxySessionId=bindings.get(staleSessionId);
 expect(proxySessionId).toBeTruthy(); // adoption actually happened
 expect(proxySessionId).not.toBe(staleSessionId); // and minted a DIFFERENT id — the only case rewrite has anything to do
 expect(res.headers.get('mcp-session-id')).toBe(staleSessionId); // the client only ever sees its own id
 expect(res.headers.get('mcp-session-id')).not.toBe(proxySessionId);

 await client1.close().catch(()=>{});
});

test('a malformed Mcp-Session-Id (not visible-ASCII, or over the length bound) is rejected with 400 JSON — never forwarded or adopted',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const attempts=['has space','has\ttab','x'.repeat(257)];
 for(const bad of attempts) {
  const res=await f.app.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':bad},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{}})}));
  expect(res.status).toBe(400);
  expect(res.headers.get('content-type')).toContain('application/json');
  expect((await res.json()) as any).toMatchObject({jsonrpc:'2.0',error:{message:expect.any(String)}});
 }
 // the exact boundary (256) is still accepted as well-formed (rejected later for other reasons, never for shape)
 const boundary=await f.app.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':'x'.repeat(256)},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{}})}));
 expect(boundary.status).not.toBe(400);
});

test('DELETE for an unknown/stale Mcp-Session-Id is a pass-through, never triggers adoption (no pointless adopt-then-delete)',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const client1=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport1=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client1.connect(transport1 as Parameters<Client["connect"]>[0]);
 const staleSessionId=transport1.sessionId!;

 const registry2=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{});
 cleanup.push(()=>registry2.close());
 const app2=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry2.handle(request,params.agent,params.name));
 await registry2.prepare(f.spec);

 const origFetch=globalThis.fetch;let initializeCalls=0;
 globalThis.fetch=(async(input:any,init?:any)=>{
  if(init?.method==='POST'&&!new Headers(init?.headers??{}).has('mcp-session-id')&&typeof init?.body==='string'&&init.body.includes('"method":"initialize"'))initializeCalls++;
  return origFetch(input,init);
 }) as typeof fetch;
 try {
  const res=await app2.handle(new Request(server.url,{method:'DELETE',headers:{...server.headers!,'mcp-session-id':staleSessionId}}));
  expect(res.status).not.toBe(200); // nothing was adopted, so there's nothing to successfully delete either
  expect(initializeCalls).toBe(0); // never adopted a session just to serve a DELETE for it
 } finally { globalThis.fetch=origFetch; }
 await client1.close().catch(()=>{});
});

test('a successful DELETE drops the client-to-proxy session binding — clientToProxy does not grow forever',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const client1=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport1=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client1.connect(transport1 as Parameters<Client["connect"]>[0]);
 const staleSessionId=transport1.sessionId!;

 const registry2=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{});
 cleanup.push(()=>registry2.close());
 const app2=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry2.handle(request,params.agent,params.name));
 await registry2.prepare(f.spec);

 // Adopt the stale id via an ordinary tools/call first.
 await app2.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':staleSessionId},
  body:JSON.stringify({jsonrpc:'2.0',id:'x',method:'tools/call',params:{name:'identity',arguments:{}}})}));
 const bindings=((registry2 as unknown) as {connections:Map<string,{sessions:{clientToProxy:Map<string,string>}}>}).connections.get(f.spec.key+'/chat')!.sessions.clientToProxy;
 expect(bindings.has(staleSessionId)).toBe(true);

 const del=await app2.handle(new Request(server.url,{method:'DELETE',headers:{...server.headers!,'mcp-session-id':staleSessionId}}));
 expect(del.status).toBe(200);
 expect(bindings.has(staleSessionId)).toBe(false);
 await client1.close().catch(()=>{});
});

test('FACTORY-697 pre-review #4: clientToProxy is capped — the connection abandoned without a DELETE (the realistic restart case) still cannot grow the map without bound',async()=>{
 // A real restart leaves no DELETE behind (see the regression test's own comment to that effect), so DELETE
 // pruning alone cannot bound this map — exercises `bindSession`'s own eviction, oldest-first.
 const f=await fixture();await f.registry.prepare(f.spec);
 type SessionsShape={clientToProxy:Map<string,string>;pending:Map<string,Promise<string>>};
 const sessions=((f.registry as unknown) as {connections:Map<string,{sessions:SessionsShape}>}).connections.get(f.spec.key+'/chat')!.sessions;
 const bindSession=(f.registry as unknown as {bindSession(sessions:SessionsShape,clientSessionId:string,proxySessionId:string):void}).bindSession.bind(f.registry);
 const MAX_BOUND_SESSIONS=10_000; // kept in sync with the private constant in resource-connections.ts
 for(let i=0;i<MAX_BOUND_SESSIONS;i++)bindSession(sessions,`client-${i}`,`proxy-${i}`);
 expect(sessions.clientToProxy.size).toBe(MAX_BOUND_SESSIONS);
 expect(sessions.clientToProxy.has('client-0')).toBe(true); // not yet evicted, still at the cap

 bindSession(sessions,'client-one-more','proxy-one-more'); // pushes past the cap — no DELETE involved
 expect(sessions.clientToProxy.size).toBe(MAX_BOUND_SESSIONS); // never exceeds the cap
 expect(sessions.clientToProxy.has('client-0')).toBe(false); // oldest entry evicted
 expect(sessions.clientToProxy.has('client-one-more')).toBe(true); // newest entry retained
});

test('concurrent requests for the same unknown/stale Mcp-Session-Id single-flight the gateway-initiated initialize — exactly one, not one per request',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const client1=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport1=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client1.connect(transport1 as Parameters<Client["connect"]>[0]);
 const staleSessionId=transport1.sessionId!;

 const registry2=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{});
 cleanup.push(()=>registry2.close());
 const app2=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry2.handle(request,params.agent,params.name));
 await registry2.prepare(f.spec);

 const origFetch=globalThis.fetch;let initializeCalls=0;
 globalThis.fetch=(async(input:any,init?:any)=>{
  if(init?.method==='POST'&&!new Headers(init?.headers??{}).has('mcp-session-id')&&typeof init?.body==='string'&&init.body.includes('"method":"initialize"'))initializeCalls++;
  return origFetch(input,init);
 }) as typeof fetch;
 try {
  const makeReq=(id:number)=>new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':staleSessionId},
   body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'identity',arguments:{}}})});
  const results=await Promise.all([app2.handle(makeReq(1)),app2.handle(makeReq(2)),app2.handle(makeReq(3))]);
  for(const r of results)expect(r.status).toBe(200);
  expect(initializeCalls).toBe(1); // three racing requests, one adoption
 } finally { globalThis.fetch=origFetch; }
 await client1.close().catch(()=>{});
});

test('single-flight hole (FACTORY-697 pre-review #3): the clientToProxy binding is recorded BEFORE pending is cleared, so no request can see both empty',async()=>{
 // What would make this fail: on the pre-fix code, `.finally(() => pending.delete(...))` ran on the INNER
 // initialize promise, settling (and thus clearing `pending`) strictly before the outer `await promise`
 // resumed to run `clientToProxy.set(...)` on the next line — so a request arriving in that window would see
 // `pending` empty AND `clientToProxy` unset, and start a second `initialize`. Confirmed by temporarily
 // reverting adoptSession to that shape and observing `bindingPresentAtDeleteTime` come back false below.
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const client1=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport1=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client1.connect(transport1 as Parameters<Client["connect"]>[0]);
 const staleSessionId=transport1.sessionId!;

 const registry2=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{});
 cleanup.push(()=>registry2.close());
 const app2=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry2.handle(request,params.agent,params.name));
 await registry2.prepare(f.spec);

 const conn=((registry2 as unknown) as {connections:Map<string,{sessions:{pending:Map<string,Promise<string>>;clientToProxy:Map<string,string>}}>}).connections.get(f.spec.key+'/chat')!;
 const originalDelete=conn.sessions.pending.delete.bind(conn.sessions.pending);
 let bindingPresentAtDeleteTime:boolean|undefined;
 conn.sessions.pending.delete=(key:string)=>{
  bindingPresentAtDeleteTime=conn.sessions.clientToProxy.has(key); // snapshot the invariant at the exact instant pending is cleared
  return originalDelete(key);
 };

 const res=await app2.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':staleSessionId},
  body:JSON.stringify({jsonrpc:'2.0',id:'r1',method:'tools/call',params:{name:'identity',arguments:{}}})}));
 expect(res.status).toBe(200);
 expect(bindingPresentAtDeleteTime).toBe(true); // the binding must already exist the instant `pending` is cleared — never a window with both empty

 await client1.close().catch(()=>{});
});

test('FACTORY-697 pre-review #1: a FAILING adoption (gateway-initiated initialize itself fails) is 503 + Retry-After, not a terminal 502 — mirrors the FACTORY-691 idiom',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 // A fake proxy: 404 "Unknown session" for any request carrying a session id (so forward() attempts adoption),
 // but 500 for the adoption's own gateway-initiated `initialize` (no session id yet) — simulating a transient
 // failure DURING recovery itself, distinct from "upstream is down" (which the proxy would instead answer with
 // its own non-404 and `forward()` passes through without attempting adoption at all).
 const fakeServer=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
  return request.headers.has('mcp-session-id')
   ? new Response('Unknown session',{status:404})
   : new Response('Internal error',{status:500});
 }});
 cleanup.push(async()=>{await fakeServer.stop(true);});
 const conn=((f.registry as unknown) as {connections:Map<string,{proxy:{url:string;headers:{Authorization:string}}}>}).connections.get(f.spec.key+'/chat')!;
 const originalProxy=conn.proxy;
 conn.proxy={url:`http://127.0.0.1:${fakeServer.port}/mcp`,headers:{Authorization:'Bearer fake-secret'}};
 try {
  const res=await f.app.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':'deadbeef-dead-beef-dead-beefdeadbeef'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'identity',arguments:{}}})}));
  // What would make this fail: the pre-fix code returns 502 here (jsonError(502,...)), which is exactly what
  // this test guards against — a transient recovery failure must never look terminal to the client.
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('2');
  expect(res.headers.get('content-type')).toContain('application/json');
  expect((await res.json() as any).error.message).toContain('Upstream session recovery failed');
 } finally { conn.proxy=originalProxy; }
});

test('upstream genuinely down is passed straight through (JSON-ified), never adopted or masked as a session problem',async()=>{
 const f=await fixture();const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 // Swap the connection's real proxy for a stub that always answers like startMcpChannelProxy does when
 // `keepChannelSource` has no upstream client yet — a genuinely-down upstream, never a 404.
 const fakeServer=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response('MCP upstream disconnected',{status:503});}});
 cleanup.push(async()=>{await fakeServer.stop(true);});
 const conn=((f.registry as unknown) as {connections:Map<string,{proxy:{url:string;headers:{Authorization:string}}}>}).connections.get(f.spec.key+'/chat')!;
 const originalProxy=conn.proxy;
 conn.proxy={url:`http://127.0.0.1:${fakeServer.port}/mcp`,headers:{Authorization:'Bearer fake-secret'}};
 const origFetch=globalThis.fetch;let initializeCalls=0;
 globalThis.fetch=(async(input:any,init?:any)=>{
  if(init?.method==='POST'&&!new Headers(init?.headers??{}).has('mcp-session-id')&&typeof init?.body==='string'&&init.body.includes('"method":"initialize"'))initializeCalls++;
  return origFetch(input,init);
 }) as typeof fetch;
 try {
  const res=await f.app.handle(new Request(server.url,{method:'POST',headers:{...server.headers!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':'deadbeef-dead-beef-dead-beefdeadbeef'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'identity',arguments:{}}})}));
  expect(res.status).toBe(503); // passed straight through — NOT reinterpreted as an unknown-session 404
  expect(res.headers.get('content-type')).toContain('application/json');
  expect((await res.json() as any).error.message).toContain('MCP upstream disconnected');
  expect(initializeCalls).toBe(0); // never attempted adoption for a down upstream
 } finally { globalThis.fetch=origFetch; conn.proxy=originalProxy; }
});

/**
 * Models the real `claude` CLI v2.1.251's measured reconnect algorithm
 * (FACTORY-700): one initial POST, then up to `backoffsMs.length` retries
 * spaced by `backoffsMs`, each firing ONLY after the previous attempt's
 * response completed (the client's retry timer starts on a completed
 * failure, never while a request is still in flight) — and, critically,
 * NOTHING further once the backoffs are exhausted. Returns every attempt's
 * response so a test can assert exactly which one (if any) succeeded.
 */
async function simulateReconnectingClient(attempt:()=>Promise<Response>,backoffsMs:readonly number[]):Promise<Response[]> {
 const responses:Response[]=[];
 for(let i=0;;i++) {
  const res=await attempt();responses.push(res);
  if(res.ok||i>=backoffsMs.length)return responses;
  await Bun.sleep(backoffsMs[i]!);
 }
}

test('FACTORY-702: a client modelled on the real ~8s retry budget (initial POST + 3 retries at 1s/2s/4s, THEN NOTHING MORE) still reaches a working connection when prepare() takes longer than that whole budget',async()=>{
 const f=await fixture();
 // Scaled down ~20x from FACTORY-700's real measurements so this test runs in well under a second while preserving the one ratio that matters: prepare() takes LONGER than the client's entire retry budget.
 //   real:  client's budget is spent in ~7.8s (instant initial POST + retries at 1s/2s/4s); prepare() can legitimately take up to 20s per server.
 //   here:  client's budget is spent in <70ms (backoffs of 10/20/40ms after an instant initial attempt); the single upstream's `initialize` is deliberately delayed 250ms — more than THREE TIMES the client's whole budget.
 await writeFile(f.script,`const rl=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}}}),250);
 else if(m.method==='notifications/initialized'){}
 else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'identity',description:'identity',inputSchema:{type:'object'}}]}});
 });`);
 const token=await persistToken(f.spec.key,'chat');
 // requestHoldMs generous relative to the 250ms prepare() delay, modelling FACTORY-702's real default (20s per-server timeout + 5s margin) scaled down by the same ~20x.
 const registry=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{},Date.now,5*60_000,1500);
 cleanup.push(()=>registry.close());
 const app=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry.handle(request,params.agent,params.name));
 const prepared=registry.prepare(f.spec); // the reconcile loop is already running concurrently with the client's reconnect attempts below — exactly like a real restart, NOT awaited here.

 const attempt=()=>app.handle(new Request(urlFor(f.spec.key,'chat'),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'test-client',version:'1'}}})}));

 const start=Date.now();
 const responses=await simulateReconnectingClient(attempt,[10,20,40]); // client's real backoff shape, scaled down; 4 attempts max, then the client would send nothing further.
 const elapsed=Date.now()-start;

 expect(responses).toHaveLength(1); // the client's FIRST attempt already succeeds — held open by the gateway rather than failing fast — so its own retry loop above never even has to fire a 2nd attempt.
 expect(responses[0]!.ok).toBe(true);
 expect(elapsed).toBeGreaterThanOrEqual(200); // genuinely held until prepare() finished (~250ms) — not answered with an instant 503 that the 70ms-budgeted retries above would then have exhausted and gone silent on, exactly as FACTORY-700 measured the real client doing.
 await prepared;
});

test('FACTORY-702: prepare() runs an agent\'s multiple MCP servers CONCURRENTLY, not serially — worst case is the slowest ONE server, not their sum',async()=>{
 const f=await fixture();
 const delays=[400,400,400]; // if serial, this agent's prepare() would take >=1200ms; if concurrent, ~400ms (plus process-spawn overhead, shared across all three either way).
 await writeFile(f.file,JSON.stringify({mcpServers:Object.fromEntries(delays.map((ms,i)=>[`srv${i}`,{command:process.execPath,args:['-e',
  `const rl=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');`+
  `rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);`+
  `if(m.method==='initialize')setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}}}),${ms});`+
  `});`]}]))}));
 const start=Date.now();
 const spec=await f.registry.prepare(f.spec);
 const elapsed=Date.now()-start;
 expect(spec.externalMcpServers).toHaveLength(3);
 expect(spec.externalMcpServers!.map(s=>s.name).sort()).toEqual(['resource_srv0','resource_srv1','resource_srv2']);
 expect(elapsed).toBeLessThan(1000); // well under the serial sum (>=1200ms) — proves the three servers were prepared concurrently, not one after another.
});

test('integration: a daemon restart (new ResourceConnections, same workspace dir) answers 503 — never 401 — until prepare() runs again, then 200',async()=>{
 const f=await fixture();
 const spec=await f.registry.prepare(f.spec);const server=spec.externalMcpServers![0]!;
 const client1=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport1=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>f.app.handle(new Request(input.toString(),init))});
 await client1.connect(transport1 as Parameters<Client["connect"]>[0]);
 expect((await client1.listTools()).tools[0]!.name).toBe('identity'); // 200: the pre-restart session works
 await client1.close();

 // "daemon restart": a BRAND NEW ResourceConnections on the SAME workspace dir — empty in-memory registry, token file still on disk.
 const registry2=new ResourceConnections('http://local',{paneFor:async()=> 'pane',nudge:async()=>({delivered:true})},()=>{});
 cleanup.push(()=>registry2.close());
 const app2=new Elysia().all('/resource-mcp/:agent/:name',({request,params})=>registry2.handle(request,params.agent,params.name));

 const beforePrepare=await app2.handle(new Request(server.url,{headers:server.headers!}));
 expect(beforePrepare.status).toBe(503);
 expect(beforePrepare.headers.get('retry-after')).toBe('2');

 await registry2.prepare(f.spec); // the reconciler's next round catches up

 const client2=new Client({name:'test',version:'1'},{capabilities:{}});
 const transport2=new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers!},fetch:async(input,init)=>app2.handle(new Request(input.toString(),init))});
 await client2.connect(transport2 as Parameters<Client["connect"]>[0]);cleanup.push(()=>client2.close());
 expect((await client2.listTools()).tools[0]!.name).toBe('identity'); // 200 again, post-reconcile
});
