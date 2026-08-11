#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const contentChecks = [
  { name: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: "local home path", pattern: /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:Users|home)\/)/i },
  { name: "npm credential", pattern: /(?:npm_[A-Za-z0-9_-]{20,}|\/\/registry\.npmjs\.org\/:_authToken=)/i },
  { name: "GitHub credential", pattern: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/i },
  { name: "private key", pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/i },
];
const forbiddenPackagePath = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|reports\/|tests\/|node_modules\/|scripts\/extension-id\.json|.*\.tgz$)/i;

function readTrackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
}

function scanText(relative, text, findings) {
  for (const check of contentChecks) if (check.pattern.test(text)) findings.push(`${relative}: contains a ${check.name}`);
}

function packFiles() {
  const output = execFileSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_PROVENANCE: "false" },
  });
  const jsonStart = output.indexOf("[");
  if (jsonStart === -1) throw new Error("npm pack did not return JSON output");
  const result = JSON.parse(output.slice(jsonStart));
  return result.flatMap((entry) => entry.files ?? []).map((entry) => entry.path).filter(Boolean);
}

const findings = [];
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const field of ["author", "contributors", "maintainers"]) {
  if (packageJson[field] !== undefined) findings.push(`package.json: contains personal ${field} metadata`);
}
const tracked = readTrackedFiles();
for (const relative of tracked) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) continue;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  scanText(relative, buffer.toString("utf8"), findings);
}

const packaged = packFiles();
for (const relative of packaged) {
  if (forbiddenPackagePath.test(relative)) findings.push(`npm package contains forbidden path: ${relative}`);
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) continue;
  const buffer = fs.readFileSync(absolute);
  if (!buffer.includes(0)) scanText(`package/${relative}`, buffer.toString("utf8"), findings);
}

if (findings.length > 0) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, trackedFiles: tracked.length, packageFiles: packaged.length }, null, 2));
