import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { checkTagVersion } from "../../scripts/check-tag-version.js";

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
});
