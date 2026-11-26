import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { hash, viewport } from "./catalog.mjs";

export const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const windows = process.platform === "win32";
const gecko = engine => engine !== "chromium";
const require = createRequire(import.meta.url);
const webExtRoot = () => path.dirname(require.resolve("web-ext"));

export function disposableEnv(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?|number_of_processors|processor_architecture|lang|lc_.*|display|wayland_display|xdg_runtime_dir|xauthority)$/i.test(name)));
  return { ...env, HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, "appdata"), LOCALAPPDATA: path.join(dir, "localdata"),
    TEMP: dir, TMP: dir, TMPDIR: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_CACHE_HOME: path.join(dir, "cache"), XDG_STATE_HOME: path.join(dir, "state"),
    OPENCODE_BROWSER_PROFILE_REGISTRY_DIR: path.join(dir, "registry"), OPENCODE_BROWSER_RUNTIME_DIR: path.join(dir, "runtime"),
    OPENCODE_BROWSER_MEMORY_DIR: path.join(dir, "memory"), OPENCODE_BROWSER_MEMORY: "0", OPENCODE_BROWSER_DISABLE_SEMANTIC_MODEL: "1",
    AGENT_BROWSER_PROVIDER_DIR: path.join(dir, "providers"), AGENT_BROWSER_SEMANTIC_DIR: path.join(dir, "models"),
    AGENT_BROWSER_VISUAL_DIR: path.join(dir, "visual"), AGENT_BROWSER_ARTIFACT_DIR: path.join(dir, "artifacts"),
    OPENCODE_BROWSER_SKIP_RECOVERY: "1", OPENCODE_BROWSER_TELEMETRY_URL: "", MOZ_NO_REMOTE: "1" };
}

export function disposableDirectory() {
  const temp = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(temp, "verified-browser-"));
  return { dir, env: disposableEnv(dir), remove() {
    if (path.dirname(fs.realpathSync(dir)) !== temp) throw new Error("Disposable directory moved outside the temporary root");
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } };
}

function executableVersion(file) {
  const options = { windowsHide: true, encoding: "utf8", timeout: 5000 };
  if (windows) {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Item -LiteralPath $env:VERIFIED_BROWSER_BINARY).VersionInfo.ProductVersion"],
    { ...options, env: { ...process.env, VERIFIED_BROWSER_BINARY: file } });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }
  const result = spawnSync(file, ["--version"], options);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export async function browserBinary({ root, engine, executable }) {
  if (engine === "chromium") {
    const { chromium } = require("playwright");
    const pinned = chromium.executablePath();
    const file = executable ?? pinned;
    if (!fs.existsSync(file)) throw new Error("Chromium executable missing. Supply --executable or provision the repo's pinned Playwright browser.");
    const bundle = json(path.join(path.dirname(require.resolve("playwright-core/package.json")), "browsers.json")).browsers.find(browser => browser.name === "chromium");
    return { file, chromium, sha256: hash(fs.readFileSync(file)), driverVersion: require("playwright/package.json").version,
      expectedVersion: file === pinned ? bundle?.browserVersion ?? null : windows ? executableVersion(file) : null,
      versionSource: file === pinned ? "bundled-revision" : windows ? "executable" : "unknown" };
  }
  const { executableCandidates } = await import(pathToFileURL(path.join(root, "dist/cli/browsers.js")));
  const file = executable ?? (engine === "waterfox" ? null : executableCandidates(engine).find(fs.existsSync));
  if (!file || !fs.existsSync(file)) throw new Error(`No ${engine} executable found. Supply --executable.`);
  return { file, sha256: hash(fs.readFileSync(file)), driverVersion: json(path.join(webExtRoot(), "package.json")).version,
    expectedVersion: executableVersion(file), versionSource: "executable" };
}

