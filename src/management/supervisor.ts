import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installRelease,validateRelease } from "../../native-host/src/runtime-updates.ts";
import { withRuntimeLock } from "../../native-host/src/runtime-lifecycle.ts";
import type { FileChange } from "./transaction.js";

export function supervisorFiles(dir: string): FileChange[] {
  const source = fileURLToPath(new URL("../../native-host/dist/", import.meta.url));
  const files = ["runtime-supervisor.js", "runtime-worker.js", "runtime-participants.js", "runtime-lifecycle.js"];
  return [...files.map(name => ({ name, content: fs.readFileSync(path.join(source, name), "utf8") })),
    { name: "package.json", content: '{"type":"module","private":true}\n' }].map(({ name, content }) => {
    const filePath = path.join(dir, "supervisor", "1", name);
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
