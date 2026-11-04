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
// WXT 0.21.5 changes only the leading browser-shim import; the reviewed
// React bundle after that import is byte-for-byte unchanged.
const reviewedVendorHash = "b92fea1b4a19e33cd174064e084c71f0fe87353ab1f707e12ba0ab0cbbcec10e";
// web-ext checks Android's inherited minimum even when the manifest does not
// opt into Android. This exact warning is inapplicable to our desktop-only build.
const desktopOnlyAndroidWarning = w => !manifest.browser_specific_settings.gecko_android &&
  manifest.browser_specific_settings.gecko.strict_min_version === "140.0" &&
  w.code === "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION" && w.file === "manifest.json" &&
  w.description === '"strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings.gecko.data_collection_permissions".';
const unreviewed = result.warnings.filter(w => {
  if (desktopOnlyAndroidWarning(w)) return false;
  if (w.code !== "UNSAFE_VAR_ASSIGNMENT" || w.line !== 9 || ![1811, 4726].includes(w.column)) return true;
  if (w.file === "page-panel.js") {
    // The isolated entrypoint inlines the same pinned React DOM code. Reviewed
    // handlers differ only in minifier-local names; pin each complete case's
    // exact bytes and locations, not the entire application or warning category.
    const line = fs.readFileSync(path.join(root, "extension-firefox", w.file), "utf8").split(/\r?\n/)[8];
    const start = w.column - 179, probe = line.slice(start, start + 200);
    return !probe.startsWith("case`dangerouslySetInnerHTML`:") || createHash("sha256").update(probe).digest("hex") !== "29b697e67504ab501d6e609e79f0d300a79dda1fd3ebae0fedda315f062f57d7";
  }
  if (!/^chunks\/jsx-runtime-[A-Za-z0-9_-]+\.js$/.test(w.file)) return true;
  return createHash("sha256").update(fs.readFileSync(path.join(root, "extension-firefox", w.file))).digest("hex") !== reviewedVendorHash;
});
if (result.errors.length || result.notices.length || unreviewed.length) throw new Error(JSON.stringify({ errors: result.errors, notices: result.notices, warnings: unreviewed }));
console.log(JSON.stringify({ validator: result.summary, reviewedReactProbeWarnings: result.warnings.filter(w => w.code === "UNSAFE_VAR_ASSIGNMENT").length, desktopOnlyAndroidWarnings: result.warnings.filter(desktopOnlyAndroidWarning).length }));
console.log(JSON.stringify({ ok: true, browser: "firefox", version: pkg.version }));
