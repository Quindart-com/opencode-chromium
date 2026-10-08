import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { executableCandidates } from '../src/cli/browsers.js';
import { FirefoxBackend } from '../native-host/src/firefox/backend.js';

// This test owns a disposable browser/profile and a unique native-host registration.
// It cannot replace the installed host or connect to personal browser profiles.
const browser = process.argv.includes('--librewolf') ? 'librewolf' : 'firefox';
const executable = process.env.OPENCODE_FIREFOX_TEST_EXECUTABLE ?? executableCandidates(browser).find(fs.existsSync);
if (!executable) throw Error('Test browser executable missing');
const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-firefox-extension-'));
const profile = path.join(fixture, 'profile'); fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'user.js'), 'user_pref("browser.download.useDownloadDir",true);\nuser_pref("browser.download.dir",' + JSON.stringify(path.join(fixture, 'downloads')) + ');\nuser_pref("browser.download.folderList",2);\nuser_pref("browser.helperApps.neverAsk.saveToDisk","text/plain,application/octet-stream");\n');
// web-ext's temporary-add-on installer uses Firefox's separate developer RDP
// server. LibreWolf disables that by default; enable it only in this disposable
// QA profile, keeping its listener local. Production automation uses BiDi.
if (browser === 'librewolf') fs.writeFileSync(path.join(profile, 'librewolf.overrides.cfg'), 'pref("devtools.debugger.remote-enabled", true);\npref("devtools.chrome.enabled", true);\npref("devtools.debugger.force-local", true);\npref("devtools.debugger.prompt-connection", false);\n');
const source = path.join(fixture, 'extension'); fs.cpSync(path.join(root, 'extension-firefox'), source, { recursive: true });
const host = 'com.opencode.browser.test' + randomBytes(4).toString('hex');
const background = path.join(source, 'background.js');
fs.writeFileSync(background, fs.readFileSync(background, 'utf8').replaceAll('com.opencode.browser.plugin', host));
const registry = path.join(fixture, 'registry'); fs.mkdirSync(registry);
const runtimeDir = path.join(fixture, 'runtime');
const env = { ...process.env, OPENCODE_BROWSER_PROFILE_REGISTRY_DIR: registry, OPENCODE_BROWSER_RUNTIME_DIR: runtimeDir, OPENCODE_BROWSER_MEMORY_DIR: path.join(fixture, 'memory'), AGENT_BROWSER_PROVIDER_DIR: path.join(fixture, 'providers'), OPENCODE_BROWSER_SEMANTIC_DIR: path.join(fixture, 'models') };
if (browser === 'librewolf') {
  env.USERPROFILE = fixture; env.HOME = fixture;
  const overrides = path.join(fixture, '.librewolf'); fs.mkdirSync(overrides);
  fs.writeFileSync(path.join(overrides, 'librewolf.overrides.cfg'), fs.readFileSync(path.join(profile, 'librewolf.overrides.cfg'), 'utf8') + 'pref("librewolf.devHelpers", true);\n');
}
const launcher = path.join(fixture, process.platform === 'win32' ? 'native.cmd' : 'native.sh');
const variables = ['OPENCODE_BROWSER_PROFILE_REGISTRY_DIR', 'OPENCODE_BROWSER_RUNTIME_DIR', 'OPENCODE_BROWSER_MEMORY_DIR', 'AGENT_BROWSER_PROVIDER_DIR', 'OPENCODE_BROWSER_SEMANTIC_DIR'];
fs.writeFileSync(launcher, process.platform === 'win32' ? '@echo off\r\n' + variables.map(k => 'set "' + k + '=' + env[k] + '"').join('\r\n') + '\r\n"' + process.execPath + '" "' + path.join(root, 'native-host/dist/runtime.js') + '"\r\n' : '#!/bin/sh\n' + variables.map(k => 'export ' + k + '=' + JSON.stringify(env[k])).join('\n') + '\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(root, 'native-host/dist/runtime.js')) + '\n', { mode: 0o700 });
const manifest = path.join(fixture, 'native.json');
fs.writeFileSync(manifest, JSON.stringify({ name: host, description: 'Disposable extension verification host', path: launcher, type: 'stdio', allowed_extensions: ['opencode-browser-plugin@quindart.com'] }));
let nativeKey, nativeFile, child, agent, profileId;
const server = http.createServer((req, res) => {
  if (req.url === '/download') { res.setHeader('Content-Type', 'text/plain'); res.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"'); res.end('owned fixture'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/next' ? '<h1>Next page</h1>' : '<title>Extension parity fixture</title><button id="choose" onclick="document.querySelector(\'#result\').textContent=event.isTrusted?\'Trusted choice\':\'Synthetic choice\'">Choose blue</button><p id="result">Ready</p><input id="name" aria-label="Your name"><button id="dialog" onclick="alert(\'Owned fixture dialog\')">Open dialog</button><div id="drag" style="width:60px;height:60px;background:blue" onpointerdown="window.dragged=event.isTrusted" onpointerup="window.released=event.isTrusted"></div><a id="next" href="/next">Next</a><a id="download" href="/download">Download fixture</a>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const report = { browser, version: '1.9.1', checks: [] };
try {
  if (process.platform === 'win32') {
    nativeKey = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\' + host;
    try { execFileSync('reg', ['query', nativeKey], { stdio: 'ignore' }); throw Error('Disposable host registration already exists'); } catch (error) { if (!error.status) throw error; }
    execFileSync('reg', ['add', nativeKey, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    env.HOME = fixture;
    const dir = path.join(fixture, '.mozilla/native-messaging-hosts'); fs.mkdirSync(dir, { recursive: true });
    nativeFile = path.join(dir, host + '.json'); fs.copyFileSync(manifest, nativeFile);
  }
  child = spawn(process.execPath, [path.join(root, 'node_modules/web-ext/bin/web-ext.js'), 'run', '--source-dir', source, '--firefox', executable, '--firefox-profile', profile, '--keep-profile-changes', '--no-reload', '--no-input', '--no-config-discovery', '--verbose', ...(process.argv.includes('--visual') ? [] : ['--args=--headless']), '--args=--remote-debugging-port=' + port], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(0, 20000); });
  let registration;
  for (let i = 0; i < 100; i++) { const file = fs.readdirSync(registry).find(f => f.endsWith('.json')); if (file) { registration = JSON.parse(fs.readFileSync(path.join(registry, file), 'utf8')); break; } if (child.exitCode !== null) throw Error('Test browser exited: ' + logs); await new Promise(resolve => setTimeout(resolve, 300)); }
  if (!registration) throw Error('Native extension connection did not register: ' + logs);
  profileId = registration.profileId; assert.match(registration.browserName, /Firefox|LibreWolf/); report.checks.push('real extension and native messaging handshake');
  fs.mkdirSync(path.join(runtimeDir, 'firefox'), { recursive: true }); fs.writeFileSync(path.join(runtimeDir, 'firefox', profileId + '.json'), JSON.stringify({ endpoint: 'ws://127.0.0.1:' + port + '/session' }));
  Object.assign(process.env, { OPENCODE_BROWSER_PROFILE_REGISTRY_DIR: registry });
  const { createBrowserAgent } = await import('../src/adapters/sdk/index.js'); agent = createBrowserAgent();
  const sessionId = 'firefox-extension-verification';
  async function call(name, args) { const result = await agent.call(name, { profile: profileId, sessionId, ...args }); if (!result.ok) throw Error(name + ': ' + JSON.stringify(result)); return result; }
  const tab = await call('browser_session', { action: 'new-tab' }); const tabId = tab.activeTabId;
  await call('browser_run', { tabId, steps: [{ action: 'navigate', url: origin }, { action: 'click', target: { selector: '#choose' } }], postObserve: { mode: 'inspect', target: { selector: '#result' } } });
  const chosen = await call('browser_observe', { tabId, mode: 'inspect', target: { selector: '#result' } }); assert.match(JSON.stringify(chosen), /Trusted choice/); report.checks.push('navigation and trusted click through four tools');
  await call('browser_run', { tabId, steps: [{ id: 'choice', action: 'find', target: { query: 'Choose blue' } }, { action: 'click', target: { fromStep: 'choice' }, settle: { condition: 'contains', target: { selector: '#result' }, value: 'Trusted choice' } }] }); report.checks.push('find action and settle');
  await call('browser_run', { tabId, steps: [{ action: 'fill', target: { selector: '#name' }, value: 'Luna fixture' }, { action: 'press', target: { selector: '#name' }, key: 'End' }, { action: 'type', target: { selector: '#name' }, value: ' complete' }, { action: 'hover', target: { selector: '#choose' } }] }); report.checks.push('forms keyboard and hover');
  const shot = await call('browser_observe', { tabId, mode: 'screenshot', format: 'jpeg', quality: 45, delivery: 'artifact' }); assert.ok(shot); report.checks.push('screenshot through runtime');
  await call('browser_run', { tabId, steps: [{ action: 'drag', path: [{ x: 20, y: 110 }, { x: 35, y: 125 }] }] }); report.checks.push('drag through runtime');
  await call('browser_run', { tabId, steps: [{ action: 'click', target: { selector: '#download' } }] });
  let downloads;
  for (let i = 0; i < 30; i++) { downloads = await call('browser_observe', { tabId, mode: 'downloads' }); if (JSON.stringify(downloads).includes('fixture.txt')) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.match(JSON.stringify(downloads), /fixture.txt/); report.checks.push('download events through runtime');
  await call('browser_run', { tabId, steps: [{ action: 'click', target: { selector: '#next' } }, { action: 'back' }], postObserve: { mode: 'inspect', target: { selector: '#choose' } } }); report.checks.push('history and navigation target renewal');
  await call('browser_session', { action: 'configure', tabId, environment: { viewport: { width: 800, height: 600 } } }); await call('browser_session', { action: 'configure', tabId, environment: { reset: true } }); report.checks.push('viewport configuration and reset');
  const second = await call('browser_session', { action: 'new-tab', sessionId: 'firefox-second-session' });
  await call('browser_run', { sessionId: 'firefox-second-session', tabId: second.activeTabId, steps: [{ action: 'navigate', url: origin }] });
  const finalized = await call('browser_finalize', {}); assert.equal(finalized.status, 'finalized'); report.checks.push('session finalization');
  await call('browser_observe', { sessionId: 'firefox-second-session', tabId: second.activeTabId, mode: 'inspect', target: { selector: '#choose' } });
  report.checks.push('another concurrent session survives finalization');
  await call('browser_finalize', { sessionId: 'firefox-second-session' });
  if (process.argv.includes('--visual')) {
    const visual = new FirefoxBackend({ endpoint: 'ws://127.0.0.1:' + port + '/session' });
    await visual.connect();
    try {
      const tab = await visual.send('browsingContext.create', { type: 'tab' });
      await visual.send('browsingContext.navigate', { context: tab.context, url: 'http://127.0.0.1:49017/popup.html', wait: 'complete' });
      await visual.send('script.evaluate', { target: { context: tab.context }, expression: 'document.title="OpenCode extension UI verification"', awaitPromise: false });
      await visual.send('browsingContext.activate', { context: tab.context });
      fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
      const capture = async suffix => { const image = await visual.send('browsingContext.captureScreenshot', { context: tab.context, origin: 'viewport', format: { type: 'image/png' } }); fs.writeFileSync(path.join(root, 'reports', 'popup-live-' + browser + '-' + suffix + '.png'), Buffer.from(image.data, 'base64')); };
      await capture('overview');
      await visual.send('script.evaluate', { target: { context: tab.context }, expression: 'document.getElementById("tab-settings").click()', awaitPromise: false });
      await visual.send('browsingContext.setViewport', { context: tab.context, viewport: { width: 360, height: 900 } });
      await capture('settings-narrow');
      console.log(JSON.stringify({ visualReady: true, windowTitle: 'OpenCode extension UI verification', disposableProfile: true }));
      await new Promise(resolve => setTimeout(resolve, 120000));
    } finally { await visual.close(); }
  }
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true }); fs.writeFileSync(path.join(root, 'reports', browser + '-extension-parity.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  agent?.close();
  if (child && child.exitCode === null) { if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch {} } else child.kill(); }
  if (nativeKey) { try { execFileSync('reg', ['delete', nativeKey, '/f'], { stdio: 'ignore', windowsHide: true }); } catch {} }
  if (nativeFile) fs.rmSync(nativeFile, { force: true });
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); } catch { console.error('Owned temporary fixture cleanup pending:', fixture); }
}
