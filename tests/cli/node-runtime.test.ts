import { expect,test } from "bun:test";
import { harnessPrivateNode,selectNodeRuntime,type NodeRuntimeDeps } from "../../src/cli/node-runtime.ts";

const SYSTEM = "/opt/nodejs/bin/node";
const deps = (over: Partial<NodeRuntimeDeps> & { versions?: Record<string, string> } = {}): NodeRuntimeDeps => ({
  execPath: SYSTEM, version: "24.1.0", platform: "linux", pathCandidates: () => [], versionOf: file => over.versions?.[file] ?? null,
  exists: () => true, ...over });

test("keeps the running node when it is new enough and not harness-private", () => {
  expect(selectNodeRuntime(deps())).toEqual({ execPath: SYSTEM });
});

test("prefers a suitable node on PATH over an old running node", () => {
  const choice = selectNodeRuntime(deps({ version: "22.22.2", pathCandidates: () => ["/old/node", "/new/node"], versions: { "/old/node": "v20.0.0", "/new/node": "v24.2.0\n" } }));
  expect(choice).toEqual({ execPath: "/new/node" });
});

test("skips harness-private interpreters, even when new enough", () => {
  const priv = "/home/a/.cache/codex-runtimes/node/bin/node";
  expect(harnessPrivateNode(priv)).toBe(true);
  expect(harnessPrivateNode("C:\\Users\\a\\.cache\\codex-runtimes\\node\\node.exe")).toBe(true);
  const choice = selectNodeRuntime(deps({ execPath: priv, pathCandidates: () => [priv, "/sys/node"], versions: { [priv]: "v24.0.0", "/sys/node": "v25.0.0" } }));
  expect(choice.execPath).toBe("/sys/node");
  expect(choice.warning).toBeUndefined();
});

test("falls back to the running node with a warning when nothing suitable exists", () => {
  const old = selectNodeRuntime(deps({ version: "22.22.2", pathCandidates: () => ["/x/node"], versions: { "/x/node": "v18.0.0" } }));
  expect(old.execPath).toBe(SYSTEM);
  expect(old.warning).toContain("Node 24");
  expect(selectNodeRuntime(deps({ execPath: "/home/a/.cache/codex-runtimes/node" })).warning).toContain("private");
});

test("unrunnable or missing candidates are ignored", () => {
  const choice = selectNodeRuntime(deps({ version: "22.0.0", pathCandidates: () => ["/gone/node", "/bad/node"], exists: file => file !== "/gone/node" }));
  expect(choice.warning).toBeDefined();
});
