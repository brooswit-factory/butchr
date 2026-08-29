import { describe, expect, test, mock } from "bun:test";

describe("realAtlassian createPage", () => {
  test("nests spaceId/status/title/body under `body`, the only key confluence.js 3.2.0 forwards", async () => {
    const calls: unknown[] = [];
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {
          createPage: (parameters: unknown) => {
            calls.push(parameters);
            return Promise.resolve({ id: "1" });
          },
        },
      }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });
    await ops.createPage({ spaceId: "196612", title: "t", body: "<p>x</p>" });
    expect(calls).toEqual([
      { body: { spaceId: "196612", status: "current", title: "t", body: { representation: "storage", value: "<p>x</p>" } } },
    ]);
  });
});
