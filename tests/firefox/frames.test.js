import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { bridgedFrameTree } from "../../native-host/src/firefox/frames.js";
import { FirefoxBackend } from "../../native-host/src/firefox/backend.js";

function frameFixture() {
  const documents = new Map();
  const calls = [];
  let contexts = [];
  return {
    calls,
    setTree(tree) { contexts = tree; },
    document(context, attributes = new Map()) { documents.set(context, attributes); return attributes; },
    async send(method, params) {
      calls.push({ method, params });
      if (method === "browsingContext.getTree") return { contexts };
      assert.equal(method, "script.evaluate");
      const attributes = documents.get(params.target.context);
      assert.ok(attributes, "evaluation must target a known document");
      const value = vm.runInNewContext(params.expression, {
        document: { documentElement: {
          getAttribute: key => attributes.get(key) ?? null,
          setAttribute: (key, value) => attributes.set(key, value),
        } },
      });
      return { result: { type: "string", value } };
    },
  };
}

const frame = (context, children = []) => ({ context, url: "https://same.example/", children });

test("document frame identity survives BiDi reconnection with duplicate URLs", async () => {
  const fixture = frameFixture();
  const parent = fixture.document("root-old");
  const child = fixture.document("child-old");
  fixture.setTree([frame("root-old", [frame("child-old")])]);
  const before = await bridgedFrameTree({ send: fixture.send, root: "root-old" });
  fixture.document("root-new", parent);
  fixture.document("child-new", child);
  fixture.setTree([frame("root-new", [frame("child-new")])]);
  const after = await bridgedFrameTree({ send: fixture.send, root: "root-new" });
  assert.equal(after.frameTree.frame.id, before.frameTree.frame.id);
  const childId = before.frameTree.childFrames[0].frame.id;
  assert.equal(after.frameTree.childFrames[0].frame.id, childId);
  assert.equal(after.contexts.get(childId), "child-new");
  assert.notEqual(childId, after.frameTree.frame.id);
});

test("a replaced document invalidates its previous frame identity", async () => {
  const fixture = frameFixture();
  fixture.document("root");
  fixture.setTree([frame("root")]);
  const before = await bridgedFrameTree({ send: fixture.send, root: "root" });
  fixture.document("root");
  const after = await bridgedFrameTree({ send: fixture.send, root: "root" });
  assert.notEqual(after.frameTree.frame.id, before.frameTree.frame.id);
  assert.equal(after.contexts.has(before.frameTree.frame.id), false);
});

test("duplicate markers and missing documents fail without an ambiguous mapping", async () => {
  const fixture = frameFixture();
  const marker = "01234567-89ab-4cde-8fab-0123456789ab";
  fixture.document("root", new Map([["data-opencode-frame-id", marker]]));
  fixture.document("child", new Map([["data-opencode-frame-id", marker]]));
  fixture.setTree([frame("root", [frame("child")])]);
  await assert.rejects(bridgedFrameTree({ send: fixture.send, root: "root" }), /ambiguous/);
  await assert.rejects(bridgedFrameTree({ root: "root", send: async method =>
    method === "browsingContext.getTree" ? { contexts: [frame("root")] } : { result: { type: "null" } },
  }), /unavailable/);
});

test("a missing or unrelated root is rejected before evaluating any page", async () => {
  const fixture = frameFixture();
  for (const tree of [[], [frame("other")], [frame("root"), frame("other")]]) {
    fixture.setTree(tree);
    await assert.rejects(bridgedFrameTree({ send: fixture.send, root: "root" }), /controlled tab/);
  }
  assert.equal(fixture.calls.some(call => call.method === "script.evaluate"), false);
});

test("frame caps prevent reads of descendants outside the requested budget", async () => {
  const fixture = frameFixture();
  for (const id of ["root", "one", "two"]) fixture.document(id);
  fixture.setTree([frame("root", [frame("one"), frame("two")])]);
  const result = await bridgedFrameTree({ send: fixture.send, root: "root", maxDepth: 100, maxFrames: 2 });
  assert.equal(fixture.calls[0].params.maxDepth, 8);
  assert.equal(result.contexts.size, 2);
  assert.equal(result.frameTree.truncated, true);
  assert.deepEqual(fixture.calls.filter(call => call.method === "script.evaluate").map(call => call.params.target.context), ["root", "one"]);
});

test("frame evaluation cannot leave the controlled tab's current tree", async () => {
  const backend = new FirefoxBackend();
  backend.contexts.set(7, "root");
  const evaluations = [];
  backend.send = async (method, params) => {
    if (method === "browsingContext.getTree") {
      assert.equal(params.root, "root");
      return { contexts: [frame("root", [frame("child")])] };
    }
    evaluations.push(params.target.context);
    return { result: { type: "number", value: 42 } };
  };
  for (const contextId of ["other-tab", "previous-child"]) {
    await assert.rejects(backend.command(7, "Runtime.evaluate", { contextId, expression: "42" }), /unowned/);
  }
  assert.deepEqual(evaluations, []);
  const result = await backend.command(7, "Runtime.evaluate", { contextId: "child", expression: "42" });
  assert.equal(result.result.value, 42);
  assert.deepEqual(evaluations, ["child"]);
});
