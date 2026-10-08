import { describe, expect, test } from "bun:test";
import { peerUidOf, isSameUidPeer, lsofToProcNetTcp } from "../../src/web/peer-uid.js";

const HEADER = "  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode";

// 127.0.0.1 = 0100007F; port 50000 = C350 hex; port 7718 = 1E26 hex.
const CLIENT_ROW = "   0: 0100007F:C350 0100007F:1E26 01 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 20 4 30 10 -1";
const OTHER_UID_ROW = "   1: 0100007F:C351 0100007F:1E26 01 00000000:00000000 00:00000000 00000000  2000        0 123457 1 0000000000000000 20 4 30 10 -1";
// Same ports as CLIENT_ROW, but a DIFFERENT local address (10.0.0.1 = 0100000A)
// — proves the match is on the full 4-tuple, not port alone (PR #642 review
// round 2, G3).
const WRONG_ADDRESS_ROW = "   2: 0100000A:C350 0100007F:1E26 01 00000000:00000000 00:00000000 00000000  3000        0 123458 1 0000000000000000 20 4 30 10 -1";

const SERVER = { address: "127.0.0.1", port: 7718 };
const client = (port: number) => ({ address: "127.0.0.1", port });

describe("peerUidOf", () => {
  test("finds the uid of the row matching the full (local, remote) 4-tuple", () => {
    const table = [HEADER, CLIENT_ROW, OTHER_UID_ROW].join("\n");
    expect(peerUidOf(table, client(50000), SERVER)).toBe(1000);
  });
  test("no matching row: null (fail closed)", () => {
    const table = [HEADER, CLIENT_ROW].join("\n");
    expect(peerUidOf(table, client(50001), SERVER)).toBeNull();
  });
  test("matching ports but a DIFFERENT local address: null — the full 4-tuple must match, not port alone", () => {
    const table = [HEADER, WRONG_ADDRESS_ROW].join("\n");
    expect(peerUidOf(table, client(50000), SERVER)).toBeNull();
  });
  test("malformed/short lines are skipped without throwing", () => {
    const table = [HEADER, "garbage line", CLIENT_ROW].join("\n");
    expect(peerUidOf(table, client(50000), SERVER)).toBe(1000);
  });
  test("empty table: null", () => {
    expect(peerUidOf("", client(50000), SERVER)).toBeNull();
  });
  test("header row alone never matches (no NaN-vs-NaN false positive)", () => {
    expect(peerUidOf(HEADER, client(NaN), { address: "127.0.0.1", port: NaN })).toBeNull();
  });
  test("an unparseable (non-IPv4) client address fails closed, never throws", () => {
    const table = [HEADER, CLIENT_ROW, OTHER_UID_ROW].join("\n");
    expect(peerUidOf(table, { address: "::1", port: 50000 }, SERVER)).toBeNull();
  });
  test("an unparseable (non-IPv4) server address fails closed, never throws", () => {
    const table = [HEADER, CLIENT_ROW, OTHER_UID_ROW].join("\n");
    expect(peerUidOf(table, client(50000), { address: "::1", port: 7718 })).toBeNull();
  });
});

describe("isSameUidPeer", () => {
  const table = [HEADER, CLIENT_ROW, OTHER_UID_ROW].join("\n");
  test("same uid as the process: true", () => {
    const ok = isSameUidPeer(client(50000), { server: SERVER, read: () => table, ownUid: () => 1000 });
    expect(ok).toBe(true);
  });
  test("different uid: false", () => {
    const ok = isSameUidPeer(client(50001), { server: SERVER, read: () => table, ownUid: () => 1000 });
    expect(ok).toBe(false);
  });
  test("no matching row at all: false (fail closed, never assume yes)", () => {
    const ok = isSameUidPeer(client(9999), { server: SERVER, read: () => table, ownUid: () => 1000 });
    expect(ok).toBe(false);
  });
  test("ownUid cannot be determined: false", () => {
    const ok = isSameUidPeer(client(50000), { server: SERVER, read: () => table, ownUid: () => undefined });
    expect(ok).toBe(false);
  });
  test("read throws-free empty table: false", () => {
    const ok = isSameUidPeer(client(50000), { server: SERVER, read: () => "", ownUid: () => 1000 });
    expect(ok).toBe(false);
  });
});

describe("lsofToProcNetTcp (macOS has no /proc/net/tcp)", () => {
  const LSOF = [
    "p100", "u501", "f9", "n127.0.0.1:7718", "f10", "n127.0.0.1:7718->127.0.0.1:50000",
    "p200", "u502", "f36", "n127.0.0.1:50000->127.0.0.1:7718",
    "p300", "unotanumber", "f4", "n127.0.0.1:50001->127.0.0.1:7718",
    "p400", "u503", "f5", "n[::1]:50002->[::1]:7718", "",
  ].join("\n");
  test("rows feed peerUidOf: the client's own socket resolves to the client process's uid, not the server's", () => {
    expect(peerUidOf(lsofToProcNetTcp(LSOF), client(50000), SERVER)).toBe(502);
  });
  test("a listening socket, a process with an unparseable uid, and IPv6 sockets yield no row (fail closed)", () => {
    const table = lsofToProcNetTcp(LSOF);
    expect(peerUidOf(table, client(50001), SERVER)).toBeNull();
    expect(peerUidOf(table, client(50002), SERVER)).toBeNull();
  });
  test("empty or garbage output: header only, never throws", () => {
    expect(peerUidOf(lsofToProcNetTcp(""), client(50000), SERVER)).toBeNull();
    expect(peerUidOf(lsofToProcNetTcp("garbage\nn1.2.3.4"), client(50000), SERVER)).toBeNull();
  });
  test("isSameUidPeer accepts when the converted row's uid is this process's own", () => {
    const read = () => lsofToProcNetTcp(LSOF);
    expect(isSameUidPeer(client(50000), { server: SERVER, read, ownUid: () => 502 })).toBe(true);
    expect(isSameUidPeer(client(50000), { server: SERVER, read, ownUid: () => 501 })).toBe(false);
  });
});

describe.skipIf(process.platform !== "darwin")("real loopback connection on macOS", () => {
  test("the production reader identifies our own client socket as our own uid", async () => {
    let seen: { address: string; port: number } | undefined;
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, s) { seen = s.requestIP(req) ?? undefined; return new Response("ok"); } });
    try {
      await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      expect(seen).toBeDefined();
      expect(isSameUidPeer(seen!, { server: { address: "127.0.0.1", port: srv.port! } })).toBe(true);
    } finally {
      srv.stop(true);
    }
  });
});
