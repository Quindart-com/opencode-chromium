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
    assert.equal(status.settings.version, 5);
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

  assert.equal(result.models.length, 4);
  const byId = Object.fromEntries(result.models.map((model) => [model.id, model]));
  assert.equal(result.models[0].id, "snowflake-arctic-embed-xs");
  assert.equal(result.models[0].dimensions, 384);
  assert.equal(result.models[1].id, "snowflake-arctic-embed-m");
  assert.equal(result.models[1].dimensions, 768);
  assert.equal(result.models[1].embedding.id, "Snowflake/snowflake-arctic-embed-m");
  const qwen = byId["qwen3-0.6b-retrieval"];
  assert.ok(qwen, "Qwen3 deep model must remain in the registry");
  assert.equal(qwen.role, "deep");
  assert.ok(qwen.embedding.id.includes("Qwen3-Embedding"));
  assert.ok(qwen.reranker.id.includes("Qwen3-Reranker"));
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

function embeddingGemma() {
  return handleSemanticHostMethod("semantic.listModels", {}).then((result) => result.models.find((model) => model.id === "embeddinggemma-300m"));
}

test("EmbeddingGemma is an adaptive model that can never become the deep strategy", async () => {
  const gemma = await embeddingGemma();

  assert.ok(gemma, "EmbeddingGemma must appear in the model registry");
  assert.equal(gemma.role, "adaptive");
  assert.equal(gemma.id, "embeddinggemma-300m");
  assert.equal(gemma.embedding.id, "onnx-community/embeddinggemma-300m-ONNX");
  assert.notEqual(gemma.id, "qwen3-0.6b-retrieval");
});

test("EmbeddingGemma supports q4 and q8 only and rejects fp16", async () => {
  const gemma = await embeddingGemma();

  assert.deepEqual(gemma.supportedDtypes, ["q4", "q8"]);
  assert.equal(gemma.supportedDtypes.includes("fp16"), false);
  assert.equal(gemma.embedding.dtype, "q4");
});

test("EmbeddingGemma MRL dimensions are restricted and 256 is the default", async () => {
  const gemma = await embeddingGemma();

  assert.deepEqual(gemma.supportedDimensions, [128, 256, 512, 768]);
  assert.equal(gemma.defaultDimensions, 256);
  assert.equal(gemma.dimensions, 256);
  assert.equal(gemma.nativeDimensions, 768);
});

test("MRL truncation returns the requested length and re-normalizes", async () => {
  const { truncateAndRenormalize } = await import("../../native-host/src/semantic-search.js");
  const vector = Array.from({ length: 768 }, (_, index) => (index % 2 === 0 ? 0.5 : -0.25));

  const truncated = truncateAndRenormalize(vector, 256);

  assert.equal(truncated.length, 256);
  const norm = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `expected unit norm, got ${norm}`);
  assert.deepEqual(truncateAndRenormalize(vector, 768).length, 768);
  assert.deepEqual(truncateAndRenormalize(vector, 2048).length, 768);
});

test("EmbeddingGemma uses distinct query and document prompts", async () => {
  const gemma = await embeddingGemma();

  assert.ok(gemma.embedding.queryPrefix.startsWith("task: search result"));
  assert.ok(gemma.embedding.documentPrefix.startsWith("title:"));
  assert.notEqual(gemma.embedding.queryPrefix, gemma.embedding.documentPrefix);
  assert.equal(gemma.embedding.promptVersion, "prompt-v1");
});

test("EmbeddingGemma reads the exported sentence embedding instead of token features", () => {
  const source = fs.readFileSync(path.resolve("native-host", "src", "semantic-search.js"), "utf8");
  assert.match(source, /AutoModel\.from_pretrained\(model\.embedding\.id/);
  assert.match(source, /outputs\?\.sentence_embedding/);
  assert.doesNotMatch(source, /adapter === "embeddinggemma"[\s\S]{0,300}pooling: "none"/);
});

test("embedding profiles encode model, dtype, dimensions, and prompt version", async () => {
  const { embeddingProfileFor } = await import("../../native-host/src/semantic-search.js");
  const gemma = await embeddingGemma();

  assert.equal(embeddingProfileFor(gemma), "embeddinggemma-300m:q4:d256:prompt-v1");
  const wide = { ...gemma, embedding: { ...gemma.embedding, dimensions: 768 } };
  assert.equal(embeddingProfileFor(wide), "embeddinggemma-300m:q4:d768:prompt-v1");
  const snowflake = await handleSemanticHostMethod("semantic.listModels", {}).then((result) => result.models[0]);
  assert.notEqual(embeddingProfileFor(snowflake), embeddingProfileFor(gemma));
});

test("embedding dimension settings validate against the active model and persist", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-dims-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    const accepted = setSemanticSettings({ enabled: true, modelId: "embeddinggemma-300m", embeddingDims: 512 });
    assert.equal(accepted.settings.modelId, "embeddinggemma-300m");
    assert.equal(accepted.settings.embeddingDims, 512);

    const rejected = setSemanticSettings({ enabled: true, modelId: "embeddinggemma-300m", embeddingDims: 96 });
    assert.equal(rejected.settings.embeddingDims, 512, "invalid dimensions must be rejected while retaining the previous value");

    const status = await handleSemanticHostMethod("semantic.status", {});
    const gemma = status.models.find((model) => model.id === "embeddinggemma-300m");
    assert.equal(gemma.dimensions, 512, "status must report the configured effective dimensions");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
    else process.env.OPENCODE_BROWSER_SEMANTIC_DIR = previous;
  }
});
