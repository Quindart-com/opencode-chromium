import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../extension-src/public/_locales");
const locales = ["en", "es", "fr", "pt_BR", "ru", "zh_CN"];
const readCatalog = (locale) => JSON.parse(readFileSync(join(root, locale, "messages.json"), "utf8"));
const placeholders = (message) => (message.match(/\$[1-9]/g) ?? []).sort();

test("locales have the same messages and substitutions as English", () => {
  expect(readdirSync(root).sort()).toEqual([...locales].sort());
  const source = readCatalog("en");
  for (const locale of locales) {
    const catalog = readCatalog(locale);
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(source).sort());
    for (const key of Object.keys(source)) {
      expect(typeof catalog[key].message).toBe("string");
      expect(catalog[key].message.trim()).not.toBe("");
      expect(placeholders(catalog[key].message)).toEqual(placeholders(source[key].message));
    }
    expect(catalog.extensionDescription.message.length).toBeLessThanOrEqual(132);
  }
});
