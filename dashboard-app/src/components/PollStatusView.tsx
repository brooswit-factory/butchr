/**
 * FACTORY-614: the shared loading / error / "could not check" presentation
 * both placeholder routes use around their own `PollState<T>` — one place
 * that decides what each transport state LOOKS like, so Tasks 3 and 4 (the
 * real dashboard/configurations pages) reuse this instead of each growing
 * its own copy. Deliberately dumb: it renders the three non-data states
 * itself and hands `data` straight to `children` for the `loaded`/`stale`
 * cases, never reshaping it.
 */
import type { ReactNode } from "react";
import { Alert, AlertText, Text } from "@launchpad-ui/components";
import type { PollState } from "../view-model/poll-state.js";

export interface PollStatusViewProps<T> {
  state: PollState<T>;
  /** What this endpoint is, for the loading/error copy (e.g. "dashboard"). */
  label: string;
  children: (data: T, meta: { stale: boolean }) => ReactNode;
}

export function PollStatusView<T>({ state, label, children }: PollStatusViewProps<T>): ReactNode {
  if (state.kind === "loading") return <Text elementType="p">loading {label}…</Text>;
  if (state.kind === "error") {
    return (
      <Alert status="error">
        <AlertText>could not check {label} — {state.error}</AlertText>
      </Alert>
    );
  }
  const stale = state.kind === "stale";
  return (
    <>
      {stale && (
        <Alert status="warning">
          <AlertText>could not check {label} — showing data as of a previous refresh: {state.error}</AlertText>
        </Alert>
      )}
      {children(state.data, { stale })}
    </>
  );
}
