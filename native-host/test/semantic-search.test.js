import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deleteSemanticModel, handleSemanticHostMethod, rankPageUnits, semanticDataDir, setSemanticSettings } from "../src/semantic-search.js";

test("persists semantic settings in configured local directory", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    const status = setSemanticSettings({ enabled: true, modelId: "qwen3-0.6b-retrieval" });

    assert.equal(semanticDataDir(), dir);
    assert.equal(status.settings.enabled, true);
    assert.equal(status.settings.version, 3);
    assert.equal(status.settings.strategy, "auto");
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

test("semantic host method returns model metadata", async () => {
  const result = await handleSemanticHostMethod("semantic.listModels", {});

  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].id, "snowflake-arctic-embed-xs");
  assert.equal(result.models[0].dimensions, 384);
  assert.equal(result.models[1].id, "qwen3-0.6b-retrieval");
  assert.ok(result.models[1].embedding.id.includes("Qwen3-Embedding"));
  assert.ok(result.models[1].reranker.id.includes("Qwen3-Reranker"));
  assert.ok(result.models[0].benchmark.value);
});

test("legacy model settings migrate to adaptive retrieval while retaining Qwen for deep search", async () => {
  const previous = process.env.OPENCODE_BROWSER_SEMANTIC_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-semantic-test-"));
  process.env.OPENCODE_BROWSER_SEMANTIC_DIR = dir;

  try {
    const status = setSemanticSettings({ enabled: true, modelId: "Xenova/bge-small-en-v1.5" });

    assert.equal(status.settings.modelId, "snowflake-arctic-embed-xs");
    assert.equal(status.settings.deepModelId, "qwen3-0.6b-retrieval");
    assert.equal(status.settings.strategy, "auto");
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
