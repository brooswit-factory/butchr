/**
 * FACTORY-665 (PR-2) — a single fetch of `GET /api/setup/status` at mount,
 * deciding whether `App.tsx` shows the Setup page or the normal dashboard.
 * Deliberately NOT a continuous poll (unlike `usePolling`'s own
 * discipline elsewhere in this app): leaving setup mode always requires a
 * restart (the connection drops), so there is no live transition to catch
 * mid-session — re-checking after `onSetupSucceeded` fires is enough.
 */
import { useCallback, useEffect, useState } from "react";
import type { SetupApi } from "../api/setup.js";

export type SetupGateState = { kind: "loading" } | { kind: "unconfigured" } | { kind: "configured" } | { kind: "error"; message: string };

export function useSetupGate(api: SetupApi): { state: SetupGateState; recheck: () => void } {
  const [state, setState] = useState<SetupGateState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    api.getStatus(controller.signal).then(
      (status) => { if (!cancelled) setState(status.configured ? { kind: "configured" } : { kind: "unconfigured" }); },
      (e: unknown) => { if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { cancelled = true; controller.abort(); };
  }, [api, nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { state, recheck };
}
