import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PatternSharing } from "../../native-host/src/memory/pattern-sharing.ts";
import { patternWindow, validPatternBatch, weekMs } from "../../src/site-registry/patterns.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const state = { profile: "fixture", origin: "dev", now: 3000 * weekMs, recording: true, calls: 0, fail: false,
    tab: { id: 1, sessionId: "session", controlled: true, incognito: false, url: "https://news.ycombinator.com/item?id=1729", pendingUrl: "" } };
  const sent: { route: string; input: unknown; key: string | Buffer }[] = [];
  const deps = { origin: () => state.origin, now: () => state.now, activeProfile: () => state.profile, recording: () => state.recording,
    tab: async () => { state.calls++; return { ...state.tab }; },
    send: async (_origin: string, route: string, input: unknown, key: string | Buffer) => {
      sent.push({ route, input, key });
      if (state.fail) throw Error("Offline");
      return { ok: true };
    } };
  const service = new PatternSharing(db, deps);
  const begin = (label = "headline") => service.begin("fixture", service.grant("fixture") ?? "", "session", 1, label);
  const capture = async (label = "headline") => {
    const ticket = await begin(label);
    if (ticket) await service.confirm("fixture", ticket, "session", 1);
  };
  return { db, state, sent, service, deps, begin, capture };
}

describe("Action Memory pattern sharing", () => {
  test("turning on Action Memory grants once per profile and destination, preserves opt-outs across restarts and emits only new reads", async () => {
    const { db, service, deps, state, capture, sent } = fixture();
    try {
      await capture();
      expect(service.chosen("fixture")).toBe(false);
      state.origin = "";
      expect(service.applyDefault("fixture")).toBe(false);
      expect(service.chosen("fixture")).toBe(false);
      state.origin = "dev";
      expect(service.applyDefault("fixture")).toBe(true);
      expect(service.chosen("fixture")).toBe(true);
      const first = service.grant("fixture");
      expect(first).toBeTruthy();
      await service.flush();
      expect(sent).toHaveLength(0);
      expect(service.applyDefault("fixture")).toBe(true);
      expect(service.chosen("fixture")).toBe(true);
      expect(service.grant("fixture")).toBe(first);
      await capture();
      await service.flush();
      expect(sent).toHaveLength(1);
      state.origin = "different";
      service.applyDefault("fixture");
      expect(service.grant("fixture")).toBeNull();
      state.origin = "dev";
      service.configure("fixture", false);
      const restarted = new PatternSharing(db, deps);
      restarted.applyDefault("fixture");
      expect(restarted.grant("fixture")).toBeNull();
      restarted.applyDefault("another-profile");
      expect(restarted.grant("another-profile")).toBeTruthy();
    } finally { db.close(); }
  });
  test("requires new consent and two matching observations of a controlled, public, non-private resource", async () => {
    const { service, state, sent, begin, capture, db } = fixture();
    try {
      await capture();
      expect(state.calls).toBe(0);
      service.configure("fixture", true);
      state.tab.incognito = true;
      await capture();
      state.tab.incognito = false;
      for (const url of ["https://private.example/tenant", "https://news.ycombinator.com/user?id=private", "https://www.npmjs.com/package/@private/team", "https://news.ycombinator.com/item?id=1&token=private"]) {
        state.tab.url = url; await capture();
      }
      state.tab.url = "https://news.ycombinator.com/item?id=1";
      await capture("headline secret-private-value");
      const changed = await begin(); state.tab.url += "2";
      await service.confirm("fixture", changed!, "session", 1);
      const stale = await begin();
      service.configure("fixture", false);
      service.configure("fixture", true);
      await service.confirm("fixture", stale!, "session", 1);
      state.tab.controlled = false; await capture(); state.tab.controlled = true;
      state.tab.pendingUrl = "https://private.example"; await capture(); state.tab.pendingUrl = "";
      state.recording = false; await capture(); state.recording = true;
      const switched = await begin(); state.profile = "different";
      await service.confirm("fixture", switched!, "session", 1);
      state.profile = "fixture";
      await service.flush(); expect(sent).toHaveLength(0);
    } finally { db.close(); }
  });
  test("batches unique operations, restarts offline, scopes keys and withdraws without reopening consent", async () => {
    const { service, state, sent, capture, deps, db } = fixture();
    try {
      service.configure("fixture", true);
      for (let i = 0; i < 100; i++) await capture("headline");
      await capture("score"); await capture("score");
      state.fail = true; await service.flush();
      expect(sent).toHaveLength(1);
      const restarted = new PatternSharing(db, deps);
      await restarted.flush(); expect(sent).toHaveLength(1);
      state.fail = false; state.now += 61000;
      await Promise.all([service.flush(), restarted.flush()]);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.input).toEqual({ v: 1, site: "hacker-news", window: 3000, tasks: ["score", "title"] });
      expect(sent[0]?.key === sent[1]?.key).toBe(true);
      await capture(); await service.flush(); expect(sent).toHaveLength(2);
      state.tab.url = "https://www.npmjs.com/package/react";
      await capture("license"); await service.flush();
      expect(sent[2]?.key !== sent[1]?.key).toBe(true);
      state.origin = "other"; expect(service.grant("fixture")).toBeNull(); await service.flush();
      state.origin = "dev";
      state.now += weekMs; await capture("license"); await service.flush();
      expect(sent[3]?.key !== sent[2]?.key).toBe(true);
      service.configure("fixture", false); expect(service.grant("fixture")).toBeNull();
      for (let i = 0; i < 5; i++) await restarted.flush();
      expect(sent.slice(4).map(row => row.route)).toEqual(Array(3).fill("forget-patterns"));
      expect(sent.slice(4).every(row => !("tasks" in (row.input as object)))).toBe(true);
      await capture(); await restarted.flush(); expect(sent).toHaveLength(7);
    } finally { db.close(); }
  });
  test("disable before transport discards the queue without contacting the service", async () => {
    const { service, sent, db, capture } = fixture();
    try {
      service.configure("fixture", true); await capture(); service.configure("fixture", false);
      await service.flush(); expect(sent).toHaveLength(0);
    } finally { db.close(); }
  });
});

test("wire validation rejects extra keys, unsupported tasks, duplicates and expired reports", () => {
  const now = Date.now(), window = patternWindow(now);
  const good = { v: 1, site: "hacker-news", window, tasks: ["score", "title+by"] };
  expect(validPatternBatch(good, now)).toBe(true);
  for (const bad of [{ ...good, url: "private" }, { ...good, tasks: ["score", "score"] },
    { ...good, tasks: ["script"] }, { ...good, tasks: ["by+title"] }, { ...good, window: window - 2 },
    { ...good, site: "private.example" }, { ...good, tasks: Array(100).fill("title") }]) expect(validPatternBatch(bad, now)).toBe(false);
});
