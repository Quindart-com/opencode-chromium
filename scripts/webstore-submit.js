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

async function itemDraftVersion() {
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const { access_token: accessToken } = await tokenResponse.json();
    const response = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${extensionId}?projection=DRAFT`, {
      headers: { Authorization: `Bearer ${accessToken}`, "x-goog-api-version": "2" },
    });
    if (!response.ok) return null;
    const item = await response.json();
    return item.draftState?.version ?? null;
  } catch {
    return null;
  }
}

if (!dryRun) {
  const existingVersion = await itemDraftVersion();
  if (existingVersion === packageJson.version) {
    console.log(`Version ${packageJson.version} already exists on the store item (it may be under review); skipping submission to avoid clobbering it.`);
    process.exit(0);
  }
  if (existingVersion && existingVersion !== packageJson.version) {
    console.log(`Store item has draft ${existingVersion} (different from ${packageJson.version}); proceeding with the submission.`);
  }
}

const results = await submit(config).catch((error) => {
  const detail = errorMessage(error);
  if (detail.includes("ITEM_NOT_UPDATABLE")) {
    console.log("Chrome Web Store item is under review, so an upload is refused by the store platform right now. This is expected: the update will apply on the next release run once the review concludes.");
    process.exit(0);
  }
  console.error(`Chrome Web Store submission failed: ${detail}`);
  process.exit(1);
});
console.log(JSON.stringify(results, null, 2));
const chromeResult = results.chrome;
if (!chromeResult?.success) {
  console.error(`Chrome Web Store submission failed: ${errorMessage(chromeResult?.err)}`);
  process.exit(1);
}
if (dryRun) {
  console.log("Dry run passed: credentials and package are ready for a real submission.");
} else {
  console.log("Chrome Web Store submission succeeded.");
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const causes = error.cause?.errors ?? error.cause;
    if (Array.isArray(causes)) return JSON.stringify(causes);
    return error.message;
  }
  return JSON.stringify(error);
}