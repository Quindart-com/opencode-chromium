import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import yazl from "yazl";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
execFileSync(process.execPath, [path.join(root, "scripts/firefox-safety-check.js")], { stdio: "inherit" });
const out = path.join(root, "dist-extension"); fs.mkdirSync(out, { recursive: true });
const sourceFile = path.join(out, `opencode-chromium-${version}-firefox-source.zip`);
const zip = new yazl.ZipFile();
const archiveOptions = { mtime: new Date("2020-01-01T00:00:00Z"), mode: 0o100644 };
// Explicit source allowlist: never package local configuration or credentials.
const collect = (dir, prefix) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
  const relative = `${prefix}/${e.name}`; const absolute = path.join(dir, e.name);
  if (e.isSymbolicLink()) throw new Error("Source archive cannot contain symlinks");
  if (e.isDirectory()) collect(absolute, relative); else zip.addFile(absolute, relative, archiveOptions);
} };
collect(path.join(root, "extension-src"), "extension-src");
for (const name of ["package.json", "bun.lock", "wxt.config.ts", "tsconfig.json", "LICENSE"]) zip.addFile(path.join(root, name), name, archiveOptions);
zip.addBuffer(Buffer.from(`Firefox source build — OpenCode Browser Plugin ${version}\n\nPrerequisites: Bun 1.3.6 and Node.js 22. Extract this source archive into an empty directory.\n\n1. bun install --frozen-lockfile --ignore-scripts\n2. bunx wxt build -b firefox --mv3\n\nThe complete unpacked Firefox add-on is written to extension-firefox/.\nNo environment variables, credentials, network services, or private source are required for the build.\nThe lockfile pins dependencies. WXT compiles the included TypeScript/React sources and static assets.\n`), "BUILD.txt", archiveOptions);
await new Promise((resolve, reject) => { const stream = fs.createWriteStream(sourceFile); stream.on("error", reject).on("close", resolve); zip.outputStream.on("error", reject).pipe(stream); zip.end(); });
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ ok: true, dryRun: true, version, sourceFile: path.basename(sourceFile), credentialsConfigured: Boolean(process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) }));
} else {
  const issuer = process.env.WEB_EXT_API_KEY, secret = process.env.WEB_EXT_API_SECRET;
  if (!issuer || !secret) throw new Error("Configure WEB_EXT_API_KEY and WEB_EXT_API_SECRET repository secrets");
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const base = "https://addons.mozilla.org/api/v5/addons/addon/opencode-browser-plugin%40quindart.com/versions/";
  let next = base + "?page_size=50", alreadySubmitted = false, pages = 0;
  while (next && !alreadySubmitted) {
    if (++pages > 100 || !next.startsWith(base)) throw new Error("AMO version pagination could not be verified; submission cancelled");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
    const jwt = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
    const response = await fetch(next, { headers: { Authorization: `JWT ${jwt}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (response.status === 404 && pages === 1) break;
    if (!response.ok) throw new Error(`AMO version check failed (${response.status}); submission cancelled`);
    const body = await response.json();
    if (!Array.isArray(body.results)) throw new Error("AMO version response is malformed; submission cancelled");
    alreadySubmitted = body.results.some(item => item.version === version);
    next = body.next;
  }
  if (alreadySubmitted) console.log(JSON.stringify({ ok: true, version, status: "already_submitted", message: "Check AMO review status; this does not imply publication." }));
  else {
    execFileSync(process.execPath, [path.join(root, "node_modules/web-ext/bin/web-ext.js"), "sign", "--source-dir", path.join(root, "extension-firefox"), "--channel", "listed", "--amo-metadata", path.join(root, "scripts/firefox-metadata.json"), "--upload-source-code", sourceFile, "--artifacts-dir", out, "--approval-timeout", "0", "--no-input", "--no-config-discovery"], { cwd: root, stdio: "inherit" });
    console.log(JSON.stringify({ ok: true, version, status: "submitted", message: "AMO review may be pending. Submission success does not imply public availability." }));
  }
}
