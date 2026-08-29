import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deleteSemanticModel, handleSemanticHostMethod, rankPageUnits, semanticDataDir, setSemanticSettings } from "../../native-host/src/semantic-search.js";

test("persists semantic settings in configured local directory", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    const status = setSemanticSettings({ enabled: true, modelId: "qwen3-0.6b-retrieval" });

    assert.equal(semanticDataDir(), dir);
    assert.equal(status.settings.enabled, true);
    assert.equal(status.settings.version, 4);
    assert.equal(status.settings.strategy, "semantic");
    assert.equal(status.settings.modelId, "snowflake-arctic-embed-xs");
    assert.equal(status.settings.deepModelId, "qwen3-0.6b-retrieval");
    assert.equal(fs.existsSync(path.join(dir, "settings.json")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
  }
});

test("lexical page-unit ranking works without loading a model", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    setSemanticSettings({ enabled: false, modelId: "qwen3-0.6b-retrieval" });

    const result = await rankPageUnits({
      query: "delete repository danger zone",
      mode: "lexical",
      units: [
        { node_id: "node-1", kind: "button", text: "Save changes", interactive: true },
        { node_id: "node-2", kind: "button", text: "Delete this repository", headingPath: ["Danger Zone"], interactive: true },
      ],
    });

    assert.equal(result.model.used, false);
    assert.equal(result.results[0].node_id, "node-2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
  }
});

test("semantic is the default ranking strategy while lexical remains explicit", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const previousDisabled = process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-default-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;
  process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = "1";

  try {
    setSemanticSettings({ enabled: true });
    const semantic = await rankPageUnits({
      query: "workspace members",
      units: [{ node_id: "node-1", text: "Workspace member permissions" }],
    });
    const lexical = await rankPageUnits({
      query: "workspace members",
      mode: "lexical",
      units: [{ node_id: "node-1", text: "Workspace member permissions" }],
    });

    assert.equal(semantic.searchStrategy, "semantic");
    assert.equal(semantic.deprecatedAlias, false);
    assert.equal(semantic.degraded, true);
    assert.equal(lexical.searchStrategy, "lexical");
    assert.equal(lexical.model.used, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
    if (previousDisabled === undefined) delete process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
    else process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = previousDisabled;
  }
});

test("snowflake remains a deprecated alias for the semantic strategy", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const previousDisabled = process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-alias-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;
  process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = "1";

  try {
    setSemanticSettings({ enabled: true });
    const aliased = await rankPageUnits({
      query: "workspace members",
      mode: "snowflake",
      units: [{ node_id: "node-1", text: "Workspace member permissions" }],
    });

    assert.equal(aliased.searchStrategy, "semantic");
    assert.equal(aliased.deprecatedAlias, true);
    assert.equal(aliased.degraded, true);
    assert.equal(aliased.degradationReason, "model-unavailable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
    if (previousDisabled === undefined) delete process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
    else process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = previousDisabled;
  }
});

test("semantic host method returns model metadata", async () => {
  const result = await handleSemanticHostMethod("semantic.listModels", {});

  assert.equal(result.models.length, 3);
  assert.equal(result.models[0].id, "snowflake-arctic-embed-xs");
  assert.equal(result.models[0].dimensions, 384);
  assert.equal(result.models[1].id, "snowflake-arctic-embed-m");
  assert.equal(result.models[1].dimensions, 768);
  assert.equal(result.models[1].embedding.id, "Snowflake/snowflake-arctic-embed-m");
  assert.equal(result.models[2].id, "qwen3-0.6b-retrieval");
  assert.ok(result.models[2].embedding.id.includes("Qwen3-Embedding"));
  assert.ok(result.models[2].reranker.id.includes("Qwen3-Reranker"));
  assert.ok(result.models[0].benchmark.value);
});

test("any adaptive model can be selected as the active retrieval model while deep stays fixed", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const previousDisabled = process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-active-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;
  process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = "1";

  try {
    const status = setSemanticSettings({ enabled: true, modelId: "snowflake-arctic-embed-m" });
    assert.equal(status.settings.modelId, "snowflake-arctic-embed-m");

    const ranked = await rankPageUnits({
      query: "workspace members",
      units: [{ node_id: "node-1", text: "Workspace member permissions" }],
    });
    assert.equal(ranked.model.id, "snowflake-arctic-embed-m");

    const rejected = setSemanticSettings({ enabled: true, modelId: "qwen3-0.6b-retrieval" });
    assert.equal(rejected.settings.modelId, "snowflake-arctic-embed-m");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
    if (previousDisabled === undefined) delete process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
    else process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = previousDisabled;
  }
});

test("legacy model settings migrate to Snowflake-default retrieval while retaining Qwen for deep search", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    const status = setSemanticSettings({ enabled: true, modelId: "Xenova/bge-small-en-v1.5" });

    assert.equal(status.settings.modelId, "snowflake-arctic-embed-xs");
    assert.equal(status.settings.deepModelId, "qwen3-0.6b-retrieval");
    assert.equal(status.settings.strategy, "semantic");
    assert.equal(status.settings.enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
  }
});

test("model failure degrades to useful lexical results", async () => {
  const previousDir = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const previousDisabled = process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;
  process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = "1";
  try {
    setSemanticSettings({ enabled: true });
    const result = await rankPageUnits({
      query: "member access",
      mode: "auto",
      units: [
        { node_id: "node-1", text: "Billing details" },
        { node_id: "node-2", text: "Workspace member permission" },
        { node_id: "node-3", text: "Workspace settings" },
      ],
    });
    assert.equal(result.degraded, true);
    assert.equal(result.mode, "lexical");
    assert.equal(result.results[0].node_id, "node-2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previousDir;
    if (previousDisabled === undefined) delete process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL;
    else process.env.OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL = previousDisabled;
  }
});

test("delete semantic model removes cached embedding and reranker directories", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    setSemanticSettings({ enabled: true, modelId: "qwen3-0.6b-retrieval" });
    const embeddingDir = path.join(dir, "models", "onnx-community", "Qwen3-Embedding-0.6B-ONNX");
    const rerankerDir = path.join(dir, "models", "onnx-community", "Qwen3-Reranker-0.6B-ONNX");
    fs.mkdirSync(embeddingDir, { recursive: true });
    fs.mkdirSync(rerankerDir, { recursive: true });
    fs.writeFileSync(path.join(embeddingDir, "marker"), "x");
    fs.writeFileSync(path.join(rerankerDir, "marker"), "x");

    const status = await deleteSemanticModel("qwen3-0.6b-retrieval");

    assert.equal(fs.existsSync(embeddingDir), false);
    assert.equal(fs.existsSync(rerankerDir), false);
    assert.equal(status.deleted.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
  }
});

test("semantic status and model listing never expose the raw cache path", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    setSemanticSettings({ enabled: true, modelId: "snowflake-arctic-embed-xs" });

    const status = await handleSemanticHostMethod("semantic.status");
    assert.equal(status.cacheDir, undefined);
    assert.equal(status.cache?.kind, "local");

    const listing = await handleSemanticHostMethod("semantic.listModels");
    assert.equal(listing.cacheDir, undefined);
    assert.equal(listing.cache?.kind, "local");

    const diagnostics = await handleSemanticHostMethod("semantic.cacheDiagnostics");
    assert.equal(typeof diagnostics.cacheDir, "string");
    assert.equal(path.dirname(diagnostics.cacheDir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
  }
});
