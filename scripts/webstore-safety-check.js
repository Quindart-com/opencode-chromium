#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionDir = path.join(root, "extension");
const outDir = path.join(root, "dist-extension");
const errors = [];

const NOJOB_EXTENSION_ID = "piojnjijlmddhnnamahoopgbjcbcobaa";
const EXPECTED_PERMISSIONS = [
  "alarms",
  "bookmarks",
  "debugger",
  "downloads",
  "downloads.ui",
  "favicon",
  "history",
  "nativeMessaging",
  "notifications",
  "readingList",
  "scripting",
  "sessions",
  "storage",
  "tabGroups",
  "tabs",
  "topSites",
];

function walk(directory, prefix) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, relative));
    else files.push({ relative, absolute });
  }
  return files;
}

const files = walk(extensionDir, "");
const entryNames = new Set(files.map((file) => file.relative));

const expectedEntries = new Set([
  "manifest.json",
  "popup.html",
  "src/background.js",
  "src/focus-policy.js",
  "src/popup.css",
  "src/popup.js",
  "content-scripts/cursor.js",
  "images/cursor-chat.png",
  "images/icon16.png",
  "images/icon32.png",
  "images/icon48.png",
  "images/icon128.png",
  "README.md",
]);
for (const entry of expectedEntries) {
  if (!entryNames.has(entry)) errors.push(`Extension zip is missing entry: ${entry}`);
}
for (const entry of entryNames) {
  if (/[.]tgz$|[.]pem$|[.]key$|[.]env$|package-lock[.]json$/.test(entry)) errors.push(`Forbidden entry in extension package: ${entry}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) errors.push("Extension must be Manifest V3");
if (manifest.name !== "opencode-chromium") errors.push(`Extension display name must be opencode-chromium: ${manifest.name}`);
if (manifest.version !== packageJson.version) errors.push(`Extension manifest version ${manifest.version} must match package version ${packageJson.version}`);
const permissions = [...(manifest.permissions ?? [])].sort();
const expected = [...EXPECTED_PERMISSIONS].sort();
if (JSON.stringify(permissions) !== JSON.stringify(expected)) {
  errors.push(`Unexpected permission set. Got: ${permissions.join(", ")}`);
}
if (JSON.stringify(manifest.host_permissions ?? []) !== JSON.stringify(["<all_urls>"])) {
  errors.push("host_permissions must be exactly [\"<all_urls>\"]");
}
if (manifest.key) errors.push("Extension must not ship a hardcoded key");
if (typeof manifest.background?.service_worker !== "string") errors.push("Background service worker missing");
if (typeof manifest.action?.default_popup !== "string") errors.push("Action popup missing");
for (const size of ["16", "32", "48", "128"]) {
  const icon = manifest.icons?.[size];
  if (typeof icon !== "string" || !entryNames.has(icon)) errors.push(`Missing icon ${size}: ${icon ?? "n/a"}`);
}

const suspiciousPatterns = [
  [/eval\s*\(/, "eval("],
  [/new\s+Function\s*\(/, "new Function("],
  [/document\.write\s*\(/, "document.write("],
  [/https?:\/\/localhost/i, "localhost URL"],
  [/127\.0\.0\.1/, "127.0.0.1 reference"],
];
for (const file of files) {
  if (!/\.(js|html|css|json)$/.test(file.relative)) continue;
  const content = fs.readFileSync(file.absolute, "utf8");
  for (const [pattern, label] of suspiciousPatterns) {
    const match = pattern.exec(content);
    if (match) errors.push(`${file.relative} contains ${label}`);
  }
}

const zipName = `opencode-chromium-${packageJson.version}-chrome.zip`;
const zipPath = path.join(outDir, zipName);
if (!fs.existsSync(zipPath)) errors.push(`Extension zip not found: ${zipName} (run bun run zip:extension)`);

const expectedId = process.env.CHROME_EXTENSION_ID ?? "";
if (expectedId) {
  if (expectedId === NOJOB_EXTENSION_ID) errors.push("Refusing: CHROME_EXTENSION_ID is the nojob extension ID");
  if (!/^[a-p]{32}$/.test(expectedId)) errors.push(`CHROME_EXTENSION_ID is not a valid Chrome extension ID: ${expectedId}`);
  console.log(JSON.stringify({ ok: errors.length === 0, checks: [...errors], extensionId: expectedId, zip: zipName }, null, 2));
} else {
  console.log(JSON.stringify({ ok: errors.length === 0, checks: [...errors], zip: zipName }, null, 2));
}

if (errors.length > 0) process.exit(1);