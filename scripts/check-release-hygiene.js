#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = "scripts/check-release-hygiene.js";

function command(name, args) {
  const executable = process.platform === "win32" && name === "npm" ? "npm.cmd" : name;
  return execFileSync(executable, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" }).trim();
}

function trackedFiles() {
  const output = command("git", ["ls-files", "-co", "--exclude-standard", "-z"]);
  return output ? output.split("\0").filter(Boolean) : [];
}

function packageFiles() {
  const payload = JSON.parse(command("npm", ["pack", "--dry-run", "--json"]));
  const files = payload[0]?.files;
  if (!Array.isArray(files)) throw new Error("npm pack did not return a file manifest");
  return files.map((entry) => entry.path).filter((value) => typeof value === "string");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const packaged = packageFiles();
const packageViolations = packaged.filter((file) => /(^|\/)(?:node_modules|\.git)(\/|$)|(^|\/)(?:package-lock\.json|\.env(?:\.|$)|extension-id\.json|[^/]+\.tgz)$/i.test(file));
const localIdentifiers = [
  os.userInfo().username,
  process.env.USERNAME,
  process.env.USER,
  os.hostname(),
  process.env.COMPUTERNAME,
].filter((value) => typeof value === "string" && value.length >= 3);
const sourcePatterns = [
  { name: "absolute Windows user path", pattern: /[A-Za-z]:[\\/]Users[\\/][^\\/\s]+[\\/]/i },
  { name: "absolute Unix user path", pattern: /(?:^|[^\w])\/(?:Users|home)\/[^/\s]+(?:\/|$)/i },
  { name: "private email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: "credential or token marker", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----/i },
  { name: "hardware fingerprint", pattern: /PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS|Ryzen\s+\d|Core\s+i[3579]|MacBook|iPhone|Android/i },
];
for (const identifier of localIdentifiers) {
  sourcePatterns.push({ name: "local identifier", pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(identifier)}(?![A-Za-z0-9])`, "i") });
}

const violations = packageViolations.map((file) => `package file: ${file}`);
const files = trackedFiles();
for (const relative of files) {
  if (relative === checkerPath) continue;
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).size > 2_000_000) continue;
  const data = fs.readFileSync(absolute);
  if (data.includes(0)) continue;
  const text = data.toString("utf8");
  for (const { name, pattern } of sourcePatterns) {
    if (pattern.test(text)) violations.push(`${name}: ${relative}`);
  }
}

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  scannedFiles: files.length,
  packageFiles: packaged.length,
  excludedLocalState: ["scripts/extension-id.json"],
}, null, 2));
