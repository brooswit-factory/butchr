import { describe, expect, test, mock } from "bun:test";

describe("realAtlassian confluence page ops", () => {
  test("createPage nests spaceId/status/title/body under `body`, the only key confluence.js 3.2.0 forwards; getPage sends bodyFormat, the key the library actually reads", async () => {
    const createPageCalls: unknown[] = [];
    const getPageByIdCalls: unknown[] = [];
    mock.module("confluence.js", () => ({
      createV2Client: () => ({
        page: {
          createPage: (parameters: unknown) => {
            createPageCalls.push(parameters);
            return Promise.resolve({ id: "1" });
          },
          getPageById: (parameters: unknown) => {
            getPageByIdCalls.push(parameters);
            return Promise.resolve({ id: "10682374", body: { storage: { value: "<p>x</p>" } } });
          },
        },
      }),
    }));
    const { realAtlassian } = await import("../../src/tools/atlassian-real.js");
    const ops = realAtlassian({ site: "https://x.atlassian.net", email: "e@x.com", token: "t" });

    await ops.createPage({ spaceId: "196612", title: "t", body: "<p>x</p>" });
    expect(createPageCalls).toEqual([
      { body: { spaceId: "196612", status: "current", title: "t", body: { representation: "storage", value: "<p>x</p>" } } },
    ]);

    await ops.getPage("10682374");
    expect(getPageByIdCalls).toEqual([{ id: "10682374", bodyFormat: "storage" }]);
  });
});
