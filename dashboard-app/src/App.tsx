/**
 * FACTORY-614 (task 2 of the LaunchPad switch, epic FACTORY-427): the app
 * shell — navigation between the client routes mounted under
 * `/dashboard-app` (`main.tsx`'s `BrowserRouter basename`).
 *
 * local/ui: restyled with public LaunchPad components and tokens: one bar
 * across the top with butchr's own mark and the icon nav, the workspace
 * below it (see `AppShell.css`). LaunchPad's `RouterProvider`
 * makes LaunchPad links and `href` buttons navigate client-side and respect
 * the router's `basename`. `/rules` is the Rules page, and
 * `/` the Status page, which took over the Dashboard and Daemon pages
 * (`/daemon` redirects to it). The Links page is gone with the managed links
 * it edited (`/links` redirects to `/` too), and Configurations with the
 * placeholder it was (`/configurations` redirects to Rules).
 */
import { Navigate, NavLink, Route, Routes, useHref, useLocation, useNavigate, type To } from "react-router";
import { Heading, RouterProvider } from "@launchpad-ui/components";
import { Icon, type IconProps } from "@launchpad-ui/icons";
import { StatusRoute } from "./routes/StatusRoute.js";
import { AgentsRoute } from "./routes/AgentsRoute.js";
import { ComingSoonRoute } from "./routes/ComingSoonRoute.js";
import { RulesTargetingRoute } from "./routes/RulesTargetingRoute.js";
import { SettingsRoute } from "./routes/SettingsRoute.js";
import { SetupRoute } from "./routes/SetupRoute.js";
import { ThemeSwitch } from "./components/ThemeSwitch.js";
import butchrMark from "./assets/butchr-mark.png";
import { realSetupApi, type SetupApi } from "./api/setup.js";
import { useSetupGate } from "./hooks/use-setup-gate.js";
import "./App.css";
import "./AppShell.css";

export interface AppProps {
  /** Overridable for tests — defaults to the real `/api/setup/*` endpoints. */
  setupApi?: SetupApi;
}

interface NavItem {
  to: string;
  label: string;
  icon: NonNullable<IconProps["name"]>;
  end?: boolean;
}

/**
 * The daemon's own pages a dashboard link can point at: an agent's terminal
 * (`/agents/pane/:pane/attach`) and a resource's redirect
 * (`/resource/:key/open`). They're served by butchr itself, not this app, so
 * they load as real pages at their own path rather than as client routes
 * under the router's `/dashboard-app` basename.
 */
const DAEMON_PATH_RE = /^\/(?:agents\/pane|resource)\//;
const isDaemonPath = (path: To): path is string => typeof path === "string" && DAEMON_PATH_RE.test(path);

/** `useHref` for LaunchPad's links, leaving daemon paths unprefixed (see `isDaemonPath`). */
function useDashboardHref(href: To): string {
  const routed = useHref(href);
  return isDaemonPath(href) ? href : routed;
}

/** `/configurations` is gone (the Rules page shows each rule's setup and staffing); an old link keeps its #rule anchor. */
function ToRules() {
  const { hash } = useLocation();
  return <Navigate to={{ pathname: "/rules", hash }} replace />;
}

/** One row across the top, in this order. */
const NAV_ITEMS: readonly NavItem[] = [
  { to: "/rules", label: "Rules", icon: "flag" },
  { to: "/agents", label: "Agents", icon: "person" },
  { to: "/settings", label: "Settings", icon: "gear" },
  { to: "/", label: "Status", icon: "pulse", end: true },
  { to: "/coming-soon", label: "Coming soon", icon: "flask" },
];

/** butchr's mark; the app name stays as a heading for screen readers (and the shell's tests) without taking room in the bar. */
function Masthead({ suffix }: { suffix?: string }) {
  return (
    <div className="bt-masthead">
      <img src={butchrMark} alt="" width={32} height={32} className="bt-masthead__mark" />
      <Heading className="bt-visually-hidden">butchr dashboard{suffix ? ` — ${suffix}` : ""}</Heading>
    </div>
  );
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
  const navigate = useNavigate();

  if (gate.kind === "unconfigured") {
    return (
      <RouterProvider navigate={(path) => (isDaemonPath(path) ? window.location.assign(path) : void navigate(path))} useHref={useDashboardHref}>
        <div className="bt-shell bt-shell--setup">
          <header className="bt-topbar">
            <Masthead suffix="setup" />
          </header>
          <main className="bt-workspace">
            <SetupRoute api={setupApi} onSetupSucceeded={recheck} />
          </main>
        </div>
      </RouterProvider>
    );
  }

  return (
    <RouterProvider navigate={(path) => (isDaemonPath(path) ? window.location.assign(path) : void navigate(path))} useHref={useDashboardHref}>
      <div className="bt-shell">
        <header className="bt-topbar">
          <Masthead />
          <nav className="bt-nav" aria-label="primary">
            <ul className="bt-nav__list">
              {NAV_ITEMS.map((item) => (
                <li className="bt-nav__item" key={item.to}>
                  <NavLink className="bt-nav__link" to={item.to} {...(item.end ? { end: true } : {})}>
                    <Icon name={item.icon} size="small" />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="bt-topbar__end">
            <ThemeSwitch />
          </div>
        </header>
        <main className="bt-workspace">
          <Routes>
            <Route path="/" element={<StatusRoute />} />
            <Route path="/agents" element={<AgentsRoute />} />
            <Route path="/coming-soon" element={<ComingSoonRoute />} />
            <Route path="/configurations" element={<ToRules />} />
            <Route path="/rules" element={<RulesTargetingRoute />} />
            <Route path="/links" element={<Navigate to="/" replace />} />
            <Route path="/settings" element={<SettingsRoute setupApi={setupApi} />} />
            <Route path="/daemon" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </RouterProvider>
  );
}
