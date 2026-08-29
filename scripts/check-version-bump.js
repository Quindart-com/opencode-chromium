#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function compareVersions(first, second) {
  const left = SEMVER.exec(first ?? "");
  const right = SEMVER.exec(second ?? "");
  if (!left || !right) throw new Error(`Both versions must be valid SemVer values: ${first}, ${second}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const leftPre = left[4]?.split(".") ?? [];
  const rightPre = right[4]?.split(".") ?? [];
  if (leftPre.length === 0 || rightPre.length === 0) return leftPre.length === rightPre.length ? 0 : leftPre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    if (leftPre[index] === undefined) return -1;
    if (rightPre[index] === undefined) return 1;
    if (leftPre[index] === rightPre[index]) continue;
    const leftNumeric = /^\d+$/.test(leftPre[index]);
    const rightNumeric = /^\d+$/.test(rightPre[index]);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftPre[index]) - Number(rightPre[index]));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPre[index] < rightPre[index] ? -1 : 1;
  }
  return 0;
}

export function checkVersionBump(previous, current) {
  if (previous === current) return { shouldRelease: false, previous, version: current, tag: `v${current}` };
  if (compareVersions(current, previous) <= 0) {
    throw new Error(`Package version must increase on the release branch (${previous} -> ${current}).`);
  }
  return { shouldRelease: true, previous, version: current, tag: `v${current}` };
}

function packageVersionAt(ref) {
  const content = execFileSync("git", ["show", `${ref}:package.json`], { cwd: root, encoding: "utf8" });
  return JSON.parse(content).version;
}

if (process.argv[1]?.endsWith("check-version-bump.js")) {
  try {
    const beforeIndex = process.argv.indexOf("--before");
    const outputIndex = process.argv.indexOf("--github-output");
    if (beforeIndex === -1 || !process.argv[beforeIndex + 1]) throw new Error("--before <git-ref> is required");
    const current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    const result = checkVersionBump(packageVersionAt(process.argv[beforeIndex + 1]), current);
    if (outputIndex !== -1 && process.argv[outputIndex + 1]) {
      fs.appendFileSync(process.argv[outputIndex + 1], [
        `should_release=${result.shouldRelease}`,
        `previous=${result.previous}`,
        `version=${result.version}`,
        `tag=${result.tag}`,
        "",
      ].join("\n"));
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
