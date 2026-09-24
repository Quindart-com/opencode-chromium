import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// A deterministic fingerprint of everything that feeds `dist`. The build
// records it, and the launchers compare it before starting, so a branch switch
// or an uncommitted edit can never leave a stale bundle silently serving an
// agent. Paths are normalized to "/" so the same tree hashes identically on
// every OS.
const SOURCE_ROOTS = ["src", "native-host/src"];
const SKIP = new Set(["node_modules", ".git"]);

function collect(root, relative, files) {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
    if (SKIP.has(entry.name)) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) collect(root, child, files);
    else files.push(child);
  }
}

export function sourceFileList(root) {
  const files = [];
  for (const source of SOURCE_ROOTS) collect(root, source, files);
  return files.sort();
}

export function sourceFingerprint(root = process.cwd()) {
  const hash = createHash("sha256");
  // The published version is part of the contract that agents read back, so a
  // version bump alone must invalidate a build.
  try {
    hash.update("package.json").update(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "");
  } catch {
    // A tree without package.json still hashes its sources.
  }
  for (const relative of sourceFileList(root)) {
    hash.update(relative).update(fs.readFileSync(path.join(root, relative)));
  }
  return hash.digest("hex");
}

export function readBuildManifest(root = process.cwd()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "dist", "build-manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

export function buildStatus(root = process.cwd()) {
  const manifest = readBuildManifest(root);
  if (!manifest) return { built: false, stale: true, builtAt: null, version: null, expected: sourceFingerprint(root) };
  const expected = sourceFingerprint(root);
  return {
    built: true,
    // A build without sourceSha256 predates this check and cannot be trusted.
    stale: manifest.sourceSha256 !== expected,
    builtAt: manifest.generatedAt ?? null,
    version: manifest.version ?? null,
    expected,
  };
}
