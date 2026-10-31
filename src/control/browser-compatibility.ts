import fs from "node:fs";
import path from "node:path";
import { LEGACY_BROWSER_CONTRACT_VERSION } from "../shared/product.ts";
import { desiredRuntime,type RuntimeActivation,type RuntimeRelease } from "../shared/runtime-config.ts";
import { record } from "../shared/values.ts";

const positiveContract = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Releases predating explicit browser contracts use the original wire contract. */
export function browserContractsForRelease(release: RuntimeRelease): number[] {
  try {
    const pkg = record(JSON.parse(fs.readFileSync(path.join(release.root, "package.json"), "utf8")) as unknown);
    const current = positiveContract(pkg.browserContractVersion) ? Number(pkg.browserContractVersion) : LEGACY_BROWSER_CONTRACT_VERSION;
    const declared = Array.isArray(pkg.supportedBrowserContractVersions) ? pkg.supportedBrowserContractVersions.filter(positiveContract).map(Number) : [];
    return [...new Set(declared.length ? declared : [current])].sort((a, b) => a - b);
  } catch { return [LEGACY_BROWSER_CONTRACT_VERSION]; }
}

export function browserContractFromHello(params: unknown): number {
  const value = record(params).browserContractVersion;
  return positiveContract(value) ? Number(value) : LEGACY_BROWSER_CONTRACT_VERSION;
}

export function selectBrowserRelease(activation: RuntimeActivation, extensionContractVersion: number): RuntimeRelease | null {
  const desired = desiredRuntime(activation);
  for (const release of [desired, activation.fallback]) {
    if (release && browserContractsForRelease(release).includes(extensionContractVersion)) return release;
  }
  return null;
}

export function browserCompatibilityStatus(activation: RuntimeActivation, release: RuntimeRelease, extensionContractVersion: number) {
  const runtimeContractVersions = browserContractsForRelease(release);
  return {
    compatible: runtimeContractVersions.includes(extensionContractVersion),
    extensionContractVersion,
    runtimeContractVersions,
    runtimeVersion: release.version,
    selection: release.root === desiredRuntime(activation).root ? "desired" : "fallback",
  };
}
