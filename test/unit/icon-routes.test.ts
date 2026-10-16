import { describe, expect, test } from "bun:test";
import { liveView } from "../../src/web/view.js";
import { ICON_HEAD_TAGS, ICON_MARK, ICON_ROUTES } from "../../src/web/icons.js";
import type { ViewDeps } from "../../src/web/view.js";

const fakeMcp = {} as never;
const unused = () => { throw new Error("unused in this test"); };
const deps = { state: unused, open: unused, openPane: unused, health: unused, dashboard: unused, header: unused, resourceLink: unused, configInventory: unused } as unknown as ViewDeps;

describe("brand icon routes", () => {
  for (const path of Object.keys(ICON_ROUTES)) {
    test(`${path} serves a real PNG with a cache header`, async () => {
      const res = await liveView(fakeMcp, deps).handle(new Request(`http://local${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("max-age");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]); // "PNG"
      expect(bytes.length).toBeGreaterThan(200);
    });
  }
  test("every icon the pages link to is a route that exists", () => {
    for (const m of `${ICON_HEAD_TAGS}${ICON_MARK}`.matchAll(/(?:href|src)="([^"]+)"/g)) expect(ICON_ROUTES[m[1]!]).toBeDefined();
  });
  test("an unknown path is still not an icon", async () => {
    const res = await liveView(fakeMcp, deps).handle(new Request("http://local/favicon-999.png"));
    expect(res.status).toBe(404);
  });
});
