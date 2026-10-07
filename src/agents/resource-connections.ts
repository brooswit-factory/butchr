import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
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
/**
 * Per-connection MCP session-id continuity (FACTORY-696/697/698): the
 * client's `Mcp-Session-Id` is the durable name; the proxy's is a fresh,
 * process-local implementation detail that goes empty on every restart.
 * `clientToProxy` remembers a binding once established so later requests
 * for the same client id skip straight to it. `pending` single-flights the
 * adoption itself — concurrent requests racing to adopt the SAME unknown
 * client id must trigger exactly one gateway-initiated `initialize`, never
 * one per request.
 */
interface SessionBindings { clientToProxy: Map<string,string>; pending: Map<string,Promise<string>>; }
interface Connection { proxy: Proxy; token: string; relay: InboxRelay; agent: string; sessions: SessionBindings; }

/** A JSON-RPC-shaped error body for every non-2xx this endpoint returns on a JSON-RPC path — EXCEPT the FACTORY-691 401, which stays byte-identical. */
function jsonError(status:number, message:string, extraHeaders?:Record<string,string>):Response {
  return new Response(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message},id:null}),{status,headers:{'content-type':'application/json',...extraHeaders}});
}

/** The vendored proxy answers some errors as bare plain text (`"Unknown session"`, `"Initialize required"`) — wrap anything that slips through unconverted so a JSON-parsing client never fails on top of the status. 2xx/3xx passes through untouched. */
async function jsonifyPlainTextError(response:Response):Promise<Response> {
  if(response.status<400) return response;
  if((response.headers.get('content-type')??'').includes('application/json')) return response;
  const text=await response.text();
  const headers=new Headers(response.headers);headers.set('content-type','application/json');headers.delete('content-length');
  return new Response(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message:text||response.statusText||'Error'},id:null}),{status:response.status,headers});
}

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
   *
   * NOT sufficient on its own (PR #658 review, round 1): an agent that was
   * retired BEFORE the restart — token file still on disk, but no longer
   * matched by any rule — never gets `prepare()`d again in the NEW
   * instance, so it would never enter this set and would 503 forever,
   * exactly the "retry forever for a connection that is never coming back"
   * case the story's CRITICAL section forbids. `startupDeadlineMs` below
   * is the global backstop that bounds that: once it has elapsed since
   * construction, EVERY agent is treated as ready regardless of whether
   * its own `prepare()` ever ran, so case (b) can only ever apply for a
   * bounded window after a restart, never indefinitely.
   */
  private readyAgents = new Set<string>();
  private readonly startedAt: number;
  constructor(
    private readonly baseUrl:string,
    private readonly herd:Pick<Herd,'paneFor'|'nudge'>,
    private readonly log:(line:string)=>void,
    /** Injectable for tests; defaults to the real clock. */
    private readonly now:()=>number = Date.now,
    /**
     * Global readiness backstop (see `readyAgents`'s own doc comment): a
     * few multiples of the resource-reconcile loop's own 60s poll interval
     * (`src/daemon/index.ts`'s `intervalMs: 60_000` wiring `prepare` in),
     * since a round that is already in flight when this instance is
     * constructed may not reach a given agent until the NEXT poll tick,
     * not the one already running.
     */
    private readonly startupDeadlineMs:number = 5*60_000,
  ) { this.startedAt = this.now(); }
  /** Whether `agent` should be treated as past the 503 window — its own `prepare()` completed, or the global startup backstop has elapsed. */
  private isReady(agent:string):boolean {
    return this.readyAgents.has(agent) || this.now()-this.startedAt >= this.startupDeadlineMs;
  }
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
        this.connections.set(key,{proxy,token,relay,agent:spec.key,sessions:{clientToProxy:new Map(),pending:new Map()}});created.push(key);
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
      return this.forward(c,request);
    }
    if(!this.isReady(agent)) {
      const token=await this.persistedToken(agent,name);
      if(token!==null&&constantTimeEqual(request.headers.get('authorization'),`Bearer ${token}`)) {
        return new Response(JSON.stringify({error:'butchr is starting; connection not ready, retry'}),{status:503,headers:{'Retry-After':'2','content-type':'application/json'}});
      }
    }
    return UNAUTHORIZED();
  }
  /**
   * Forwards an authenticated request to `c.proxy`, bridging the client's
   * durable `Mcp-Session-Id` across the proxy's process-local one
   * (FACTORY-696/697/698).
   *
   * - No session id and `GET`: the SDK client's SSE probe. The vendored
   *   proxy would answer `400 "Initialize required"` (same branch it uses
   *   for every session-less non-POST method) — but `405` is the ONLY
   *   non-2xx the spec sanctions here, and it's the one status the SDK
   *   client special-cases as "no SSE, carry on" rather than a fatal
   *   `StreamableHTTPError`. Answered here, before ever reaching the
   *   proxy — there is nothing upstream to do for it.
   * - A session id the proxy doesn't recognize: a GENUINE restart (this
   *   `Connection`'s proxy is a fresh generation with an empty session
   *   map) looks identical, from here, to a session that merely expired
   *   on a proxy that never restarted — both are a `404` on first use of
   *   that id. Either way the fix is the same: adopt the id by running a
   *   gateway-initiated `initialize` (+ `notifications/initialized`)
   *   against the CURRENT proxy, bind the client's id to the proxy's new
   *   one, and retry the original request through that binding. The
   *   proxy's own local `Server` answers `initialize` from the
   *   capabilities/serverInfo it already cached from the real upstream
   *   connection when first established — it does not re-contact the
   *   upstream — so this is cheap and side-effect-free to repeat on every
   *   restart, and safe to retry on a stale-but-not-yet-restarted session
   *   too (the proxy would simply have recognized the old id and this
   *   branch is never taken).
   * - An upstream that is genuinely down answers its OWN non-404 (e.g. the
   *   proxy's `503 "MCP upstream disconnected"` when `keepChannelSource`
   *   hasn't got a client yet) — that is passed straight through, JSON-ified,
   *   WITHOUT attempting adoption: adoption would only repeat the same
   *   failure through an extra round trip, and conflating "upstream down"
   *   with "session expired" is exactly the failure mode this fix exists
   *   to avoid on the client's side of the proxy.
   *
   * Single-flight (`c.sessions.pending`) means two requests racing to
   * adopt the same unknown client id share one `initialize` call rather
   * than each minting their own proxy session (which would silently
   * orphan one of them).
   *
   * Tool-list currency: the gateway-initiated `initialize` only
   * re-establishes a LOCAL session with the already-running proxy; it
   * does not re-query the real upstream server, so if that server's own
   * tool list changed across the restart, a client that cached
   * `tools/list` from before keeps seeing the stale list until it calls
   * `tools/list` again on its own. Accepted: the alternative (push a
   * `notifications/tools/list_changed` on every adoption) would fire on
   * ordinary restarts where nothing changed, and MCP clients already
   * treat their tool cache as advisory between explicit refreshes.
   */
  private async forward(c:Connection,request:Request):Promise<Response> {
    const clientSessionId=request.headers.get('mcp-session-id');
    if(clientSessionId===null&&request.method==='GET') {
      return jsonError(405,'Method not allowed: GET requires an active session (initialize first).',{Allow:'GET, POST, DELETE'});
    }
    const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
    const send=async(proxySessionId:string|null):Promise<Response> => {
      const headers=new Headers(request.headers);headers.delete('host');headers.set('authorization',c.proxy.headers.Authorization);
      if(proxySessionId!==null)headers.set('mcp-session-id',proxySessionId);
      return fetch(c.proxy.url,{method:request.method,headers,...(body!==undefined?{body}:{}),signal:request.signal});
    };
    let proxySessionId=clientSessionId!==null?(c.sessions.clientToProxy.get(clientSessionId)??clientSessionId):null;
    let response=await send(proxySessionId);
    if(clientSessionId!==null&&response.status===404) {
      let adopted:string;
      try { adopted=await this.adoptSession(c,clientSessionId,request); }
      catch(e) { return jsonError(502,`Upstream session recovery failed: ${e instanceof Error?e.message:String(e)}`); }
      proxySessionId=adopted;
      response=await send(proxySessionId);
    }
    return this.rewriteSessionHeader(await jsonifyPlainTextError(response),clientSessionId,proxySessionId);
  }
  /** Rewrites a proxy-minted `Mcp-Session-Id` response header back to the client's own id, so the client never learns the proxy's id exists. */
  private rewriteSessionHeader(response:Response,clientSessionId:string|null,proxySessionId:string|null):Response {
    if(clientSessionId===null||proxySessionId===null||clientSessionId===proxySessionId)return response;
    if(response.headers.get('mcp-session-id')!==proxySessionId)return response;
    const headers=new Headers(response.headers);headers.set('mcp-session-id',clientSessionId);
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
  /** Single-flights adoption of `clientSessionId` against `c.proxy`, returning the newly-bound proxy session id. */
  private async adoptSession(c:Connection,clientSessionId:string,request:Request):Promise<string> {
    const existing=c.sessions.pending.get(clientSessionId);
    if(existing)return existing;
    const promise=this.initializeProxySession(c,request).finally(()=>{c.sessions.pending.delete(clientSessionId);});
    c.sessions.pending.set(clientSessionId,promise);
    const proxySessionId=await promise;
    c.sessions.clientToProxy.set(clientSessionId,proxySessionId);
    return proxySessionId;
  }
  /**
   * Runs a gateway-initiated `initialize` + `notifications/initialized`
   * against `c.proxy` and returns the proxy-minted session id. Protocol
   * version comes from the client's own `MCP-Protocol-Version` header
   * (the spec-honest source for a non-initialize request) falling back to
   * the SDK's latest when absent (e.g. the very first adoption of a
   * session whose original `initialize` predates this gateway and never
   * carried the header this far). Capabilities are sent empty: this
   * handshake is local to the proxy's already-connected upstream and
   * negotiates nothing the gateway itself will ever call.
   */
  private async initializeProxySession(c:Connection,request:Request):Promise<string> {
    const protocolVersion=request.headers.get('mcp-protocol-version')??LATEST_PROTOCOL_VERSION;
    const initRes=await fetch(c.proxy.url,{method:'POST',headers:{authorization:c.proxy.headers.Authorization,accept:'application/json, text/event-stream','content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion,capabilities:{},clientInfo:{name:'butchr-resource-gateway',version:'1'}}})});
    const proxySessionId=initRes.headers.get('mcp-session-id');
    await initRes.text().catch(()=>{}); // drain the SSE stream so the proxy's per-request transport closes
    if(!initRes.ok||!proxySessionId)throw new Error(`gateway-initiated initialize failed: ${initRes.status}`);
    const initializedRes=await fetch(c.proxy.url,{method:'POST',headers:{authorization:c.proxy.headers.Authorization,accept:'application/json, text/event-stream','content-type':'application/json','mcp-session-id':proxySessionId},
      body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    await initializedRes.text().catch(()=>{});
    return proxySessionId;
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
