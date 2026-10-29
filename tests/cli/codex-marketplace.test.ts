import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectProjectBrowserPlugin } from "../../src/cli/codex-marketplace.ts";

test("doctor finds an older project listing from a nested directory without changing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-project-catalog-"));
  try {
    fs.mkdirSync(path.join(root, ".agents/plugins"), { recursive: true });
    fs.mkdirSync(path.join(root, "browser/.codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/nested"), { recursive: true });
    const catalog = path.join(root, ".agents/plugins/marketplace.json");
    const manifest = path.join(root, "browser/.codex-plugin/plugin.json");
    fs.writeFileSync(catalog, JSON.stringify({ name: "quindart-browser", plugins: [{ name: "opencode-browser-plugin", source: { source: "local", path: "./browser" } }] }));
    fs.writeFileSync(manifest, JSON.stringify({ name: "opencode-browser-plugin", version: "1.9.4" }));
    const before = fs.readFileSync(manifest, "utf8");
    const health = inspectProjectBrowserPlugin("1.10.0", path.join(root, "src/nested"));
    expect(health).toMatchObject({ ok: false, pluginVersion: "1.9.4", runtimeVersion: "1.10.0", manifestPath: manifest });
    expect(health?.message).toContain("Updating npm does not update the project catalog");
    expect(health?.updateCommand).toBe("codex plugin marketplace upgrade quindart-browser");
    expect(inspectProjectBrowserPlugin("1.9.4", root)?.ok).toBe(true);
    expect(fs.readFileSync(manifest, "utf8")).toBe(before);

    fs.writeFileSync(catalog, JSON.stringify({ plugins: [{ name: "unrelated", source: "./browser" }] }));
    expect(inspectProjectBrowserPlugin("1.10.0", root)).toBeNull();
    fs.writeFileSync(catalog, "{broken");
    expect(inspectProjectBrowserPlugin("1.10.0", root)).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a remote catalog entry is not mistaken for the local checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-remote-catalog-"));
  try {
    fs.mkdirSync(path.join(root, ".agents/plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({ plugins: [{ name: "opencode-browser-plugin", source: { source: "url", url: "https://example.com/plugin.git" } }] }));
    expect(inspectProjectBrowserPlugin("1.10.0", root)).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
