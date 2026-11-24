import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonIfPresent } from "../../shared/node-files.ts";
import { PRODUCT } from "../../shared/product.ts";
import { record } from "../../shared/values.ts";

export const LADYBIRD_PROFILE = "ladybird";
export const LADYBIRD_LABEL = "Ladybird (Experimental)";

export interface LadybirdConfig {
  driver: string;
  distro?: string;
}

export function ladybirdConfigPath() {
  const configured = process.env[PRODUCT.runtimeEnvironment];
  const directory = configured ? path.resolve(configured) : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), ...PRODUCT.runtimeDirectory)
    : path.join(os.homedir(), ".config", "opencode", "browser");
  return path.join(directory, "ladybird.json");
}

export function validateLadybirdConfig(input: unknown): LadybirdConfig {
  const { driver, distro } = record(input);
  if (process.platform === "win32") {
    if (typeof distro !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(distro) || distro.startsWith("-")) {
      throw new Error("Ladybird on Windows requires a WSL2 distribution name. Use --wsl Ubuntu or the name shown by wsl --list.");
    }
  } else if (distro !== undefined || !["linux", "darwin"].includes(process.platform)) {
    throw new Error("Run Ladybird on Linux, macOS, or Windows with WSL2.");
  }
  if (typeof driver !== "string" || !path.posix.isAbsolute(driver) || [...driver].some(char => char.charCodeAt(0) < 32)) {
    throw new Error("Provide the absolute path to Ladybird's WebDriver executable.");
  }
  if (process.platform !== "win32") fs.accessSync(driver, fs.constants.X_OK);
  return { driver, ...(typeof distro === "string" ? { distro } : {}) };
}

export function readLadybirdConfig(): LadybirdConfig | null {
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
