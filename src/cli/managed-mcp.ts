import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeDirectory,parseRuntimeActivation,withRuntimeLock } from "../../native-host/src/runtime-lifecycle.ts";
import { atomicJson } from "../../native-host/src/runtime-participants.ts";
import { ensureManagedRelease,supervisorFiles } from "../management/supervisor.ts";
import { packageInfo } from "./version.ts";

/** Native plugin installations share the same runtime as setup-managed clients. */
export async function managedMcp(args: string[]) {
  if (args.some(arg => arg.startsWith("--transport") || arg.startsWith("--toolset"))) throw new Error("Managed MCP uses the core stdio transport");
  const dir = runtimeDirectory(), manifest = path.join(dir, "runtime.json");
  if (!fs.existsSync(manifest)) {
    const version = packageInfo().version;
    if (typeof version !== "string") throw new Error("Missing package version");
    const root = await ensureManagedRelease(dir, version);
    await withRuntimeLock(dir, () => {
      if (fs.existsSync(manifest)) return;
      for (const file of supervisorFiles(dir)) { fs.mkdirSync(path.dirname(file.filePath), { recursive: true }); fs.writeFileSync(file.filePath, file.after!, "utf8"); }
      atomicJson(manifest, { root, version, autoUpdate: true, channel: "production", generation: 0 });
    });
  }
  const activation = parseRuntimeActivation(JSON.parse(fs.readFileSync(manifest, "utf8")) as unknown);
  if (activation.followBranch || fs.existsSync(path.join(activation.root, "src"))) {
    process.env.OPENCODE_BROWSER_RUNTIME_DIR = dir;
    const server = await import(pathToFileURL(path.join(activation.root, "dist/adapters/mcp/server.js")).href) as { main(args: string[]): Promise<void> };
    await server.main(args); return;
  }
  const supervisor = path.join(dir, "supervisor/1/runtime-supervisor.js");
  if (!fs.existsSync(supervisor)) throw new Error("Run opencode-chromium setup --all once, then reconnect MCP to enable automatic activation");
  await (await import(pathToFileURL(supervisor).href) as { superviseMcp(dir: string, args: string[]): Promise<void> }).superviseMcp(dir, args);
}
