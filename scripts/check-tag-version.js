#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function checkTagVersion(tag) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const actual = tag ?? process.env.GITHUB_REF_NAME;
  const expected = `v${packageJson.version}`;
  if (!actual) throw new Error(`A release tag is required; expected ${expected}.`);
  if (actual !== expected) throw new Error(`Release tag ${actual} does not match package version ${packageJson.version}; expected ${expected}.`);
  return { ok: true, tag: actual, package: packageJson.name, version: packageJson.version };
}

if (process.argv[1]?.endsWith("check-tag-version.js")) {
  try {
    console.log(JSON.stringify(checkTagVersion(process.argv[2]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
