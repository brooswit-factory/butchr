// Standalone worker process for test/unit/catamorbius/push-controller-
// shutdown.test.ts: proves `attachProcessShutdown` (src/catamorbius/
// push-controller.ts) actually terminates the process on SIGTERM/SIGINT —
// a real OS process receiving a real signal, not a simulated call to a
// handler function in-process, since the whole regression this guards
// against is Node/Bun's own default "terminate on SIGTERM/SIGINT"
// behaviour being silently replaced by registering a handler that never
// calls `process.exit`. Not a test file itself — spawned via `bun run`
// with argv:
//   [2] file:// URL of push-controller.ts to import attachProcessShutdown from
//   [3] a log file path — one line appended when the fake controller's
//       stop() is called, so the parent test can see cleanup actually ran
//       before the process exits
import { appendFileSync } from "node:fs";

const [, , moduleHref, logPath] = process.argv;
const mod = (await import(moduleHref!)) as { attachProcessShutdown: (controller: { stop(): void }) => void };

const fakeController = {
  stop(): void {
    appendFileSync(logPath!, "stopped\n");
  },
};

mod.attachProcessShutdown(fakeController);

// Signal the parent (over stdout) that handlers are registered and this
// process is now just idling, waiting for a signal — otherwise the parent
// has no reliable way to know registration happened before it sends one.
process.stdout.write("ready\n");
// Keep the event loop alive so the only way out is the signal itself (the
// exact scenario the regression needs: before `attachProcessShutdown`
// existed, nothing else in this fixture would ever cause it to exit).
setInterval(() => {}, 1_000_000);
