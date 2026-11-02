import type {SpawnSpec} from '../agents/workspace.js';

export interface WorkerChange {id: string; token: string; spec: SpawnSpec; authority?: {serverId:string;authorizationId:string;deploymentId:string}}
export interface WorkerPhysicalIdentity {paneId: string; provider: string}
export type WorkerChangeResult =
  | {status: 'applied'; current: WorkerPhysicalIdentity}
  | {status: 'blocked'; reason: string; current?: WorkerPhysicalIdentity | undefined; partial?: boolean};
export interface WorkerChangeState {
  status: 'pending' | 'applied' | 'blocked' | 'superseded';
  reason?: string;
  current?: WorkerPhysicalIdentity | undefined;
  partial?: boolean;
}

/** Serializes existing Drovr transactions; never transfers history itself. */
export function createWorkerReconciler(options: {
  apply: (change: WorkerChange, isCurrent: () => boolean) => Promise<WorkerChangeResult>;
  valid: (change: WorkerChange) => boolean;
  /** Exact acknowledged terminal result only; never admission or request-incarnation bypass. */
  validResult?: (change:WorkerChange,result:WorkerChangeResult)=>boolean;
  state: (change: WorkerChange, state: WorkerChangeState) => void;
}) {
  const desired = new Map<string, WorkerChange>();
  const queued = new Map<string, WorkerChange>();
  const states = new Map<string, WorkerChangeState>();
  let processing: Promise<void> | undefined;

  // Object identity is the request incarnation. OFF permanently invalidates
  // an active request even if ON later restores the identical config token.
  const current = (change: WorkerChange,result?:WorkerChangeResult) => desired.get(change.id) === change && (options.valid(change)||!!result&&options.validResult?.(change,result)===true);
  function publish(change: WorkerChange, state: WorkerChangeState) {
    if (desired.get(change.id) === change) states.set(change.id, structuredClone(state));
    options.state(change, state);
  }
  async function drain() {
    while (queued.size) {
      const [id, change] = queued.entries().next().value!;
      queued.delete(id);
      if (!current(change)) continue;
      let physical: WorkerPhysicalIdentity | undefined;
      try {
        publish(change, {status: 'pending'});
        if (!current(change)) continue;
        const result = await options.apply(change, () => current(change));
        physical = result.current;
        if (!current(change,result)) {
          publish(change, {
            status: 'superseded',
            ...(result.current ? {current: result.current} : {}),
            partial: result.status === 'applied' || !!result.partial,
          });
          continue;
        }
        publish(change, result);
      } catch (error) {
        const state: WorkerChangeState = {
          status: current(change) ? 'blocked' : 'superseded',
          reason: error instanceof Error ? error.message : 'Worker handoff failed',
          ...(physical ? {current: physical, partial: true} : {}),
        };
        try { publish(change, state); } catch { /* Owner fences persistence failures. */ }
      }
    }
  }
  function start() {
    if (!processing) processing = Promise.resolve().then(drain).finally(() => {
      processing = undefined;
      if (queued.size) start();
    });
  }
  function request(change: WorkerChange, retry = false) {
    const previous = desired.get(change.id);
    if (previous?.token === change.token && (!retry || states.get(change.id)?.status !== 'blocked')) return;
    const next = structuredClone(change);
    desired.set(next.id, next);
    queued.set(next.id, next);
    start();
  }
  function cancel(id: string) {
    desired.delete(id);
    queued.delete(id);
    states.delete(id);
  }
  return {request, cancel, state: (id: string) => states.get(id), async idle() { while (processing) await processing; }};
}
