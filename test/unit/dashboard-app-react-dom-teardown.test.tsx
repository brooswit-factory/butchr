import { afterAll, afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { useEffect } from "react";
import { cleanup, render } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";

const scheduler = createRequire(import.meta.url)("scheduler") as {
  unstable_NormalPriority: number;
  unstable_scheduleCallback: (priority: number, callback: () => void) => unknown;
};
withDom();
afterEach(cleanup);
let completed = 0;

function Probe() {
  useEffect(() => () => {
    scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
      expect(window.document).toBeDefined();
      completed++;
    });
  }, []);
  return <div>Teardown probe</div>;
}

test("unmounted React scheduler work finishes before scoped DOM globals are restored", () => {
  render(<Probe />);
});
afterAll(() => { expect(completed).toBe(1); });
