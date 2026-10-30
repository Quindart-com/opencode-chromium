import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedLaunch, probeMcp } from "../../skills/opencode-browser-plugin/scripts/diagnose-mcp.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers["opencode-browser-plugin"];
const fixtureServer = `let b='';process.stdin.on('data',d=>{b+=d;for(;;){let i=b.indexOf('\\n');if(i<0)break;let m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26'}})+'\\n');if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:['browser_run','browser_observe','browser_session','browser_finalize'].map(name=>({name}))}})+'\\n')}});process.stdin.on('end',()=>process.exit(0));`;

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plugin-launch-"));
}
function cleanup(dir) {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.match(path.basename(dir), /^plugin-launch-/);
  fs.rmSync(dir, { recursive: true, force: true });
}

test("the packaged plugin starts its local MCP without npm, network installation, or changing the selected runtime", async () => {
  const dir = temporary();
  try {
    const activation = JSON.stringify({ root: dir, version: "1.10.1", channel: "production", generation: 7 });
    fs.writeFileSync(path.join(dir, "runtime.json"), activation);
    fs.writeFileSync(path.join(dir, "mcp.mjs"), fixtureServer);
    assert.equal(config.command, "node");
    const result = await probeMcp({ command: process.execPath, args: config.args, timeoutMs: 5000,
      env: { ...process.env, PATH: "", OPENCODE_BROWSER_RUNTIME_DIR: dir } });
    assert.equal(result.code, "MCP_READY");
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, "runtime.json"), "utf8"), activation);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["mcp.mjs", "runtime.json"]);
  } finally { cleanup(dir); }
});

test("a missing local runtime returns setup and scoped reload guidance promptly without creating files", async () => {
  const dir = temporary();
  try {
    const result = await probeMcp({ command: process.execPath, args: config.args, timeoutMs: 5000,
      env: { ...process.env, PATH: "", OPENCODE_BROWSER_RUNTIME_DIR: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MCP_RUNTIME_SETUP_REQUIRED");
    assert.match(result.stderr, /setup --all/);
    assert.match(result.stderr, /disable and enable/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { cleanup(dir); }
});

test("diagnostics use the installed plugin command instead of probing a different npm version", () => {
  const launch = installedLaunch("latest", { pluginRoot, runtimeDir: path.join(pluginRoot, "does-not-exist") });
  assert.equal(launch.source, "installed_plugin");
  assert.equal(launch.command, config.command);
  assert.deepEqual(launch.args, config.args);
  assert.equal(launch.timeoutMs, 30000);
});
