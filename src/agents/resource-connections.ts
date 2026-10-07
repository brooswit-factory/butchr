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
 * for the same client id skip straight to it, capped at `MAX_BOUND_SESSIONS`
 * (oldest evicted first — see `bindSession`) since a real restart leaves no
 * `DELETE` behind to prune an abandoned one. `pending` single-flights the
 * adoption itself — concurrent requests racing to adopt the SAME unknown
 * client id must trigger exactly one gateway-initiated `initialize`, never
 * one per request.
 */
interface SessionBindings { clientToProxy: Map<string,string>; pending: Map<string,Promise<string>>; }
/**
 * `ready` (FACTORY-702 review round 1): `connections.set()` registers a
 * Connection as soon as `startMcpChannelProxy()` itself returns — which
 * happens near-instantly, well BEFORE that proxy's own upstream handshake
 * (`proxy.ready`) resolves. Before this field existed, `handle()`'s
 * registry-hit branch forwarded unconditionally the moment the Connection
 * object existed, regardless of whether its upstream was actually up —
 * reaching the vendored proxy's own "MCP upstream disconnected" passthrough
 * instead of ever reaching the hold logic below, for the ENTIRE window
 * between object-registration and real upstream readiness. Flipped to
 * `true` by `prepareExternal`, in place on this exact object, once its own
 * `proxy.ready` wins the race against the per-server timeout — never
 * flipped back; a Connection that never reaches it is simply removed
 * (`closeConnection`, via the round's own failure cleanup) rather than left
 * permanently `false`.
 */
interface Connection { proxy: Proxy; token: string; relay: InboxRelay; agent: string; sessions: SessionBindings; ready: boolean; }
/** Per-connection cap on `clientToProxy`; tiny per entry, so generous. */
const MAX_BOUND_SESSIONS=10_000;

/** A JSON-RPC-shaped error body for every non-2xx this endpoint returns on a JSON-RPC path — EXCEPT the FACTORY-691 401, which stays byte-identical. */
function jsonError(status:number, message:string, extraHeaders?:Record<string,string>):Response {
  return new Response(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message},id:null}),{status,headers:{'content-type':'application/json',...extraHeaders}});
}

/**
 * A `Mcp-Session-Id` the gateway will consider adopting: visible ASCII
 * (0x21-0x7E, the HTTP header-value token range — excludes whitespace and
 * control bytes) and length-bounded. Anything else is rejected outright —
 * `forward()` never runs it through `send()`/`adoptSession()` at all, so a
 * garbage or oversized header can't reach the proxy or trigger a spurious
 * `initialize`.
 */
