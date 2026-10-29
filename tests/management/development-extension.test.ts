import { test,expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { developmentExtensionSource,publishDevelopmentExtension } from "../../src/management/development-extension.ts";

test("refreshing an old unpacked extension rebuilds current sources, preserves its path and leaves production selection intact", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dev-extension-check-")), root = path.join(base, "repo"), dir = path.join(base, "runtime");
  fs.mkdirSync(path.join(root, "extension-src"), { recursive: true }); fs.mkdirSync(path.join(dir, "extension"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opencode-chromium", version: "1.10.1" }));
  fs.writeFileSync(path.join(dir, "extension", "manifest.json"), JSON.stringify({ name: "opencode-chromium", version: "1.9.4" }));
  fs.writeFileSync(path.join(dir, "runtime.json"), '{"root":"production","version":"1.10.1"}');
  let builds = 0;
  const build = () => { builds++; fs.mkdirSync(path.join(root, "extension"), { recursive: true }); fs.writeFileSync(path.join(root, "extension/manifest.json"), JSON.stringify({ name: "opencode-chromium", version: "1.10.1" })); fs.writeFileSync(path.join(root, "extension/background.js"), "fresh build"); };
  try {
    await publishDevelopmentExtension({ root, dir, dryRun: true, build }); expect(builds).toBe(0);
    const result = await publishDevelopmentExtension({ root, dir, build });
    expect(result.extensionPath).toBe(path.join(dir, "extension")); expect(result.version).toBe("1.10.1");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "extension/manifest.json"), "utf8")).version_name).toContain("1.10.1 dev");
    expect(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")).toBe('{"root":"production","version":"1.10.1"}');
    expect(developmentExtensionSource(dir)).toBe(root);
    await expect(publishDevelopmentExtension({ root, dir, output: root, build })).rejects.toThrow("source checkout");
    const unrelated = path.join(base, "other"); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, "document.txt"), "keep");
    await expect(publishDevelopmentExtension({ root, dir, output: unrelated, build })).rejects.toThrow("not an existing OpenCode");
    expect(fs.readFileSync(path.join(unrelated, "document.txt"), "utf8")).toBe("keep");
    await expect(publishDevelopmentExtension({ root, dir, build: () => { throw new Error("build failed"); } })).rejects.toThrow("build failed");
    expect(fs.readFileSync(path.join(dir, "extension/background.js"), "utf8")).toBe("fresh build");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
