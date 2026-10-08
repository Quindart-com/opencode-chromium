import { configureProvider, providerStatus } from "../../native-host/src/decisions/settings.js";

export function runProviderCommand(argv: string[]) {
  if (argv[0] === "status" || argv.length === 0) return providerStatus();
  if (argv[0] !== "configure") throw new Error("Usage: providers status | configure --provider off|jev|openai-decisions [--route typesafe|openrouter] [--share-text] [--key-env NAME]");
  const at = (flag: string) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  const route = at("--route") ?? (at("--provider") === "openai-decisions" ? "openrouter" : "typesafe");
  const settings = configureProvider({ provider: at("--provider") ?? "off", route,
    keyEnv: at("--key-env") ?? (route === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"),
    shareText: argv.includes("--share-text"), shareImages: argv.includes("--share-images") });
  return { ...settings, ...providerStatus() };
}
