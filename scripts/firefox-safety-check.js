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
if (!manifest.background.scripts?.length || !manifest.browser_specific_settings.gecko.data_collection_permissions) throw new Error("Firefox background/data declarations missing");
const result = JSON.parse(execFileSync(process.execPath, [path.join(root, "node_modules/web-ext/bin/web-ext.js"), "lint", "--source-dir", path.join(root, "extension-firefox"), "--output", "json"], { encoding: "utf8", cwd: root }));
// React DOM's packaged SVG/HTML feature probes. Pin the reviewed vendor bytes,
// warning code and locations; every new or changed warning still fails the gate.
const reviewedVendorHash = "ca1ee83f51c8a39287e297895934eb8b5d875e00b4957c110b321b4b0aac9037";
const unreviewed = result.warnings.filter(w => {
  if (w.code !== "UNSAFE_VAR_ASSIGNMENT" || w.file !== "chunks/popup-DCNGjpD9.js" || w.line !== 9 || ![1777, 4644].includes(w.column)) return true;
  return createHash("sha256").update(fs.readFileSync(path.join(root, "extension-firefox", w.file))).digest("hex") !== reviewedVendorHash;
});
if (result.errors.length || result.notices.length || unreviewed.length) throw new Error(JSON.stringify({ errors: result.errors, notices: result.notices, warnings: unreviewed }));
console.log(JSON.stringify({ validator: result.summary, reviewedReactProbeWarnings: result.warnings.length }));
console.log(JSON.stringify({ ok: true, browser: "firefox", version: pkg.version }));
