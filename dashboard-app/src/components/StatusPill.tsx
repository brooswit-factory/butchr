/**
 * FACTORY-615: the status pill — `dashboard-page.ts`'s own `.st` badge
 * (agent status / "waiting for a slot"), ported to a LaunchPad-tokened
 * component. There is no dedicated pill/badge/lozenge component in this
 * version of `@launchpad-ui/components` (0.25.0 — see the PR description's
 * component-mapping table), so this wraps `Text` with a small, local,
 * token-driven class per status rather than inventing hex colours: every
 * colour here is one of the `--lp-color-data-*`/`--lp-color-bg-feedback-*`/
 * `--lp-color-text-feedback-*` tokens (see `StatusPill.css`), the same
 * tokens `@launchpad-ui/components` itself is built from.
 */
import { Text } from "@launchpad-ui/components";
import "./StatusPill.css";

export interface StatusPillProps {
  /** Already sanitized via `safeClass` (`view-model/dashboard-view.ts`) — never raw, untrusted text used as a class name. */
  statusClass: string;
  /** The literal label to show — the raw `agentStatus`, or "waiting for a slot" for a withheld row. */
  label: string;
}

export function StatusPill({ statusClass, label }: StatusPillProps) {
  return (
    <Text elementType="span" size="small" className={`status-pill status-pill--${statusClass}`}>
      {label}
    </Text>
  );
}
