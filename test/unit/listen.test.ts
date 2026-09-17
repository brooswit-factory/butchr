import { describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { Elysia } from "elysia";
import { DAEMON_HOSTNAME, listenOptions } from "../../src/daemon/listen.js";

const status = (url: string) => fetch(url).then((r) => r.status, () => "refused" as const);

/** A non-loopback IPv4 address of this host, if it has one. */
const externalIPv4 = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;

describe("daemon listen address", () => {
  test("is loopback only", () => {
    expect(DAEMON_HOSTNAME).toBe("127.0.0.1");
    expect(listenOptions(7717)).toEqual({ port: 7717, hostname: "127.0.0.1" });
  });

  test("the bound server answers on localhost and 127.0.0.1", async () => {
    const app = new Elysia().get("/health", () => "ok").listen(listenOptions(0));
    try {
      const port = app.server!.port;
      expect(await status(`http://127.0.0.1:${port}/health`)).toBe(200);
      expect(await status(`http://localhost:${port}/health`)).toBe(200);
    } finally {
      app.stop(true);
    }
  });

  test.skipIf(!externalIPv4)("the bound server refuses this host's non-loopback address", async () => {
    const app = new Elysia().get("/health", () => "ok").listen(listenOptions(0));
    try {
      expect(await status(`http://${externalIPv4}:${app.server!.port}/health`)).toBe("refused");
    } finally {
      app.stop(true);
    }
  });
});
