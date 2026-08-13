#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { submit } from "publish-browser-extension";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const NOJOB_EXTENSION_ID = "piojnjijlmddhnnamahoopgbjcbcobaa";

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
  return value;
}

const dryRun = args.includes("--dry-run");
const zip = flagValue("zip", null) ?? path.join(root, "dist-extension", `opencode-chromium-${packageJson.version}-chrome.zip`);
const clientId = flagValue("client-id", null) ?? process.env.CHROME_CLIENT_ID;
const clientSecret = flagValue("client-secret", null) ?? process.env.CHROME_CLIENT_SECRET;
const refreshToken = flagValue("refresh-token", null) ?? process.env.CHROME_REFRESH_TOKEN;
const extensionId = flagValue("extension-id", null) ?? process.env.CHROME_EXTENSION_ID;
const publishTarget = flagValue("publish-target", "default");

if (!fs.existsSync(zip)) throw new Error(`Extension zip not found: ${zip}`);
if (!clientId || !clientSecret || !refreshToken) {
  throw new Error("Missing Chrome Web Store credentials (CHROME_CLIENT_ID / CHROME_CLIENT_SECRET / CHROME_REFRESH_TOKEN)");
}
if (extensionId === NOJOB_EXTENSION_ID) {
  throw new Error("Refusing to submit: target extension ID is the nojob extension");
}
if (extensionId && !/^[a-p]{32}$/.test(extensionId)) {
  throw new Error(`Invalid extension ID: ${extensionId}`);
}
if (!extensionId) {
  throw new Error("CHROME_EXTENSION_ID is required: upload the first version in the Chrome Web Store dev console and store the item ID as a repository secret");
}

const config = {
  dryRun,
  chrome: {
    zip,
    extensionId,
    clientId,
    clientSecret,
    refreshToken,
    publishTarget,
  },
};

console.log(JSON.stringify({
  dryRun,
  extensionId,
  publishTarget,
  zip: path.basename(zip),
  version: packageJson.version,
  action: dryRun ? "validating credentials and package (no store changes)" : "uploading and publishing",
}, null, 2));

const results = await submit(config);
console.log(JSON.stringify(results, null, 2));
const chromeResult = results.chrome;
if (!chromeResult?.success) {
  console.error(`Chrome Web Store submission failed: ${chromeResult?.err ?? "unknown error"}`);
  process.exit(1);
}
if (dryRun) {
  console.log("Dry run passed: credentials and package are ready for a real submission.");
} else {
  console.log("Chrome Web Store submission succeeded.");
}