import { test,expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function linkedInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-entrypoints-"));
  const alias = path.join(root, "linked-install");
  fs.symlinkSync(process.cwd(), alias, process.platform === "win32" ? "junction" : "dir");
  return { root, alias, close() {
    if (!fs.lstatSync(alias).isSymbolicLink()) throw new Error("Unexpected fixture link");
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test("packaged MCP help starts through a linked installation directory", () => {
  const fixture = linkedInstall();
  try {
    const output = execFileSync("node", [path.join(fixture.alias, "dist/adapters/mcp/server.js"), "--help"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    expect(output).toContain("Usage: opencode-chromium-mcp");
  } finally { fixture.close(); }
});

test("activation coordinator starts through a linked installation directory", () => {
  const fixture = linkedInstall();
  try {
    const dir = path.join(fixture.root, "runtime"), next = path.join(fixture.root, "release"), version = "1.0.1";
    fs.mkdirSync(dir);
    fs.mkdirSync(next);
    fs.writeFileSync(path.join(next, "package.json"), JSON.stringify({ name: "opencode-chromium", version }));
    for (const file of ["dist/cli/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "native-host/dist/runtime.js", "extension/manifest.json", "extension-firefox/manifest.json"]) {
      const target = path.join(next, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.endsWith(".json") ? JSON.stringify({ version }) : "// fixture");
    }
    fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ root: path.join(fixture.root, "initial"), version: "1.0.0", autoUpdate: true }));
    const result = path.join(dir, "result.json");
    execFileSync("node", [path.join(fixture.alias, "native-host/dist/runtime-coordinator.js"), dir, next, version, result], {
      timeout: 15000, windowsHide: true,
      env: { ...process.env, OPENCODE_BROWSER_RUNTIME_DIR: dir, AGENT_BROWSER_PROFILE_REGISTRY_DIR: path.join(dir, "profiles"), OPENCODE_BROWSER_PROFILE_REGISTRY_DIR: path.join(dir, "profiles") },
    });
    expect(fs.existsSync(result)).toBe(true);
    expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({ activated: true });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")).version).toBe(version);
  } finally { fixture.close(); }
});
