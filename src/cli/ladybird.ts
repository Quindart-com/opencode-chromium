import { parseArgs } from "node:util";
import { LADYBIRD_LABEL,LADYBIRD_PROFILE,ladybirdConfigPath,readLadybirdConfig,validateLadybirdConfig } from "../browser/ladybird/config.ts";
import { atomicWrite } from "../management/transaction.ts";

export function runLadybirdCommand(argv: string[]) {
  const usage = "ladybird configure --driver /absolute/path/to/WebDriver [--wsl DISTRO] [--dry-run] | ladybird status";
  const { positionals: [command, ...extra], values } = parseArgs({
    args: argv, allowPositionals: true,
    options: { driver: { type: "string" }, wsl: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help || !command) return { usage, experimental: true };
  const profile = { profileId: LADYBIRD_PROFILE, profileLabel: LADYBIRD_LABEL, experimental: true };
  if (command === "status" && !extra.length && Object.keys(values).length === 0) {
    const config = readLadybirdConfig();
    return { ...profile, available: Boolean(config), ...(config ?? {}),
      instruction: config ? "Select Ladybird using the normal browser profile selector. The driver is checked when opening a tab." : usage };
  }
  if (command !== "configure" || extra.length) throw new Error(usage);
  const config = validateLadybirdConfig({ driver: values.driver, distro: values.wsl });
  const file = ladybirdConfigPath();
  if (!values["dry-run"]) atomicWrite(file, JSON.stringify(config, null, 2) + "\n");
  return { ...profile, ...config, configPath: file, dryRun: values["dry-run"] === true };
}
