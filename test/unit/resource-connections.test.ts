import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {Elysia} from 'elysia';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
