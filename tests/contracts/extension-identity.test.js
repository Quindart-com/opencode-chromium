import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extensionDisplayName } from "../../scripts/extension-identity.js";

test("localized release identity resolves the canonical English name and rejects missing or changed catalogs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-identity-"));
  const manifest = { name: "__MSG_extensionName__", default_locale: "en" };
  try {
    fs.mkdirSync(path.join(root, "_locales/en"), { recursive: true });
    const file = path.join(root, "_locales/en/messages.json");
    expect(extensionDisplayName(manifest, root)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ extensionName: { message: "opencode-chromium" } }));
    expect(extensionDisplayName(manifest, root)).toBe("opencode-chromium");
    fs.writeFileSync(file, JSON.stringify({ extensionName: { message: "different" } }));
    expect(extensionDisplayName(manifest, root)).not.toBe("opencode-chromium");
    expect(extensionDisplayName({ ...manifest, default_locale: "../other" }, root)).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
