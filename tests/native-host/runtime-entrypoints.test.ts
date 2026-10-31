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
