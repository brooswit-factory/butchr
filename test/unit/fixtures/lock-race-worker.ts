// Standalone worker process for test/unit/write-rules.test.ts's F6 lock-race
// test: a real OS process, not simulated in-process, since the whole point is
// to exercise genuine concurrent contention on a dead `.rules.lock` — both
// processes must refuse, since there is no cross-process reclaim. Not a test
// file itself — spawned via `bun run` with argv:
//   [2] file:// URL of write-rules.ts to import acquireRulesLock from
//   [3] the rules directory holding (or about to hold) .rules.lock
//   [4] a shared log file path — one JSON line appended per outcome
//   [5] how many milliseconds to hold the lock once acquired
import { appendFileSync } from "node:fs";

const [, , moduleHref, dir, logPath, holdMsRaw] = process.argv;
const holdMs = Number(holdMsRaw);

const mod = (await import(moduleHref!)) as { acquireRulesLock: (dir: string) => () => void };

try {
  const release = mod.acquireRulesLock(dir!);
  const start = Date.now();
  while (Date.now() - start < holdMs) {
    // busy-wait while "holding" the lock, so a concurrent racer has a real window to contend in
  }
  const end = Date.now();
  appendFileSync(logPath!, `${JSON.stringify({ pid: process.pid, start, end })}\n`);
  release();
  process.exit(0);
} catch (e) {
  appendFileSync(logPath!, `${JSON.stringify({ pid: process.pid, error: String((e as Error)?.message ?? e) })}\n`);
  process.exit(1);
}
