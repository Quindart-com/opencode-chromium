import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { npmMetadata } from "../../src/control/npm-client.ts";
import { publishedVersion } from "../../src/management/manual-update.ts";

test("release lookup tolerates slow registry responses and preserves configured auth without leaking failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-metadata-"));
  const requests: string[] = []; let authenticated = false, rejected = false;
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? ""); authenticated = req.headers.authorization === "Bearer synthetic-registry-token";
    res.setHeader("content-type", "application/json");
    if (rejected) { res.writeHead(401); res.end(JSON.stringify({ error: "synthetic-registry-token" })); return; }
    // Exceed the former 15-second process timeout with a real npm request.
    setTimeout(() => res.end(JSON.stringify({ name: "opencode-chromium", "dist-tags": { latest: "1.10.1" }, versions: { "1.10.1": { name: "opencode-chromium", version: "1.10.1" } } })), 16000);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as {port:number}).port;
    const userconfig = path.join(root, ".npmrc");
    fs.writeFileSync(userconfig, `registry=http://127.0.0.1:${port}/\n//127.0.0.1:${port}/:_authToken=synthetic-registry-token\n`);
    const env = { ...process.env, npm_config_userconfig: userconfig, npm_config_registry: `http://127.0.0.1:${port}/`, npm_config_cache: path.join(root, "cache") };
    const metadata = await npmMetadata({ cwd: root, env });
    expect(await publishedVersion(async () => metadata)).toBe("1.10.1");
    expect(requests.some(url => url.startsWith("/opencode-chromium"))).toBe(true);
    expect(authenticated).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain("synthetic-registry-token");
    rejected = true;
    const failure = await npmMetadata({ cwd: root, env: { ...env, npm_config_cache: path.join(root, "rejected-cache") } }).catch(error => error);
    expect(failure.code).toBe("release_unavailable");
    expect(failure.message).not.toContain("synthetic-registry-token");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir())); expect(path.basename(root)).toStartWith("npm-metadata-");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 40000);
