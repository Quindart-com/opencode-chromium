import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonIfPresent } from "../../shared/node-files.ts";
import { PRODUCT } from "../../shared/product.ts";
import { record } from "../../shared/values.ts";

export const LADYBIRD_PROFILE = "ladybird";
export const LADYBIRD_LABEL = "Ladybird (Experimental)";
export const LADYBIRD_PLATFORM_SUPPORTED = process.platform === "linux" || process.platform === "darwin";

export interface LadybirdConfig {
  driver: string;
}

export function ladybirdConfigPath() {
  const configured = process.env[PRODUCT.runtimeEnvironment];
  const directory = configured ? path.resolve(configured) : path.join(os.homedir(), ".config", "opencode", "browser");
  return path.join(directory, "ladybird.json");
}

export function validateLadybirdConfig(input: unknown): LadybirdConfig {
  if (!LADYBIRD_PLATFORM_SUPPORTED) {
    throw new Error("Ladybird support is available on Linux and macOS.");
  }
  const { driver } = record(input);
  if (typeof driver !== "string" || !path.posix.isAbsolute(driver) || [...driver].some(char => char.charCodeAt(0) < 32)) {
    throw new Error("Provide the absolute path to Ladybird's WebDriver executable.");
  }
  fs.accessSync(driver, fs.constants.X_OK);
  return { driver };
}

export function readLadybirdConfig(): LadybirdConfig | null {
  if (!LADYBIRD_PLATFORM_SUPPORTED) return null;
  try {
    const file = ladybirdConfigPath();
    if (fs.existsSync(file)) return validateLadybirdConfig(readJsonIfPresent(file));
    if (process.platform === "linux") return validateLadybirdConfig({ driver: "/opt/ladybird/bin/WebDriver" });
    if (process.platform === "darwin" && process.arch === "arm64") {
      return validateLadybirdConfig({ driver: "/Applications/Ladybird.app/Contents/MacOS/WebDriver" });
    }
  } catch { /* A missing or invalid driver is not available for selection. */ }
  return null;
}
