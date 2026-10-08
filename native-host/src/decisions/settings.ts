import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { protectKey, revealKey } from "./credentials.js";

export const providerSettingsSchema = z.object({
  provider: z.enum(["off", "jev", "openai-decisions"]).default("off"),
  route: z.enum(["typesafe", "openrouter"]).default("typesafe"),
  shareText: z.boolean().default(false), shareImages: z.boolean().default(false),
  keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("TYPESAFE_API_KEY"),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export const LUNA_MODEL = "openai/gpt-6-luna-decisions";
export function providerModel(settings: ProviderSettings): string | null {
  return settings.provider === "openai-decisions" ? LUNA_MODEL : settings.provider === "jev" ? (settings.route === "openrouter" ? "typesafe/jev-1.13-20260917" : "jev-1.13.0") : null;
}
export function providerSettingsPath(): string {
  const base = process.env.AGENT_BROWSER_PROVIDER_DIR ?? (process.platform === "win32" ?
    path.join(process.env.LOCALAPPDATA ?? os.homedir(), "OpenCodeBrowser", "providers") :
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode-browser", "providers"));
  return path.join(base, "settings.json");
}
export function credentialPath(): string { return path.join(path.dirname(providerSettingsPath()), "credentials.json"); }
export function providerKey(settings: ProviderSettings): string | undefined {
  try {
    const stored = JSON.parse(fs.readFileSync(credentialPath(), "utf8"));
    if (typeof stored[settings.route] === "string" && stored[settings.route]) return revealKey(stored[settings.route]);
  } catch { /* Environment-only installations need no credential file. */ }
  return process.env[settings.keyEnv];
}
export function storeProviderKey(route: ProviderSettings["route"], key: string | null): void {
  const file = credentialPath();
  let credentials: Record<string, string> = {};
  try { credentials = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* First setup. */ }
  if (key === null) delete credentials[route]; else credentials[route] = protectKey(key);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(credentials), { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function getProviderSettings(): ProviderSettings {
  const file = providerSettingsPath();
  return fs.existsSync(file) ? providerSettingsSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : providerSettingsSchema.parse({});
}
export function configureProvider(settings: unknown): ProviderSettings {
  const validated = providerSettingsSchema.parse(settings);
  if (validated.provider === "jev" && validated.shareImages) throw new Error("Jev accepts text only");
  if (validated.provider === "openai-decisions" && validated.route !== "openrouter") throw new Error("Luna requires OpenRouter");
  const file = providerSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return validated;
}
export function providerStatus() {
  const settings = getProviderSettings();
  const credentialConfigured = Boolean(providerKey(settings));
  const ready = settings.provider !== "off" && (settings.provider !== "openai-decisions" || settings.route === "openrouter") && settings.shareText && credentialConfigured;
  return { ...settings, ready, credentialConfigured, model: providerModel(settings),
    reason: ready ? null : "Disabled, text sharing not enabled, or credential environment variable missing" };
}
