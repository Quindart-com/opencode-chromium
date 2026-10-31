import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withRuntimeLock } from "../control/state.ts";
import { installRelease,validateRelease } from "../control/update.ts";
import type { FileChange } from "./transaction.js";

export function supervisorFiles(dir: string): FileChange[] {
  const source = fileURLToPath(new URL("../../dist/", import.meta.url));
  const control = ["activation.js", "auth.js", "browser-broker.js", "browser-compatibility.js", "controller.js", "harness-control.js", "jobs.js", "leases.js", "mcp-supervisor.js", "mcp-worker.js", "npm-client.js", "process.js", "reconcile.js", "state.js", "update.js"];
  const shared = ["connections.js", "control-protocol.js", "harnesses.js", "node-files.js", "node-framing.js", "product.js", "profile-registry.js", "runtime-config.js", "semver.js", "values.js"];
  const files = [
    ...control.map(name => ({ name: path.join("control", name), content: fs.readFileSync(path.join(source, "control", name), "utf8") })),
    ...shared.map(name => ({ name: path.join("shared", name), content: fs.readFileSync(path.join(source, "shared", name), "utf8") })),
    { name: "package.json", content: '{"type":"module","private":true}\n' },
  ];
  return files.map(({ name, content }) => {
    const filePath = path.join(dir, "controller", "2", name);
    return { filePath, before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after: content };
  });
}
export async function ensureManagedRelease(dir: string, version: string) {
  return withRuntimeLock(dir, async () => {
    const destination = path.join(dir, "releases", version), root = path.join(destination, "node_modules/opencode-chromium");
    if (fs.existsSync(destination)) { validateRelease(root, version); return root; }
    const stage = path.join(dir, `bootstrap-${randomUUID()}`);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      await installRelease(stage, version);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(stage, destination);
      return root;
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
  }, "update-worker.lock");
}
