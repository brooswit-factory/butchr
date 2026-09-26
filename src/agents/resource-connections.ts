import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InboxRelay, startMcpChannelProxy, mcpServersFromMcpJson, CHANNEL_NOTIFICATION,
  inboxMessageFromNotification, type ChannelSourceOptions } from '@brooswit/drovr-events';
import { workspaceDirFor, resourceOfSpec, type SpawnSpec } from './workspace.js';
import type { Herd } from './herd.js';

type Proxy = Awaited<ReturnType<typeof startMcpChannelProxy>>;
interface Connection { proxy: Proxy; token: string; relay: InboxRelay; agent: string; }

/** Operator-supplied MCP connections; the same upstream session serves tools and events. */
export class ResourceConnections {
  private connections = new Map<string, Connection>();
  private prepared = new Map<string, {file:string; servers:NonNullable<SpawnSpec['externalMcpServers']>}>();
  constructor(private readonly baseUrl:string, private readonly herd:Pick<Herd,'paneFor'|'nudge'>, private readonly log:(line:string)=>void) {}
  async prepare(spec:SpawnSpec):Promise<SpawnSpec> {
    if (!spec.mcpConfigFile) return spec;
    const file=spec.mcpConfigFile.replaceAll('{{KEY}}',resourceOfSpec(spec));
    const prior=this.prepared.get(spec.key);
    if (prior) {
      if (prior.file!==file) throw new Error('MCP connection configuration changed; restart butchr to reload');
      return {...spec,externalMcpServers:prior.servers};
    }
    const raw=JSON.parse(await readFile(file,'utf8'));
    const definitions=mcpServersFromMcpJson(raw);
    if (!raw.mcpServers || !Object.keys(definitions).length) throw new Error(`No MCP servers in ${file}`);
    const dir=workspaceDirFor(spec.key);await mkdir(dir,{recursive:true});
    const servers:NonNullable<SpawnSpec['externalMcpServers']>=[];
    const created:string[]=[];
    try {
      for(const [name,definition] of Object.entries(definitions)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name) || name==='butchr') throw new Error('Invalid/reserved external MCP server name');
        const key=spec.key+'/'+name;
        const tokenFile=join(dir,`.butchr-mcp-${name}.token`);
        let token:string;
        try { token=(await readFile(tokenFile,'utf8')).trim(); }
        catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;token=randomBytes(32).toString('hex');await writeFile(tokenFile,token,{mode:0o600,flag:'wx'});}
        if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid external MCP proxy token');
        const relay=new InboxRelay({batchMs:100,retryMs:100,deliver:async text=>{
          if(!await this.herd.paneFor(spec.key))return {status:'busy'};
          try {
            const r=await this.herd.nudge(spec.key,text);
            return r.delivered&&!r.refusal ? {status:'delivered'} : {status:'uncertain',detail:'Prompt delivery not confirmed'};
          } catch(e) {return {status:'uncertain',detail:String(e)};}
        },onEvent:e=>{if(e.kind!=='retrying'||('outcome' in e && e.outcome?.status==='uncertain'))this.log(`[connections] ${spec.key}/${name}: ${e.kind}`);}});
        const source=definition.type==='http' ? {url:definition.url,...(definition.headers?{headers:definition.headers}:{})}
          : {url:'http://stdio.invalid',connect:stdioConnector(definition,dir)};
        const proxy=await startMcpChannelProxy({name,...source,onMessage:m=>{if(raw.mcpServers[name].notifications!==false)relay.push(m);},onStatus:s=>this.log(`[connections] ${spec.key}/${name}: ${s.kind}`)});
        this.connections.set(key,{proxy,token,relay,agent:spec.key});created.push(key);
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([proxy.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('External MCP connection timeout')),20000);})]);}finally{clearTimeout(timer);}
        servers.push({name:`resource_${name}`,url:`${this.baseUrl}/resource-mcp/${encodeURIComponent(spec.key)}/${name}`,headers:{Authorization:`Bearer ${token}`}});
      }
      this.prepared.set(spec.key,{file,servers});return {...spec,externalMcpServers:servers};
    } catch(e) {for(const key of created)await this.closeConnection(key);throw e;}
  }
  /** Stable local endpoint survives daemon restarts; tokens never reach the upstream service. */
  async handle(request:Request,agent:string,name:string):Promise<Response> {
    const c=this.connections.get(agent+'/'+name);
    if(!c||request.headers.get('authorization')!==`Bearer ${c.token}`)return new Response('Unauthorized',{status:401});
    const headers=new Headers(request.headers);headers.delete('host');headers.set('authorization',c.proxy.headers.Authorization);
    return fetch(c.proxy.url,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:await request.arrayBuffer()}:{}),signal:request.signal});
  }
  private async closeConnection(key:string) {const c=this.connections.get(key);this.connections.delete(key);if(c){c.relay.stop();await c.proxy.close();}}
  async retain(ids:ReadonlySet<string>) {for(const [key,c] of this.connections)if(!ids.has(c.agent))await this.closeConnection(key);for(const id of this.prepared.keys())if(!ids.has(id))this.prepared.delete(id);}
  async close() {await this.retain(new Set());}
}

export function stdioConnector(definition:{command:string;args?:readonly string[];env?:Readonly<Record<string,string>>},cwd:string) {
  return async(options:ChannelSourceOptions)=>{
    const client=new Client({name:`butchr-resource-${options.name}`,version:'1'},{capabilities:{}});
    client.fallbackNotificationHandler=async n=>{if(n.method===CHANNEL_NOTIFICATION){const m=inboxMessageFromNotification(options.name,n.params);if(m)options.onMessage(m);}};
    client.onclose=()=>options.onClose?.();client.onerror=e=>options.onError?.(e);
    const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));
    const transport=new StdioClientTransport({command:definition.command,args:[...(definition.args??[])],env:{...env,...definition.env},cwd,stderr:'inherit'});
    try {await client.connect(transport);}catch(e){await client.close().catch(()=>{});throw e;}
    options.onClient?.(client);
    return {close:async()=>{options.onClient?.(undefined);await client.close();}};
  };
}
