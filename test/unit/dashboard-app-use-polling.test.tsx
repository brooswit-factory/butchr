import { afterEach, describe, expect, test } from "bun:test";
// FACTORY-614: `@testing-library/react`'s `screen` binds to `document.body`
// EAGERLY, once, the first time `@testing-library/dom` is evaluated in this
// process — if that happens before `withDom()`'s `beforeAll` has registered
// happy-dom, `screen`'s queries are permanently frozen into throwing stubs
// (confirmed empirically; registering happy-dom later never un-freezes
// them). `render()`'s OWN returned queries are bound fresh at CALL time
// instead, after happy-dom is already registered — so every test below
// destructures queries off `render()` rather than importing `screen`.
import { cleanup, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { usePolling } from "../../dashboard-app/src/hooks/use-polling.js";
import type { UsePollingOptions } from "../../dashboard-app/src/hooks/use-polling.js";

withDom();
afterEach(cleanup);

function Probe<T>(opts: UsePollingOptions<T>) {
  const state = usePolling(opts);
  return <div data-testid="state">{JSON.stringify(state)}</div>;
}

describe("usePolling — FACTORY-614", () => {
  test("loading -> loaded on the first successful fetch", async () => {
    const { getByTestId } = render(<Probe fetchOnce={async () => "ok"} intervalMs={10_000} />);
    expect(getByTestId("state").textContent).toContain('"kind":"loading"');
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"loaded"'));
    expect(getByTestId("state").textContent).toContain('"ok"');
  });

  test("a refresh failure after a success keeps the last good data and flips to stale, not error", async () => {
    let call = 0;
    const fetchOnce = async () => {
      call += 1;
      if (call === 1) return "first";
      throw new Error("refresh failed");
    };
    const { getByTestId } = render(<Probe fetchOnce={fetchOnce} intervalMs={15} />);
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"loaded"'));
    await waitFor(() => expect(getByTestId("state").textContent).toContain('"kind":"stale"'), { timeout: 2000 });
    const text = getByTestId("state").textContent ?? "";
    expect(text).toContain('"first"'); // last good data retained
    expect(text).toContain("refresh failed");
  });

  test("abort on unmount: the signal handed to fetchOnce is aborted once the component unmounts", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchOnce = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        capturedSignal = signal;
        setTimeout(() => resolve("too late"), 5000);
      });
    const { unmount } = render(<Probe fetchOnce={fetchOnce} intervalMs={10_000} />);
    await waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("backoff: a persistent failure is retried (never gives up), each attempt visible as a fresh error state", async () => {
    let calls = 0;
    const fetchOnce = async () => {
      calls += 1;
      throw new Error(`failure #${calls}`);
    };
    const { getByTestId } = render(<Probe fetchOnce={fetchOnce} intervalMs={10_000} backoffBaseMs={5} backoffMaxMs={20} />);
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    expect(getByTestId("state").textContent).toContain('"kind":"error"');
  });
});
