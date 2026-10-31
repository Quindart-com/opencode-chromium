import { configureProvider,providerStatus } from "../../native-host/src/decisions/settings.js";
import { decisionServices,type DecisionRoute } from "../shared/decision-catalog.ts";

export function runProviderCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) return { usage: "providers status | configure --provider off|jev|openai-decisions [--route typesafe|openrouter|openai] [--model MODEL] [--image-model MODEL] [--share-text] [--share-images] [--key-env NAME]" };
  if (argv[0] === "status" || argv.length === 0) return providerStatus();
  if (argv[0] !== "configure") throw new Error("Usage: providers status | configure --provider off|jev|openai-decisions [--route typesafe|openrouter|openai] [--model MODEL] [--image-model MODEL] [--share-text] [--share-images] [--key-env NAME]");
  const at = (flag: string) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  const route = at("--route") ?? (at("--provider") === "openai-decisions" ? "openrouter" : "typesafe");
  const settings = configureProvider({ provider: at("--provider") ?? "off", route,
    keyEnv: at("--key-env") ?? decisionServices[route as DecisionRoute]?.keyEnv,
    textModel: at("--model"), imageModelOverride: at("--image-model"),
    shareText: argv.includes("--share-text"), shareImages: argv.includes("--share-images") });
  return { ...settings, ...providerStatus() };
}
