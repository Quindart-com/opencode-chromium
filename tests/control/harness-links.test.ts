import { afterEach,expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessControls,ownSocket } from "../../src/control/harness-control.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-links-")); dirs.push(dir);
  const folder = path.join(dir, "harness-links"); fs.mkdirSync(folder);
  const make = (name: string, body: unknown, ageMs = 0) => {
    const file = path.join(folder, name + ".json");
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    if (ageMs) { const when = new Date(Date.now() - ageMs); fs.utimesSync(file, when, when); }
    return file;
  };
  return { dir, make };
}
const uuid = () => crypto.randomUUID();
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, token: uuid(), pid: process.pid, harness: "codex", version: "1.0.0", harnessVersion: null,
  socket: ownSocket(id), updatedAt: Date.now(), ...extra });

test("stale, dead and invalid link files are deleted; fresh ones are kept and returned", () => {
  const f = fixture();
  const fresh = uuid(), oldStamp = uuid(), oldMtime = uuid(), invalid = uuid(), freshInvalid = uuid(), dead = uuid();
  const freshFile = f.make(fresh, row(fresh));
  const oldStampFile = f.make(oldStamp, row(oldStamp, { updatedAt: Date.now() - 200000 }));
  const oldMtimeFile = f.make(oldMtime, row(oldMtime), 200000);
  const invalidFile = f.make(invalid, "{not json", 200000);
  const freshInvalidFile = f.make(freshInvalid, "{not json");
  const deadFile = f.make(dead, row(dead, { pid: 2147483000 }));
  const result = harnessControls(f.dir);
  expect(result.map(item => item.id)).toEqual([fresh]);
  expect(result.map(item => item.id)).not.toContain(oldStamp);
  expect(fs.existsSync(freshFile)).toBe(true);
  for (const file of [oldStampFile, oldMtimeFile, invalidFile, deadFile]) expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(freshInvalidFile)).toBe(true);
});

test("reaping is throttled but stale files are still filtered out of results", () => {
  const f = fixture();
  harnessControls(f.dir);
  const late = uuid(), file = f.make(late, row(late, { updatedAt: Date.now() - 200000 }), 200000);
  expect(harnessControls(f.dir).map(item => item.id)).not.toContain(late);
  expect(fs.existsSync(file)).toBe(true);
  harnessControls(f.dir, { reap: true });
  expect(fs.existsSync(file)).toBe(false);
});

test("a missing folder yields no links without throwing", () => {
  expect(harnessControls(path.join(os.tmpdir(), "does-not-exist-" + uuid()))).toEqual([]);
});