const SESSION_ID_RE=/^[\x21-\x7E]{1,256}$/;

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
  /**
   * Agent keys whose `prepare()` call is CURRENTLY RUNNING on this instance
   * (FACTORY-702, work item 3). Distinct from `readyAgents`: that set only
   * gains an entry once a round finishes (success or failure), so checking
   * it alone cannot tell "still actively preparing, just slow" apart from
   * "never submitted for prepare() at all" (e.g. a retired agent whose
   * token file is still on disk) — both just read as `false` to it. The
   * 503->401 cliff (FACTORY-700's regression test, "an agent whose
   * prepare() is still IN FLIGHT") happened because `isReady()`'s deadline
   * arm fired on elapsed wall-clock time ALONE, with no regard for which of
   * those two cases it actually was. Checked by `isReady()` below: while an
   * agent's own key is in this set, the deadline can never flip it to 401 —
   * only `readyAgents` (i.e. that specific round actually finishing) can.
   * An agent that is genuinely retired/unknown never enters this set at
   * all, so the deadline backstop still applies to it exactly as before.
   */
  private readonly inFlightPrepares = new Set<string>();
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
    /**
     * FACTORY-702 work item 2: bound on how long `handle()` will HOLD an
     * otherwise-503-worthy request open, waiting for this agent's own
     * `prepare()` round to finish, before falling back to the old
     * immediate 503. Real `claude` CLI v2.1.251 (FACTORY-700) burns its
     * entire reconnect budget in ~7.8s (POST + 3 retries at 1s/2s/4s) and
     * then goes silent for the rest of the 5-minute window — far short of
     * `prepareExternal`'s own up-to-20s-per-server timeout, so a bare 503
     * is never actually retried enough times to matter. Holding instead of
     * failing fast means the client's retry logic never has to engage at
     * all: its single in-flight request simply resolves once `prepare()`
     * does. Defaults to the per-server timeout (20_000, see
     * `prepareExternal`) plus a 5s margin for the proxy/stdio handshake
     * overhead that sits outside that inner timeout; this is now the
     * worst-case time-to-first-success for a reconnecting client, down
     * from ~60s (3 `resource_*` servers prepared serially, each up to 20s)
     * now that `prepareExternal` below prepares a given agent's servers
     * CONCURRENTLY rather than serially.
     */
    private readonly requestHoldMs:number = 25_000,
  ) { this.startedAt = this.now(); }
  /** Whether `agent` should be treated as past the 503 window — its own `prepare()` completed, or the global startup backstop has elapsed AND no `prepare()` for it is actually in flight right now. */
  private isReady(agent:string):boolean {
    if (this.readyAgents.has(agent)) return true;
    if (this.inFlightPrepares.has(agent)) return false;
    return this.now()-this.startedAt >= this.startupDeadlineMs;
  }
  async prepare(spec:SpawnSpec):Promise<SpawnSpec> {
    if (!spec.mcpConfigFile) { this.readyAgents.add(spec.key); return spec; }
    this.inFlightPrepares.add(spec.key);
    try {
      return await this.prepareExternal(spec);
    } finally {
      this.inFlightPrepares.delete(spec.key);
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
    const created:string[]=[];
    const entries=Object.entries(definitions);
    // Validated up front, before any connection for ANY entry starts, so an
    // invalid/reserved name in entry N can never race the side effects
    // (token files, spawned proxies) of entries that would otherwise have
    // already started concurrently below.
    for(const [name] of entries) if (!/^[a-zA-Z0-9_-]+$/.test(name) || name==='butchr') throw new Error('Invalid/reserved external MCP server name');
    try {
      // FACTORY-702 work item 2: prepared CONCURRENTLY, not serially — a
      // multi-server agent (e.g. wDK's three `resource_*` servers) used to
      // pay each server's own up-to-20s `proxy.ready` timeout back to back
      // (up to ~60s total); now the worst case for the whole agent is one
      // server's timeout, not the sum of all of them. `Promise.allSettled`
      // (not `Promise.all`) so that EVERY entry's `created.push` below has
      // actually run — and so `created` is fully populated — before the
      // catch block below decides whether/what to roll back; `Promise.all`
      // would let still-pending siblings outlive an early rejection and
      // leak their connections past this function's own cleanup.
      const outcomes=await Promise.allSettled(entries.map(async([name,definition])=>{
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
        const conn:Connection={proxy,token,relay,agent:spec.key,sessions:{clientToProxy:new Map(),pending:new Map()},ready:false};
        this.connections.set(key,conn);created.push(key);
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([proxy.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('External MCP connection timeout')),20000);})]);}finally{clearTimeout(timer);}
        conn.ready=true; // mutated in place — the SAME object `handle()`/`holdForConnection` may already be holding a reference to.
        return {name:`resource_${name}`,url:`${this.baseUrl}/resource-mcp/${encodeURIComponent(spec.key)}/${name}`,headers:{Authorization:`Bearer ${token}`}};
      }));
      const failed=outcomes.find((o):o is PromiseRejectedResult=>o.status==='rejected');
      if (failed) throw failed.reason;
      const servers=outcomes.map(o=>(o as PromiseFulfilledResult<NonNullable<SpawnSpec['externalMcpServers']>[number]>).value);
      this.prepared.set(spec.key,{file,servers});return {...spec,externalMcpServers:servers};
    } catch(e) {for(const key of created)await this.closeConnection(key);throw e;}
  }
  /**
   * Stable local endpoint survives daemon restarts; tokens never reach the
   * upstream service. Three outcomes (FACTORY-688/689/691):
   *  (a) bearer valid for a connection IN the registry AND that connection
   *      is READY (its own `proxy.ready` already won its race) -> forward,
   *      exactly as before.
   *  (b) a connection exists but is NOT yet ready, OR no connection exists
   *      at all and this agent's first `prepare()` round has not yet
   *      completed (REGARDLESS of whether that round has even STARTED —
   *      FACTORY-702 review round 1: reconcile not having reached this
   *      agent yet is not a reason to skip holding, it is exactly the
   *      post-restart state the ticket targets), with a bearer matching
   *      either the live connection's own token or the token PERSISTED for
   *      this agent/name -> HOLD the request (`holdForConnection` below)
   *      until THIS SPECIFIC connection becomes ready, the round settles
   *      without it, or `requestHoldMs` elapses — whichever comes first.
   *      Ready in time -> forward it, exactly as a connection that was
   *      ready from the start (a real reconnecting client gets a plain
   *      success, never an error, so its own retry/backoff logic is never
   *      even exercised). Round settles without this connection (this
   *      agent's `prepare()` failed, or the global backstop elapsed with
   *      no round ever in flight) -> 401, same as case (c). Bound elapses
   *      while still genuinely indeterminate -> falls through to forward()
   *      anyway if a (not-yet-ready) connection now exists — the pre-702
   *      behaviour, bounded then left to the proxy's own passthrough — or
   *      the same 503 + `Retry-After` as before if no connection exists at
   *      all yet.
   *  (c) anything else — wrong/missing bearer, unknown agent, unknown name,
   *      no token file, or a READY gateway's absent connection (e.g. a
   *      retired agent — `retain()` closes the connection but leaves the
   *      token file) -> 401, byte-identical to today, revealing nothing
   *      about whether `agent`/`name` exist.
   */
  async handle(request:Request,agent:string,name:string):Promise<Response> {
    const key=agent+'/'+name;
    const c=this.connections.get(key);
    if(c) {
      if(!constantTimeEqual(request.headers.get('authorization'),`Bearer ${c.token}`))return UNAUTHORIZED();
      if(c.ready)return this.forward(c,request);
      await this.holdForConnection(key,agent,request.signal);
      // Bounded, then fail (FACTORY-702 review round 1): whatever is at `key`
      // now — ready, still not ready, or gone entirely — is handled by the
      // SAME logic below as the no-connection-yet path, so there is exactly
      // one place this decision is made.
    } else if(this.isReady(agent)) {
      return UNAUTHORIZED();
    } else {
      const token=await this.persistedToken(agent,name);
      if(token===null||!constantTimeEqual(request.headers.get('authorization'),`Bearer ${token}`))return UNAUTHORIZED();
      await this.holdForConnection(key,agent,request.signal);
    }
    const after=this.connections.get(key);
    if(after) {
      if(!constantTimeEqual(request.headers.get('authorization'),`Bearer ${after.token}`))return UNAUTHORIZED();
      return this.forward(after,request); // ready, or not — forward() / the proxy's own passthrough is the existing, tested fallback for "still not ready".
    }
    if(!this.isReady(agent)) {
      return new Response(JSON.stringify({error:'butchr is starting; connection not ready, retry'}),{status:503,headers:{'Retry-After':'2','content-type':'application/json'}});
    }
    return UNAUTHORIZED(); // round settled (success or failure) or the global backstop elapsed with none ever in flight, and still no connection for THIS name.
  }
  /**
   * Blocks until the connection at `key` becomes READY, the round for
   * `agent` settles without ever producing one, the request is aborted, or
   * `requestHoldMs` elapses — whichever comes first. Checks the SPECIFIC
   * connection's own `ready` flag on every poll (not just `isReady(agent)`,
   * which only flips once the WHOLE round — every server for this agent —
   * finishes): under FACTORY-702's concurrent `prepareExternal`, a
   * multi-server agent's OTHER servers may still be mid-handshake while
   * THIS one has already finished, and a held request must not wait for
   * siblings it does not care about. Polling rather than an event-based
   * wake: cheap, and needs no bookkeeping to avoid leaking a waiter that a
   * never-settling round would otherwise orphan (every real round DOES
   * settle, bounded by `prepareExternal`'s own per-server timeout — but a
   * held HTTP request is exactly the kind of resource a bookkeeping bug
   * here would leak silently).
   */
  private async holdForConnection(key:string,agent:string,signal:AbortSignal):Promise<void> {
    const deadline=Date.now()+this.requestHoldMs;
    const pollMs=50;
    for(;;) {
      const c=this.connections.get(key);
      if(c?.ready)return;
      if(!c&&this.isReady(agent))return; // round settled (or the global backstop elapsed with none ever in flight) without ever producing this connection
      if(signal.aborted)return;
      const remaining=deadline-Date.now();
      if(remaining<=0)return;
      await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,remaining)));
    }
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
   *
   * `DELETE` is deliberately exempted from adoption: a client closing a
   * session it no longer holds a live binding for (most commonly: the
   * post-restart stale id it never got to use before giving up on it) has
   * nothing worth recovering — adopting one just to immediately tear it
   * down would be a wasted `initialize` round trip for no observable
   * benefit. A `DELETE` that DOES hit a bound session drops the binding on
   * success, pruning it early — but a real restart leaves no `DELETE`
   * behind at all, so `clientToProxy` is actually bounded by
   * `bindSession`'s own eviction cap, not by `DELETE` traffic.
   */
  private async forward(c:Connection,request:Request):Promise<Response> {
    const clientSessionId=request.headers.get('mcp-session-id');
    if(clientSessionId===null&&request.method==='GET') {
      return jsonError(405,'Method not allowed: GET requires an active session (initialize first).',{Allow:'POST, DELETE'});
    }
    if(clientSessionId!==null&&!SESSION_ID_RE.test(clientSessionId)) {
      return jsonError(400,'Bad Request: Mcp-Session-Id header is malformed.');
    }
    const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
    const send=async(proxySessionId:string|null):Promise<Response> => {
      const headers=new Headers(request.headers);headers.delete('host');headers.set('authorization',c.proxy.headers.Authorization);
      if(proxySessionId!==null)headers.set('mcp-session-id',proxySessionId);
      return fetch(c.proxy.url,{method:request.method,headers,...(body!==undefined?{body}:{}),signal:request.signal});
    };
    let proxySessionId=clientSessionId!==null?(c.sessions.clientToProxy.get(clientSessionId)??clientSessionId):null;
    let response=await send(proxySessionId);
    if(clientSessionId!==null&&response.status===404&&request.method!=='DELETE') {
      let adopted:string;
      try { adopted=await this.adoptSession(c,clientSessionId,request); }
      catch(e) { return jsonError(503,`Upstream session recovery failed: ${e instanceof Error?e.message:String(e)}`,{'Retry-After':'2'}); }
      proxySessionId=adopted;
      response=await send(proxySessionId);
    }
    if(clientSessionId!==null&&request.method==='DELETE'&&response.ok) {
      c.sessions.clientToProxy.delete(clientSessionId);
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
    const promise=this.initializeProxySession(c,request)
      .then(proxySessionId=>{this.bindSession(c.sessions,clientSessionId,proxySessionId);return proxySessionId;})
      .finally(()=>{c.sessions.pending.delete(clientSessionId);});
    c.sessions.pending.set(clientSessionId,promise);
    return promise;
  }
  /**
   * Records a client->proxy session binding, evicting the OLDEST entry once
   * `clientToProxy` exceeds `MAX_BOUND_SESSIONS` (`Map` preserves insertion
   * order, so the first key is always the least-recently-adopted one). A
   * real restart leaves no `DELETE` behind (nothing closes the abandoned
   * client session), so pruning on `DELETE` alone cannot bound this map —
   * this cap is what actually does.
   */
  private bindSession(sessions:SessionBindings,clientSessionId:string,proxySessionId:string):void {
    sessions.clientToProxy.set(clientSessionId,proxySessionId);
    if(sessions.clientToProxy.size>MAX_BOUND_SESSIONS) {
      const oldest=sessions.clientToProxy.keys().next().value;
      if(oldest!==undefined)sessions.clientToProxy.delete(oldest);
    }
  }
  /**
   * Runs a gateway-initiated `initialize` + `notifications/initialized`
   * against `c.proxy` and returns the proxy-minted session id. Protocol
   * version comes from the client's own `MCP-Protocol-Version` header
   * (the spec-honest source for a non-initialize request) falling back to
   * the SDK's latest when absent (e.g. the very first adoption of a
   * session whose original `initialize` predates this gateway and never
   * carried the header this far). Capabilities are sent empty: as verified
   * against the vendored proxy (`startMcpChannelProxy` in
   * `@brooswit/drovr-events`), its upstream `Client` installs only
   * `fallbackNotificationHandler` — never a `fallbackRequestHandler` — so a
   * server-to-client request (sampling, roots) from the real upstream has
   * nowhere to land and gets the SDK's own default "method not found"
   * instead of ever reaching a client capability. Only client->upstream
   * requests (via the local `rpc.fallbackRequestHandler`) and notifications
   * in both directions are bridged, so an empty capabilities set here can't
   * suppress anything that would otherwise be answered.
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
