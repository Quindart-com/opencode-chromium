import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension-firefox/manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version || manifest.manifest_version !== 3 || manifest.browser_specific_settings?.gecko?.id !== "opencode-browser-plugin@quindart.com") throw new Error("Firefox identity/version mismatch");
if (manifest.permissions.includes("debugger") || manifest.permissions.includes("tabGroups") || manifest.background.service_worker) throw new Error("Chromium-only manifest fields found in Firefox build");
if (manifest.permissions.includes("downloads")) throw new Error("Firefox build requests unused downloads permission");
if (manifest.browser_specific_settings.gecko_android) throw new Error("Desktop native-host extension must not advertise Android support");
if (!manifest.background.scripts?.length || !manifest.browser_specific_settings.gecko.data_collection_permissions) throw new Error("Firefox background/data declarations missing");
const result = JSON.parse(execFileSync(process.execPath, [path.join(root, "node_modules/web-ext/bin/web-ext.js"), "lint", "--source-dir", path.join(root, "extension-firefox"), "--output", "json"], { encoding: "utf8", cwd: root }));
// React DOM's packaged dangerouslySetInnerHTML handlers are unused by our UI.
// Pin the vendor bytes, warning code and locations; changed warnings fail.
const reviewedVendorHash = "99c18875d3d54acd30a602bd329eeaa13cb2cc637322339f6651da00a9ff8cfc";
// web-ext checks Android's inherited minimum even when the manifest does not
// opt into Android. This exact warning is inapplicable to our desktop-only build.
const desktopOnlyAndroidWarning = w => !manifest.browser_specific_settings.gecko_android &&
  manifest.browser_specific_settings.gecko.strict_min_version === "140.0" &&
  w.code === "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION" && w.file === "manifest.json" &&
  w.description === '"strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings.gecko.data_collection_permissions".';
const unreviewed = result.warnings.filter(w => {
  if (desktopOnlyAndroidWarning(w)) return false;
  if (w.code !== "UNSAFE_VAR_ASSIGNMENT" || !/^chunks\/jsx-runtime-[A-Za-z0-9_-]+\.js$/.test(w.file) || w.line !== 9 || ![1811, 4726].includes(w.column)) return true;
  return createHash("sha256").update(fs.readFileSync(path.join(root, "extension-firefox", w.file))).digest("hex") !== reviewedVendorHash;
});
if (result.errors.length || result.notices.length || unreviewed.length) throw new Error(JSON.stringify({ errors: result.errors, notices: result.notices, warnings: unreviewed }));
console.log(JSON.stringify({ validator: result.summary, reviewedReactProbeWarnings: result.warnings.filter(w => w.code === "UNSAFE_VAR_ASSIGNMENT").length, desktopOnlyAndroidWarnings: result.warnings.filter(desktopOnlyAndroidWarning).length }));
console.log(JSON.stringify({ ok: true, browser: "firefox", version: pkg.version }));
