#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const errors = [];

if (packageJson.name !== "opencode-browser-plugin") errors.push(`Unexpected package name: ${packageJson.name}`);
if (packageJson.version !== "1.2.0") errors.push(`Expected release version 1.2.0, found ${packageJson.version}`);
if (packageJson.packageManager?.startsWith("bun@") !== true) errors.push("packageManager must pin Bun");
if (packageJson.exports?.["."] !== "./dist/adapters/opencode/index.js") errors.push("Package root must export the native OpenCode adapter");
if (packageJson.bin?.["opencode-browser-plugin-mcp"] !== "./dist/adapters/mcp/server.js") errors.push("MCP binary is not canonical");

const forbidden = [["opencode", "plugin"].join("-"), ["browser", "core"].join("-"), ["codex", "adapter"].join("-"), ".opencode", "package-lock.json", ["scripts", "install-opencode.js"].join("/"), ["scripts", "check-opencode-plugin.js"].join("/")];
const excluded = new Set(["node_modules", ".git", "dist", "reports"]);
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else {
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (forbidden.some((needle) => relative.includes(needle))) errors.push(`Forbidden legacy path remains: ${relative}`);
      if (/[.]tgz$/.test(relative)) {
        try {
          execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root, stdio: "ignore" });
          errors.push(`Release tarball should not be committed: ${relative}`);
        } catch {
          // Local tarballs produced by `bun pm pack` are harmless; only tracked archives fail the gate.
        }
      }
    }
  }
}
walk(root);
for (const relative of ["dist/core/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "dist/cli/index.js", "skills/opencode-browser-plugin/SKILL.md", "skills/opencode-browser-plugin/agents/openai.yaml"]) {
  if (!fs.existsSync(path.join(root, relative))) errors.push(`Missing release file: ${relative}`);
}

const packOutput = execFileSync(process.execPath, ["pm", "pack", "--dry-run", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
for (const needle of [["opencode", "plugin"].join("-") + "/", ["browser", "core"].join("-") + "/", ["codex", "adapter"].join("-") + "/", ".opencode/", "package-lock.json", "scripts/extension-id.json", "native-host/test/"]) {
  if (packOutput.includes(needle)) errors.push(`Packed artifact contains forbidden path: ${needle}`);
}
for (const required of ["dist/core/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "dist/cli/index.js", "extension/manifest.json", "native-host/src/host.js", "skills/opencode-browser-plugin/SKILL.md", "skills/opencode-browser-plugin/agents/openai.yaml"]) {
  if (!packOutput.includes(required)) errors.push(`Packed artifact is missing: ${required}`);
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, package: packageJson.name, version: packageJson.version }, null, 2));
