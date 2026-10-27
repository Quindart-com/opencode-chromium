import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginLaunch, probeMcp, quarantineBrokenCache } from "../../skills/opencode-browser-plugin/scripts/diagnose-mcp.mjs";

test("the standalone probe verifies a real MCP handshake and required tool list", async () => {
  const code = `let b='';process.stdin.on('data',d=>{b+=d;for(;;){let i=b.indexOf('\\n');if(i<0)break;let m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26'}})+'\\n');if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:['browser_run','browser_observe','browser_session','browser_finalize'].map(name=>({name}))}})+'\\n')}});process.stdin.on('end',()=>process.exit(0));`;
  const result = await probeMcp({ command: "node", args: ["-e", code], timeoutMs: 5000 });
  assert.equal(result.ok, true); assert.equal(result.code, "MCP_READY"); assert.equal(result.tools.length, 4);
});

test("the probe distinguishes a missing dependency, invalid protocol output, and timeout", async () => {
  const dependency = await probeMcp({ command: "node", args: ["-e", "console.error('ERR_MODULE_NOT_FOUND');process.exit(1)"], timeoutMs: 5000 });
  assert.equal(dependency.code, "MCP_DEPENDENCY_MISSING");
  const invalid = await probeMcp({ command: "node", args: ["-e", "console.log('invalid');process.stdin.resume()"], timeoutMs: 5000 });
  assert.equal(invalid.code, "MCP_INVALID_RESPONSE");
  const timeout = await probeMcp({ command: "node", args: ["-e", "process.stdin.resume()"], timeoutMs: 100 });
  assert.equal(timeout.code, "MCP_STARTUP_TIMEOUT");
  assert.throws(() => pluginLaunch("1.0.0 & unexpected"), /exact package version/);
});

test("cache recovery preserves only this runtime's identified npm entry and rejects unrelated locations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-repair-"));
  try {
    const cache = path.join(root, "cache"), entry = path.join(cache, "_npx", "abc123");
    const unrelated = path.join(cache, "_npx", "def456");
    for (const dir of [entry, unrelated]) {
      fs.mkdirSync(path.join(dir, "node_modules", "opencode-chromium"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "opencode-chromium", "package.json"), '{"name":"opencode-chromium"}');
    }
    const error = `Cannot find package '${entry}/node_modules/dependency/index.js'`;
    assert.throws(() => quarantineBrokenCache(error, path.join(root, "elsewhere")));
    assert.equal(fs.existsSync(entry), true);
    const backup = quarantineBrokenCache(error, cache);
    assert.equal(fs.existsSync(entry), false); assert.equal(fs.existsSync(backup), true); assert.equal(fs.existsSync(unrelated), true);
    fs.writeFileSync(path.join(unrelated, "node_modules", "opencode-chromium", "package.json"), '{"name":"different-package"}');
    assert.throws(() => quarantineBrokenCache(`Cannot find package '${unrelated}/node_modules/dependency/index.js'`, cache), /does not contain/);
    assert.equal(fs.existsSync(unrelated), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
