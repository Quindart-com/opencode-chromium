import { createRuntimeUpdater,installGlobalRelease,newerRelease,releaseVersion } from "../../native-host/src/runtime-updates.ts";
import { npmMetadata } from "./npm-metadata.ts";
import { record } from "../shared/values.ts";
import fs from "node:fs";
import path from "node:path";
import { detectHarnesses } from "./harnesses.ts";
import { nativeCodexPluginEnabled } from "./configuration.ts";
import { planSkills } from "./skills.ts";
import { refreshBrowserMarketplace } from "./marketplace.ts";
import { applyTransaction } from "./transaction.ts";

function refreshInstalledSkills(root: string) {
  const targets = detectHarnesses().filter(row => row.managed && (row.id !== "codex" || !nativeCodexPluginEnabled(fs.readFileSync(row.configPath, "utf8")))).map(row => row.id);
  return applyTransaction(planSkills(root, targets)).changedFiles.length;
}

export async function publishedVersion(metadata: () => Promise<unknown> = npmMetadata) {
  const data = record(await metadata());
  if (data.name !== "opencode-chromium" || !releaseVersion(data.version)) throw new Error("invalid_release");
  return data.version;
}
export async function installPublishedUpdate(dir: string, {
  latest = publishedVersion, updater = createRuntimeUpdater({ dir }), globalInstall = installGlobalRelease, refreshSkills = refreshInstalledSkills, refreshMarketplace = refreshBrowserMarketplace,
}: { latest?: typeof publishedVersion; updater?: ReturnType<typeof createRuntimeUpdater>; globalInstall?: typeof installGlobalRelease; refreshSkills?: typeof refreshInstalledSkills; refreshMarketplace?: typeof refreshBrowserMarketplace } = {}) {
  const before = updater.status({ includeParticipants: false });
  if (!before.supported || !releaseVersion(before.installedVersion)) return { ok: false, code: "unmanaged_runtime" };
  const version = await latest();
  if (newerRelease(before.installedVersion, version)) return { ok: true, code: "updated", version: before.installedVersion };
  await updater.tick(version, { manual: true });
  const status = updater.status({ includeParticipants: false });
  if (status.state === "retry" || status.state === "reconnect_required") return { ok: false, code: status.state };
  await globalInstall(version);
  const activation = record(JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as unknown), staged = record(activation.stagedRelease);
  const root = staged.version === version ? staged.root : activation.root;
  if (typeof root === "string") refreshSkills(root);
  const marketplace = await refreshMarketplace({ version, dir });
  return { ok: true, code: status.stagedVersion ? "update_waiting" : "updated", version, marketplace };
}
