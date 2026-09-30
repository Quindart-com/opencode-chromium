import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const providerSettingsSchema = z.object({
  provider: z.enum(["off", "jev", "openai-decisions"]).default("off"),
  route: z.enum(["typesafe", "openrouter"]).default("typesafe"),
  shareText: z.boolean().default(false), shareImages: z.boolean().default(false),
  keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("TYPESAFE_API_KEY"),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export function providerSettingsPath(): string {
  const base = process.env.AGENT_BROWSER_PROVIDER_DIR ?? (process.platform === "win32" ?
    path.join(process.env.LOCALAPPDATA ?? os.homedir(), "OpenCodeBrowser", "providers") :
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode-browser", "providers"));
  return path.join(base, "settings.json");
}
export function getProviderSettings(): ProviderSettings {
  const file = providerSettingsPath();
  return fs.existsSync(file) ? providerSettingsSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : providerSettingsSchema.parse({});
}
export function configureProvider(settings: unknown): ProviderSettings {
  const validated = providerSettingsSchema.parse(settings);
  if (validated.provider === "jev" && validated.shareImages) throw new Error("Jev accepts text only");
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
  const ready = settings.provider === "jev" && settings.shareText && Boolean(process.env[settings.keyEnv]);
  return { ...settings, ready, experimental: true, model: settings.provider === "jev" ? (settings.route === "openrouter" ? "typesafe/jev-1.13-20260917" : "jev-1.13.0") : null,
    reason: settings.provider === "openai-decisions" ? "Preview API contract/access unavailable" : ready ? null : "Disabled, text sharing not enabled, or credential environment variable missing" };
}
