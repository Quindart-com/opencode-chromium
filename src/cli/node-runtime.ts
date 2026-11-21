import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const MINIMUM_NODE_MAJOR = 24;

/**
 * Interpreters inside these locations belong to a harness and can disappear on
 * a harness update, so a browser launcher must not be pinned to them.
 * Keep this list small: only directories known to hold harness-private Node.
 */
const HARNESS_PRIVATE_PATTERNS = [/[\\/]\.cache[\\/]codex-runtimes[\\/]/i, /[\\/]codex-runtimes[\\/]/i];

export const harnessPrivateNode = (execPath: string) => HARNESS_PRIVATE_PATTERNS.some(pattern => pattern.test(execPath));

export interface NodeRuntimeDeps {
  execPath: string;
  version: string;
  platform: NodeJS.Platform;
  /** Candidate node executables found on PATH, in PATH order. */
  pathCandidates(): string[];
  /** Output of `<node> --version`, or null when it cannot be run. */
  versionOf(executable: string): string | null;
  exists(file: string): boolean;
}

export interface NodeRuntimeChoice { execPath: string; warning?: string }

const major = (version: string | null) => {
  const value = Number(/^v?(\d+)\./.exec(version?.trim() ?? "")?.[1]);
  return Number.isFinite(value) ? value : 0;
};

export function selectNodeRuntime(deps: NodeRuntimeDeps): NodeRuntimeChoice {
  const suitable = (version: string | null, file: string) => major(version) >= MINIMUM_NODE_MAJOR && !harnessPrivateNode(file);
  if (suitable(deps.version, deps.execPath)) return { execPath: deps.execPath };
  for (const candidate of deps.pathCandidates()) {
    if (candidate === deps.execPath || !deps.exists(candidate) || harnessPrivateNode(candidate)) continue;
    if (suitable(deps.versionOf(candidate), candidate)) return { execPath: candidate };
  }
  const reason = harnessPrivateNode(deps.execPath) ? "is private to an app and may disappear when it updates" : `is Node ${deps.version}, but Node ${MINIMUM_NODE_MAJOR} or newer is required`;
  return { execPath: deps.execPath, warning: `The browser launcher uses ${deps.execPath}, which ${reason}. Install Node ${MINIMUM_NODE_MAJOR}+ and rerun setup.` };
}

export function systemNodeRuntimeDeps(): NodeRuntimeDeps {
  return {
    execPath: process.execPath,
    version: process.versions.node,
    platform: process.platform,
    pathCandidates() {
      try {
        const output = process.platform === "win32" ? execFileSync("where", ["node"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 })
          : execFileSync("which", ["-a", "node"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
        return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      } catch { return []; }
    },
    versionOf(executable) {
      try { return execFileSync(executable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 }); } catch { return null; }
    },
    exists: file => fs.existsSync(file),
  };
}

export const chooseNodeRuntime = () => selectNodeRuntime(systemNodeRuntimeDeps());
