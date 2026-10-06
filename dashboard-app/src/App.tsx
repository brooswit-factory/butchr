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
import "./App.css";

export function App() {
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
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<DashboardRoute />} />
          <Route path="/configurations" element={<ConfigurationsRoute />} />
          <Route path="/rules" element={<RulesRoute />} />
          <Route path="/settings" element={<SettingsRoute />} />
        </Routes>
      </main>
    </div>
  );
}
