import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Elysia} from 'elysia';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ResourceConnections} from '../../src/agents/resource-connections.js';
import type {SpawnSpec} from '../../src/agents/workspace.js';
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
