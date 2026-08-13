#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionDir = path.join(root, "extension");
const outDir = path.join(root, "dist-extension");
const manifestPath = path.join(extensionDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.manifest_version !== 3) throw new Error("Extension must be Manifest V3");
if (manifest.name !== "opencode-chromium") throw new Error(`Extension display name must be opencode-chromium: ${manifest.name}`);
if (manifest.version !== packageJson.version) {
  throw new Error(`Extension manifest version ${manifest.version} must match package version ${packageJson.version}`);
}

const zipName = `opencode-chromium-${packageJson.version}-chrome.zip`;
const zipPath = path.join(outDir, zipName);
fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

const zip = new yazl.ZipFile();
const entries = [];

function collect(directory, prefix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(absolute, relative);
    } else {
      entries.push(relative);
      zip.addFile(absolute, relative);
    }
  }
}

collect(extensionDir, "");

await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(zipPath);
  output.on("error", reject);
  zip.outputStream.on("error", reject);
  zip.outputStream.pipe(output).on("close", resolve);
  zip.end();
});

console.log(JSON.stringify({ ok: true, zip: path.relative(root, zipPath), version: packageJson.version, files: entries.length, entries }, null, 2));