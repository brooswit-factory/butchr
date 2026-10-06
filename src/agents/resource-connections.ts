import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InboxRelay, startMcpChannelProxy, mcpServersFromMcpJson, CHANNEL_NOTIFICATION,
  inboxMessageFromNotification, type ChannelSourceOptions } from '@brooswit/drovr-events';
import { ensureWorkspaceDir, resourceOfSpec, workspaceDirFor, type SpawnSpec } from './workspace.js';
import { decodeAnyAgentKey } from '../rules/agent-key.js';
import type { Herd } from './herd.js';

/** Byte-length-safe `===`: equal-length buffers compared via `timingSafeEqual`, never a plain string `!==` (BUTCHR/FACTORY-689/691). */
function constantTimeEqual(a: string | null | undefined, b: string): boolean {
  if (a == null) return false;
  const bufA = Buffer.from(a), bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Identical for EVERY case-(c) sub-case — wrong/missing bearer, unknown agent, unknown name, no token file, or a ready gateway's absent connection — so none of them can be told apart by status, headers, or body. */
const UNAUTHORIZED = () => new Response('Unauthorized', { status: 401 });

type Proxy = Awaited<ReturnType<typeof startMcpChannelProxy>>;
interface Connection { proxy: Proxy; token: string; relay: InboxRelay; agent: string; }

/** Operator-supplied MCP connections; the same upstream session serves tools and events. */
export class ResourceConnections {
  private connections = new Map<string, Connection>();
  private prepared = new Map<string, {file:string; servers:NonNullable<SpawnSpec['externalMcpServers']>}>();
  /**
   * Agents whose FIRST `prepare()` round has completed (success or failure),
   * for exactly ONE `ResourceConnections` instance's lifetime — never
   * cleared by `retain()`, unlike `prepared` above, so a legitimately
   * retired agent (closed via `retain()`, token file left on disk) stays
   * `ready` and `handle()` keeps answering it 401, not 503 forever
   * (FACTORY-688/689/691 — the `retain(new Set())` -> 401 assertion this
   * must never break). A brand-new instance (a daemon restart) starts with
   * this empty, which is the whole 503-during-startup window `handle()`
   * gates on below.
   */
  private readyAgents = new Set<string>();
  constructor(private readonly baseUrl:string, private readonly herd:Pick<Herd,'paneFor'|'nudge'>, private readonly log:(line:string)=>void) {}
  async prepare(spec:SpawnSpec):Promise<SpawnSpec> {
    if (!spec.mcpConfigFile) { this.readyAgents.add(spec.key); return spec; }
    try {
      return await this.prepareExternal(spec);
    } finally {
      this.readyAgents.add(spec.key);
    }
  }
  private async prepareExternal(spec:SpawnSpec):Promise<SpawnSpec> {
    const file=spec.mcpConfigFile!.replaceAll('{{KEY}}',resourceOfSpec(spec));
    const prior=this.prepared.get(spec.key);
    if (prior) {
      if (prior.file!==file) throw new Error('MCP connection configuration changed; restart butchr to reload');
      return {...spec,externalMcpServers:prior.servers};
    }
    const raw=JSON.parse(await readFile(file,'utf8'));
    const definitions=mcpServersFromMcpJson(raw);
    if (!raw.mcpServers || !Object.keys(definitions).length) throw new Error(`No MCP servers in ${file}`);
    // FACTORY-118: `ensureWorkspaceDir`, not a bare `workspaceDirFor` + our
    // own `mkdir` — `prepare()` runs BEFORE `HerdrHerd.spawn()`'s own
    // `buildWorkspace()` call (see jira-project-type.ts's `deps.prepare`
    // wiring, which augments `m.spec` ahead of the actual spawn), so this is
    // the FIRST claim of this key's directory for a brand-new agent. A bare
    // `workspaceDirFor` here would compute a fresh short-name directory,
    // create it unstamped, and then `buildWorkspace()`'s own later
    // `ensureWorkspaceDir()` call would see that name already occupied
    // (by this very directory, just unstamped) and hand back the DIFFERENT
    // collision-suffixed name instead — stranding the `.butchr-mcp-*.token`
    // files this function writes below in a directory the agent's own
    // workspace never ends up at. See `ensureWorkspaceDir`'s own doc comment
    // (src/agents/workspace.ts) for why centralizing the claim here is what
    // keeps every caller agreeing on one directory for one key.
    const dir=ensureWorkspaceDir(spec.key);
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
  /**
   * Stable local endpoint survives daemon restarts; tokens never reach the
   * upstream service. Three outcomes (FACTORY-688/689/691):
   *  (a) bearer valid for a connection IN the registry -> forward, exactly as before.
   *  (b) absent from the registry, this agent's first `prepare()` round has
   *      NOT yet completed, and the bearer matches the token PERSISTED for
   *      this agent/name -> 503 + `Retry-After`, telling a client reconnecting
   *      right after a restart to retry rather than treating this as a bad
   *      credential.
   *  (c) anything else — wrong/missing bearer, unknown agent, unknown name,
   *      no token file, or a READY gateway's absent connection (e.g. a
   *      retired agent — `retain()` closes the connection but leaves the
   *      token file) -> 401, byte-identical to today, revealing nothing
   *      about whether `agent`/`name` exist.
   */
  async handle(request:Request,agent:string,name:string):Promise<Response> {
    const c=this.connections.get(agent+'/'+name);
    if(c) {
      if(!constantTimeEqual(request.headers.get('authorization'),`Bearer ${c.token}`))return UNAUTHORIZED();
      const headers=new Headers(request.headers);headers.delete('host');headers.set('authorization',c.proxy.headers.Authorization);
      return fetch(c.proxy.url,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:await request.arrayBuffer()}:{}),signal:request.signal});
    }
    if(!this.readyAgents.has(agent)) {
      const token=await this.persistedToken(agent,name);
      if(token!==null&&constantTimeEqual(request.headers.get('authorization'),`Bearer ${token}`)) {
        return new Response(JSON.stringify({error:'butchr is starting; connection not ready, retry'}),{status:503,headers:{'Retry-After':'2','content-type':'application/json'}});
      }
    }
    return UNAUTHORIZED();
  }
  /**
   * The token persisted on disk for `agent`/`name`, or `null` for anything
   * that is not a legitimately-shaped request — including a traversal or
   * reserved-name attempt, which must be INDISTINGUISHABLE from any other
   * (c) outcome. `agent`/`name` are URL-derived and this is an
   * UNAUTHENTICATED code path (FACTORY-689/691 security note), so both are
   * validated BEFORE any path is built:
   *  - `name`: same shape `prepare()` already requires (`^[a-zA-Z0-9_-]+$`,
   *    never the reserved `butchr`).
   *  - `agent`: must decode as a real agent key (`decodeAnyAgentKey`) — the
   *    same codec `encodeAgentKey` produces every real key with, so a `..`,
   *    a path separator, an absolute path, or a NUL byte never decodes and
   *    is rejected here, before `workspaceDirFor` ever sees it.
   * Uses `workspaceDirFor`, NEVER `ensureWorkspaceDir` — this is a read on
   * an unauthenticated path and must claim/create nothing.
   */
  private async persistedToken(agent:string,name:string):Promise<string|null> {
    if(!/^[a-zA-Z0-9_-]+$/.test(name)||name==='butchr')return null;
    if(!decodeAnyAgentKey(agent))return null;
    try {
      const dir=workspaceDirFor(agent);
      const token=(await readFile(join(dir,`.butchr-mcp-${name}.token`),'utf8')).trim();
      return /^[a-f0-9]{64}$/.test(token) ? token : null;
    } catch { return null; }
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
