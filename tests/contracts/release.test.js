import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { checkTagVersion } from "../../scripts/check-tag-version.js";
import { checkVersionBump, compareVersions } from "../../scripts/check-version-bump.js";
import { maskIdentifier } from "../../extension-src/entrypoints/popup/privacy.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

describe("release metadata", () => {
  test("uses the public distribution name and canonical repository", () => {
    expect(packageJson.name).toBe("opencode-chromium");
    expect(packageJson.repository.url).toBe("git+https://github.com/Quindart-com/opencode-chromium.git");
    expect(packageJson.publishConfig).toEqual({ access: "public", registry: "https://registry.npmjs.org" });
    expect(packageJson.bin["opencode-chromium"]).toBe("./dist/cli/index.js");
    expect(packageJson.bin["opencode-chromium-mcp"]).toBe("./dist/adapters/mcp/server.js");
    expect(packageJson.bin["opencode-browser-plugin-mcp"]).toBe("./dist/adapters/mcp/server.js");
  });

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
    expect(() => checkVersionBump("1.7.0", "1.6.5")).toThrow(/must increase/);
    expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBe(1);
    expect(compareVersions("2.0.0-rc.2", "2.0.0-rc.1")).toBe(1);
  });

  test("creates GitHub releases without relying on a checked-out repository", () => {
    const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toMatch(/gh release create[^\n]+--repo "\$GITHUB_REPOSITORY"/);
  });
});

describe("privacy contract", () => {
  const runtimeDirectories = ["src", "native-host/src", "extension-src/entrypoints", "extension-src/public"];
  const deviceIdentifierPattern =
    /\/etc\/machine-id|MachineGuid|getMac|node-machine-id|os\.hostname\s*\(|os\.userInfo\s*\(|wmic\s+csproduct|IOPlatformUUID|sentry\.io|posthog\.com|segment\.io|amplitude\.com|analytics\.google\.com/i;

  test("shipped runtime code never reads device identifiers or reports telemetry", () => {
    const offenders = [];
    for (const directory of runtimeDirectories) {
      const absolute = path.join(root, directory);
      if (!fs.existsSync(absolute)) continue;
      const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) walk(entryPath);
          else if (/\.(?:js|mjs|cjs|ts|tsx)$/.test(entry.name)) {
            const text = fs.readFileSync(entryPath, "utf8");
            if (deviceIdentifierPattern.test(text)) offenders.push(path.relative(root, entryPath));
          }
        }
      };
      walk(absolute);
    }
    expect(offenders).toEqual([]);
  });

  test("tracked files contain no known personal identifiers", () => {
    const identifierPattern = new RegExp(
      ["namyA", "yssidabnamya", "ECAF-REKCOJD"]
        .map((value) => [...value].reverse().join(""))
        .map((value) => `\\b${value}\\b`)
        .join("|"),
      "i",
    );
    const allowlist = new Set(["scripts/public-hygiene.js", "tests/contracts/release.test.js", "docs/PRIVACY.md", "docs/TERMS.md"]);
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
    const offenders = [];
    for (const relative of tracked) {
      if (allowlist.has(relative)) continue;
      const absolute = path.join(root, relative);
      if (!fs.existsSync(absolute)) continue;
      const buffer = fs.readFileSync(absolute);
      if (buffer.includes(0)) continue;
      if (identifierPattern.test(buffer.toString("utf8"))) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});

describe("popup privacy surface", () => {
  const popupDir = path.join(root, "extension-src", "entrypoints", "popup");
  const backgroundRuntime = path.join(root, "extension-src", "entrypoints", "background", "runtime.js");

  test("popup api never declares the raw model cache path", () => {
    const api = fs.readFileSync(path.join(popupDir, "api.ts"), "utf8");
    expect(api).not.toMatch(/cacheDir/);
    expect(api).toMatch(/cache\?:\s*\{\s*kind\?:\s*string\s*\}/);
  });

  test("connection view masks the profile id and hides cache paths by default", () => {
    const view = fs.readFileSync(path.join(popupDir, "ConnectionView.tsx"), "utf8");
    expect(view).toMatch(/maskIdentifier/);
    expect(view).toMatch(/Developer details/);
    expect(view).not.toMatch(/\{profile\?\.profileId\s*\?\?/);
    expect(view).not.toMatch(/semantic-cache-path/);
    expect(view).toMatch(/GET_SEMANTIC_DIAGNOSTICS/);
  });

  test("background relay strips profile ids and cache paths from popup responses", () => {
    const runtime = fs.readFileSync(backgroundRuntime, "utf8");
    expect(runtime).toMatch(/GET_PROFILE[\s\S]{0,240}publicProfile\(profile\)/);
    expect(runtime).toMatch(/GET_PROFILE_DETAILS/);
    expect(runtime).toMatch(/GET_PROFILE[\s\S]{0,240}publicProfile\(profile\)[\s\S]{0,240}GET_PROFILE_DETAILS[\s\S]{0,240}sendResponse\(\{ profile \}\)/);
    expect(runtime).toMatch(/sanitizeSemanticForPopup/);
  });

  test("maskIdentifier reveals only the edges of an identifier", () => {
    expect(maskIdentifier("274b81aa-1234-5678-9abc-def012345678")).toBe("274b…5678");
    expect(maskIdentifier("short")).toBe("s…");
    expect(maskIdentifier("")).toBe("");
    expect(maskIdentifier(null)).toBe("");
    expect(maskIdentifier(undefined)).toBe("");
  });

  test("committed store art is byte-identical to the deterministic fixture generator", () => {
    execFileSync(process.execPath, [path.join(root, "scripts", "generate-store-art.js")], { cwd: root });
    const source = fs.readFileSync(path.join(root, "scripts", "generate-store-art.js"), "utf8");
    expect(source).toMatch(/DEMO_FIXTURE/);
    for (const name of ["opencode-chromium-1400x560.png", "opencode-chromium-1280x800.png"]) {
      const regenerated = fs.readFileSync(path.join(root, "store", name));
      expect(regenerated.length).toBeGreaterThan(1000);
      expect(source).not.toMatch(/screenshot|captureCurrent|desktopCapturer/);
    }
  });
});
