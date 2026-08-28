import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeSetup } from "../../src/adapters/opencode/index.js";
import { mcpImageContent, sanitizeImagePayloads } from "../../src/adapters/mcp/server.js";

process.env.OPENCODE_BROWSER_MEMORY = "0";

const INLINE_SHOT = { mimeType: "image/png", base64: Buffer.from("hi").toString("base64"), fullPage: false, bytes: 2 };
const ARTIFACT_SHOT = { artifactId: "abc", uri: "browser://sessions/s/artifacts/abc", mimeType: "image/png", size: 2 };

function fakeRuntime({ artifactData } = {}) {
  return {
    artifacts: {
      read() {
        if (artifactData === undefined) return null;
        return { ...ARTIFACT_SHOT, data: artifactData };
      },
    },
    observe: async () => ({ ok: true, status: "observed", sessionId: "s", result: { ...ARTIFACT_SHOT } }),
    run: async () => ({ ok: true, status: "completed", sessionId: "s" }),
    session: async () => ({ ok: true, status: "ready", sessionId: "s" }),
    finalize: async () => ({ ok: true, status: "completed", sessionId: "s" }),
    close() {},
  };
}

async function registeredOpenCodeTools(runtime) {
  const registered = new Map();
  const context = { tools: { add: async (name, definition) => registered.set(name, definition) }, logger: { info() {} } };
  const dispose = await createOpenCodeSetup(context, { runtime });
  return { tools: registered, dispose };
}

test("inline screenshot results become OpenCode image attachments without base64 in text", async () => {
  const runtime = fakeRuntime();
  runtime.observe = async () => ({ ok: true, status: "observed", sessionId: "s", result: { ...INLINE_SHOT } });
  const { tools, dispose } = await registeredOpenCodeTools(runtime);
  try {
    const result = await tools.get("browser_observe").execute({ mode: "screenshot", delivery: "inline" }, {});
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].type, "file");
    assert.equal(result.attachments[0].mime, "image/png");
    assert.equal(result.attachments[0].url, `data:image/png;base64,${INLINE_SHOT.base64}`);
    assert.ok(!result.output.includes(INLINE_SHOT.base64), "base64 must not leak into the model-facing text");
    assert.equal(JSON.parse(result.output).result.base64Bytes, 2);
    assert.equal(result.structuredContent.result.base64, undefined);
  } finally {
    await dispose();
  }
});

test("artifact screenshot results become OpenCode image attachments read from the artifact store", async () => {
  const runtime = fakeRuntime({ artifactData: Buffer.from("hi") });
  const { tools, dispose } = await registeredOpenCodeTools(runtime);
  try {
    const result = await tools.get("browser_observe").execute({ mode: "screenshot" }, {});
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].url, `data:image/png;base64,${Buffer.from("hi").toString("base64")}`);
    assert.ok(result.output.includes("browser://sessions/s/artifacts/abc"));
  } finally {
    await dispose();
  }
});

test("screenshot artifacts promoted by run summaries also become attachments", async () => {
  const runtime = fakeRuntime({ artifactData: Buffer.from("hi") });
  runtime.run = async () => ({ ok: true, status: "completed", sessionId: "s", artifact: { ...ARTIFACT_SHOT } });
  const { tools, dispose } = await registeredOpenCodeTools(runtime);
  try {
    const result = await tools.get("browser_run").execute({ steps: [{ action: "screenshot" }] }, {});
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].filename, "screenshot.png");
  } finally {
    await dispose();
  }
});

test("non-image results never produce attachments", async () => {
  const runtime = fakeRuntime();
  const { tools, dispose } = await registeredOpenCodeTools(runtime);
  try {
    const result = await tools.get("browser_observe").execute({ mode: "capabilities" }, {});
    assert.equal(result.attachments, undefined);
  } finally {
    await dispose();
  }
});

test("MCP image content mirrors inline, artifact, and promoted screenshot payloads", () => {
  const runtime = fakeRuntime({ artifactData: Buffer.from("hi") });

  const inline = mcpImageContent({ ok: true, status: "observed", sessionId: "s", result: { ...INLINE_SHOT } }, runtime);
  assert.deepEqual(inline, [{ type: "image", data: INLINE_SHOT.base64, mimeType: "image/png" }]);

  const fromArtifact = mcpImageContent({ ok: true, status: "observed", sessionId: "s", result: { ...ARTIFACT_SHOT } }, runtime);
  assert.deepEqual(fromArtifact, [{ type: "image", data: Buffer.from("hi").toString("base64"), mimeType: "image/png" }]);

  const promoted = mcpImageContent({ ok: true, status: "completed", sessionId: "s", artifact: { ...ARTIFACT_SHOT } }, runtime);
  assert.deepEqual(promoted, [{ type: "image", data: Buffer.from("hi").toString("base64"), mimeType: "image/png" }]);

  assert.deepEqual(mcpImageContent({ ok: true, status: "completed", sessionId: "s" }, runtime), []);
});

test("payload sanitizers strip nested inline base64", () => {
  const sanitized = sanitizeImagePayloads({ ok: true, status: "observed", sessionId: "s", result: { ...INLINE_SHOT } });
  assert.equal(sanitized.result.base64, undefined);
  assert.equal(sanitized.result.base64Bytes, 2);
  assert.equal(sanitized.result.mimeType, "image/png");
});