export async function startCdpBrowser({ binary, dir, env, headed, origins, startupMs, attachUrl }) {
  const profile = path.join(dir, "profile");
  const context = await binary.chromium.launchPersistentContext(profile, {
    executablePath: binary.file, headless: !headed, env, viewport, timeout: startupMs, serviceWorkers: "block",
    args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--proxy-server=http://127.0.0.1:1"],
  });
  try {
    await context.route(/^https?:/, route => origins.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const [port, socket] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\da-f-]+$/i.test(socket)) {
      throw new Error("Disposable Chromium returned an invalid CDP endpoint");
    }
    if (!context.pages().length) await context.newPage();
    const originalTabs = context.pages().map(page => ({ page, url: page.url() }));
    const attachPage = await context.newPage();
    await attachPage.goto(attachUrl, { timeout: startupMs });
    return { context, attachPage, attachUrl, originalTabs, cdpEndpoint: "ws://127.0.0.1:" + port + socket,
      browserVersion: context.browser()?.version(), browserName: "Chromium", close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function registerNative({ dir, profile, engine, host, manifest }) {
  const file = path.join(dir, "native.json");
  fs.writeFileSync(file, JSON.stringify(manifest));
  if (windows) {
    const vendor = gecko(engine) ? "Mozilla" : "Google\\Chrome";
    const key = `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${host}`;
    const options = { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 };
    if (spawnSync("reg", ["query", key], options).status === 0) throw new Error("Disposable native host name is already registered");
    execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file], options);
    return () => execFileSync("reg", ["delete", key, "/f"], options);
  }
  const directory = gecko(engine) ? (process.platform === "darwin" ? path.join(dir, "Library/Application Support/Mozilla/NativeMessagingHosts") : path.join(dir, ".mozilla/native-messaging-hosts"))
    : path.join(profile, "NativeMessagingHosts");
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(file, path.join(directory, `${host}.json`), fs.constants.COPYFILE_EXCL);
  return () => {};
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function firefoxPrefs(dir, profile, engine) {
  const prefs = {
    "app.update.enabled": false, "app.update.auto": false, "extensions.update.enabled": false,
    "datareporting.policy.dataSubmissionEnabled": false, "toolkit.telemetry.enabled": false,
    "browser.newtabpage.enabled": false, "browser.startup.homepage": "about:blank",
    "network.captive-portal-service.enabled": false, "network.connectivity-service.enabled": false,
    "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1,
    "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1, "network.proxy.no_proxies_on": "localhost, 127.0.0.1",
    "browser.download.folderList": 2, "browser.download.dir": path.join(dir, "downloads"),
  };
  fs.writeFileSync(path.join(profile, "user.js"), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
  if (engine === "librewolf") {
    const overrides = 'pref("devtools.debugger.remote-enabled", true);\npref("devtools.chrome.enabled", true);\npref("devtools.debugger.force-local", true);\npref("devtools.debugger.prompt-connection", false);\npref("librewolf.devHelpers", true);\n';
    fs.mkdirSync(path.join(dir, ".librewolf"));
    fs.writeFileSync(path.join(profile, "librewolf.overrides.cfg"), overrides);
    fs.writeFileSync(path.join(dir, ".librewolf/librewolf.overrides.cfg"), overrides);
  }
}

function stopFirefox(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (windows) execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "pipe", timeout: 8000 });
  else {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export async function startExtension({ root, controllerRoot = root, engine, binary, origins, headed, dir, env, startupMs }) {
  const source = path.join(dir, "extension");
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile);
  fs.mkdirSync(env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR);
  fs.cpSync(path.join(root, gecko(engine) ? "extension-firefox" : "extension"), source, { recursive: true });
  const host = `com.opencode.browser.bench${randomBytes(8).toString("hex")}`;
  const background = path.join(source, "background.js");
  const code = fs.readFileSync(background, "utf8");
  const builtHost = /com\.opencode\.browser\.(?:plugin|site_registry_dev)\b/g;
  if (!code.match(builtHost)) throw new Error("Built extension is missing its native host identifier");
  fs.writeFileSync(background, code.replace(builtHost, host));
  const manifestPath = path.join(source, "manifest.json");
  const manifest = json(manifestPath);
  const launcher = path.join(dir, windows ? "native.cmd" : "native.sh");
  const { writeRuntimeManifest } = await import(pathToFileURL(path.join(root, "dist/cli/runtime-link.js")));
  const { writeLaunchers } = await import(pathToFileURL(path.join(controllerRoot, "dist/cli/runtime-link.js")));
  writeRuntimeManifest(root, env.OPENCODE_BROWSER_RUNTIME_DIR);
  const launchers = writeLaunchers(controllerRoot, env.OPENCODE_BROWSER_RUNTIME_DIR);
  fs.writeFileSync(path.join(dir, "native-env.json"), JSON.stringify(env));
  fs.writeFileSync(path.join(dir, "native-env.mjs"), `import fs from "node:fs";\nconst env = JSON.parse(fs.readFileSync(new URL("native-env.json", import.meta.url)));\nfor (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];\nObject.assign(process.env, env);\nawait import(${JSON.stringify(pathToFileURL(launchers.host).href)});\n`);
  const shQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(launcher, windows ? `@echo off\r\n"${process.execPath.replaceAll("%", "%%")}" "%~dp0native-env.mjs"\r\n` :
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(path.join(dir, "native-env.mjs"))}\n`, { mode: 0o700 });
  let allowed, extensionId;
  if (gecko(engine)) {
    const id = manifest.browser_specific_settings?.gecko?.id;
    if (!id) throw new Error("Built Firefox extension is missing its Gecko ID");
    allowed = { allowed_extensions: [id] };
    firefoxPrefs(dir, profile, engine);
  } else {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
    extensionId = [...hash(key).slice(0, 32)].map(n => String.fromCharCode(97 + parseInt(n, 16))).join("");
    allowed = { allowed_origins: [`chrome-extension://${extensionId}/`] };
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, key: key.toString("base64") }));
  }
  const removeRegistration = registerNative({ dir, profile, engine, host,
    manifest: { name: host, description: "Disposable verified-action benchmark", path: launcher, type: "stdio", ...allowed } });
  let context, child, port, logs = "", spawnError;
  const close = async () => {
    try {
      if (context) await context.close();
      stopFirefox(child);
    } finally { removeRegistration(); }
  };
  try {
    if (gecko(engine)) {
      port = await reservePort();
      const webExt = path.join(webExtRoot(), "bin/web-ext.js");
      child = spawn(process.execPath, [webExt, "run", "--source-dir", source, "--firefox", binary.file,
        "--firefox-profile", profile, "--keep-profile-changes", "--no-reload", "--no-input", "--no-config-discovery",
        ...(!headed ? ["--args=--headless"] : []), `--args=--remote-debugging-port=${port}`],
      { env, cwd: dir, windowsHide: !headed, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", error => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-2200); });
    } else {
      context = await binary.chromium.launchPersistentContext(profile, { executablePath: binary.file, headless: !headed, env,
        viewport, timeout: startupMs, serviceWorkers: "allow",
        args: [`--disable-extensions-except=${source}`, `--load-extension=${source}`, "--site-per-process", "--no-first-run"] });
      context.setDefaultTimeout(5000);
      await context.route(/^https?:/, route => origins.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    }
    const deadline = performance.now() + startupMs;
    let registration, reload = false;
    const registry = env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR;
    while (!registration && performance.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child?.exitCode != null) break;
      const file = fs.readdirSync(registry).find(name => name.endsWith(".json"));
      if (file) registration = json(path.join(registry, file));
      if (!registration && context && !reload && performance.now() > deadline - startupMs / 2) {
        reload = true;
        // Kick only the disposable background worker if its cold handshake stalls.
        const panel = await context.newPage();
        try {
          await panel.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: 3000 });
          await panel.evaluate(() => chrome.runtime.reload()).catch(() => {});
        } finally { await panel.close(); }
      }
      if (!registration) await delay(100);
    }
    if (!registration) throw new Error(`Disposable ${engine} extension/native host handshake failed. ${logs.trim()}`);
    if (!/^[\w-]{1,100}$/.test(registration.profileId)) throw new Error("Invalid disposable profile registration");
    if (port) {
      const firefox = path.join(env.OPENCODE_BROWSER_RUNTIME_DIR, "firefox");
      fs.mkdirSync(firefox);
      fs.writeFileSync(path.join(firefox, `${registration.profileId}.json`), JSON.stringify({ endpoint: `ws://127.0.0.1:${port}/session` }));
    }
    return { context, close, launchers, env, profileId: registration.profileId, hostPid: registration.hostPid,
      browserVersion: context?.browser()?.version() ?? registration.browserVersion ?? null,
      browserName: registration.browserName, extensionVersion: registration.extensionVersion, handshakeRetried: reload };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Browser setup and cleanup failed", { cause: error }); }
    throw error;
  }
}

export function sampleHost(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const options = { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 };
    if (windows) {
      const data = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-Process -Id ${pid} -ErrorAction Stop | Select-Object CPU,WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`], options));
      return { cpuMs: data.CPU * 1000, rssBytes: data.WorkingSet64, peakRssBytes: data.PeakWorkingSet64 };
    }
    const [cpu, rss] = execFileSync("ps", ["-p", String(pid), "-o", "time=,rss="], options).trim().split(/\s+/);
    const ms = cpu.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
    return { cpuMs: ms, rssBytes: Number(rss) * 1024, peakRssBytes: null };
  } catch { return null; }
}
