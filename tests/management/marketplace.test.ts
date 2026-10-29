import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshBrowserMarketplace } from "../../src/management/marketplace.ts";

test("marketplace refresh preserves user configuration, coalesces concurrent runs, and repeats only for a new release", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-refresh-"));
  const home = path.join(root, "codex"), dir = path.join(root, "runtime");
  fs.mkdirSync(home); const config = '[plugins."opencode-browser-plugin@quindart-browser"]\nenabled=true\n'; fs.writeFileSync(path.join(home, "config.toml"), config);
  let calls = 0;
  const run = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return true; };
  try {
    const options = { home, dir, run, version: "1.10.1" };
    const results = await Promise.all([refreshBrowserMarketplace(options), refreshBrowserMarketplace(options)]);
    expect(results.map(row => row.status).sort()).toEqual(["pending", "refreshed"]);
    expect((await refreshBrowserMarketplace(options)).status).toBe("current"); expect(calls).toBe(1);
    expect((await refreshBrowserMarketplace({ ...options, version: "1.10.2" })).status).toBe("refreshed"); expect(calls).toBe(2);
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe(config);
    fs.writeFileSync(path.join(home, "config.toml"), config.replace("true", "false"));
    expect((await refreshBrowserMarketplace({ ...options, version: "1.10.3" })).status).toBe("not_configured"); expect(calls).toBe(2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed catalog refresh stays retryable and does not claim the release is current", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-failed-"));
  fs.writeFileSync(path.join(root, "config.toml"), '[plugins."opencode-browser-plugin@quindart-browser"]\nenabled=true\n');
  try {
    const options = { home: root, dir: path.join(root, "runtime"), version: "1.10.1" };
    expect((await refreshBrowserMarketplace({ ...options, run: async () => false })).status).toBe("manual");
    expect((await refreshBrowserMarketplace({ ...options, run: async () => true })).status).toBe("refreshed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
