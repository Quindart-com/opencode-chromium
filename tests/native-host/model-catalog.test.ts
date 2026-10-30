import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localModelCatalog,validateLocalModelCatalog } from "../../native-host/src/model-catalog.ts";
import { SEMANTIC_MODELS } from "../../native-host/src/semantic-models.ts";
import { semanticModelFor,semanticStatus,setSemanticSettings } from "../../native-host/src/semantic-search.ts";
import { VISUAL_MODELS,setVisualSettings,visualStatus } from "../../native-host/src/visual-map.ts";

test("local catalogs add selectable embedding, deep retrieval and visual models without replacing built-in adapters or downloading anything", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-model-catalog-"));
  const keys = ["OPENCODE_BROWSER_MODEL_CATALOG", "OPENCODE_BROWSER_SEMANTIC_DIR", "OPENCODE_BROWSER_VISUAL_DIR"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const { default: _default, ...adaptive } = structuredClone(SEMANTIC_MODELS[0]!);
    const deep = structuredClone(SEMANTIC_MODELS.find(model => model.role === "deep")!);
    const visual = structuredClone(VISUAL_MODELS[0]!);
    const catalog = { semantic: [{ ...adaptive, id: "custom-embedding", label: "Custom embedding" }, { ...deep, id: "custom-deep", label: "Custom deep" }], visual: [{ ...visual, id: "custom-visual", label: "Custom visual" }] };
    const file = path.join(root, "catalog.json"); fs.writeFileSync(file, JSON.stringify(catalog));
    process.env.OPENCODE_BROWSER_MODEL_CATALOG = file;
    process.env.OPENCODE_BROWSER_SEMANTIC_DIR = path.join(root, "semantic");
    process.env.OPENCODE_BROWSER_VISUAL_DIR = path.join(root, "visual");
    const status = setSemanticSettings({ enabled: false, modelId: "custom-embedding", deepModelId: "custom-deep" });
    expect(status.settings).toMatchObject({ modelId: "custom-embedding", deepModelId: "custom-deep" });
    expect(semanticModelFor(status.settings.deepModelId).id).toBe("custom-deep");
    expect(status.catalogStatus).toBe("custom");
    expect(status.models.length).toBe(SEMANTIC_MODELS.length + 2);
    expect(setVisualSettings({ enabled: false, modelId: "custom-visual" }).settings.modelId).toBe("custom-visual");
    expect(fs.readdirSync(path.join(root, "semantic/models"))).toEqual([]);
    expect(fs.readdirSync(path.join(root, "visual/models"))).toEqual([]);
    catalog.semantic.push({ ...adaptive, label: "Attempted replacement" });
    fs.writeFileSync(file, JSON.stringify(catalog)); fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    expect(semanticStatus().models.find(model => model.id === adaptive.id)?.label).toBe(adaptive.label);
    fs.writeFileSync(file, "invalid JSON");
    expect(localModelCatalog().status).toBe("invalid_custom_catalog");
    expect(semanticStatus().models.length).toBe(SEMANTIC_MODELS.length);
    expect(visualStatus().settings.modelId).toBe(VISUAL_MODELS[0]!.id);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir())); expect(path.basename(root)).toStartWith("local-model-catalog-");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog validation rejects duplicate IDs, incompatible dimensions, missing deep rerankers, paths and arbitrary model URLs", () => {
  const { default: _default, ...model } = structuredClone(SEMANTIC_MODELS[0]!);
  expect(() => validateLocalModelCatalog({ semantic: [model, model] })).toThrow();
  expect(() => validateLocalModelCatalog({ semantic: [{ ...model, dimensions: 777 }] })).toThrow();
  expect(() => validateLocalModelCatalog({ semantic: [{ ...model, role: "deep" }] })).toThrow();
  expect(() => validateLocalModelCatalog({ semantic: [{ ...model, id: "../outside" }] })).toThrow();
  expect(() => validateLocalModelCatalog({ semantic: [{ ...model, embedding: { ...model.embedding, id: "https://example.test/model" } }] })).toThrow();
});
