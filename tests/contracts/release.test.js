import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { checkTagVersion } from "../../scripts/check-tag-version.js";
import { checkVersionBump, compareVersions, isManifestVersionSyncRetry } from "../../scripts/check-version-bump.js";
import { maskIdentifier } from "../../extension-src/entrypoints/popup/privacy.ts";
import { publicProfile, sanitizeSemanticForPopup } from "../../extension-src/entrypoints/background/runtime-profile.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

describe("release metadata", () => {

  test("accepts a tag matching the package version", () => {
    expect(checkTagVersion(`v${packageJson.version}`)).toEqual({
      ok: true,
      tag: `v${packageJson.version}`,
      package: packageJson.name,
      version: packageJson.version,
    });
  });

  test("rejects a tag that does not match the package version", () => {
    expect(() => checkTagVersion("v99.0.0")).toThrow(/does not match package version/);
  });

  test("detects only forward SemVer version bumps", () => {
    expect(checkVersionBump("1.6.5", "1.7.0")).toEqual({
      shouldRelease: true,
      previous: "1.6.5",
      version: "1.7.0",
      tag: "v1.7.0",
    });
    expect(checkVersionBump("1.7.0", "1.7.0").shouldRelease).toBe(false);
    expect(isManifestVersionSyncRetry("1.7.1", "1.7.2", "1.7.2")).toBe(true);
    expect(isManifestVersionSyncRetry("1.7.2", "1.7.2", "1.7.2")).toBe(false);
    expect(isManifestVersionSyncRetry(null, "1.7.2", "1.7.2")).toBe(false);
    expect(() => checkVersionBump("1.7.0", "1.6.5")).toThrow(/must increase/);
    expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBe(1);
    expect(compareVersions("2.0.0-rc.2", "2.0.0-rc.1")).toBe(1);
  });
});

describe("popup privacy surface", () => {
  test("popup responses mask profile ids and omit semantic cache paths", () => {
    expect(publicProfile({ profileId: "274b81aa-1234-5678-9abc-def012345678", profileLabel: "Work" })).toEqual({
      profileIdMasked: "274b…5678",
      profileLabel: "Work",
    });
    expect(sanitizeSemanticForPopup({ state: "ready", cacheDir: "C:/private/models", cache: { kind: "local" } })).toEqual({
      state: "ready",
      cache: { kind: "local" },
    });
    expect(sanitizeSemanticForPopup(null)).toBeNull();
    const messages = JSON.parse(fs.readFileSync(path.join(root, "extension-src", "public", "_locales", "en", "messages.json"), "utf8"));
    expect(messages.developerDetails.message).toBe("Developer details");
  });

  test("maskIdentifier reveals only the edges of an identifier", () => {
    expect(maskIdentifier("274b81aa-1234-5678-9abc-def012345678")).toBe("274b…5678");
    expect(maskIdentifier("short")).toBe("s…");
    expect(maskIdentifier("")).toBe("");
    expect(maskIdentifier(null)).toBe("");
    expect(maskIdentifier(undefined)).toBe("");
  });

});
