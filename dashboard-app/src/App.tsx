/**
 * FACTORY-614 (task 2 of the LaunchPad switch, epic FACTORY-427): the app
 * shell — a header with the LaunchPad `Heading` and navigation between the
 * two client routes mounted under `/dashboard-app` (`main.tsx`'s
 * `BrowserRouter basename`). Replaces FACTORY-613's pipeline-proving
 * placeholder (`App.tsx` before this ticket) now that there is a real shell
 * to prove instead.
 */
import { NavLink, Route, Routes } from "react-router";
import { Heading } from "@launchpad-ui/components";
import { DashboardRoute } from "./routes/DashboardRoute.js";
import { ConfigurationsRoute } from "./routes/ConfigurationsRoute.js";
import { RulesRoute } from "./routes/RulesRoute.js";
import { SettingsRoute } from "./routes/SettingsRoute.js";
import { DaemonRoute } from "./routes/DaemonRoute.js";
import { SetupRoute } from "./routes/SetupRoute.js";
import { realSetupApi, type SetupApi } from "./api/setup.js";
import { useSetupGate } from "./hooks/use-setup-gate.js";
import "./App.css";

export interface AppProps {
  /** Overridable for tests — defaults to the real `/api/setup/*` endpoints. */
  setupApi?: SetupApi;
}

/**
 * FACTORY-665 (PR-2) — while `GET /api/setup/status` reports
 * `configured: false`, the ENTIRE app is just the Setup page: no nav, no
 * other routes reachable (every other route's own data would 503 anyway
 * in setup mode — see `../daemon/setup-mode.ts` — so there is nothing for
 * them to show). A loading/error state degrades to showing the normal app
 * shell rather than blocking on it indefinitely — the normal routes' own
 * `PollStatusView`s already handle a daemon that isn't answering.
 */
export function App({ setupApi = realSetupApi }: AppProps) {
  const { state: gate, recheck } = useSetupGate(setupApi);

  if (gate.kind === "unconfigured") {
    return (
      <div className="app-shell">
        <header className="app-header">
          <Heading size="medium">butchr dashboard — setup</Heading>
        </header>
        <main className="app-main">
          <SetupRoute api={setupApi} onSetupSucceeded={recheck} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <Heading size="medium">butchr dashboard</Heading>
        <nav className="app-nav" aria-label="primary">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/configurations">Configurations</NavLink>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <NavLink to="/daemon">Daemon</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<DashboardRoute />} />
          <Route path="/configurations" element={<ConfigurationsRoute />} />
          <Route path="/rules" element={<RulesRoute />} />
          <Route path="/settings" element={<SettingsRoute setupApi={setupApi} />} />
          <Route path="/daemon" element={<DaemonRoute />} />
        </Routes>
      </main>
    </div>
  );
}
