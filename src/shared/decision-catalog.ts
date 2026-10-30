/** Fixed service URLs are a credential boundary; model choices are explicit settings. */
export const decisionServices = {
  typesafe: { label: "TypeSafe", keyEnv: "TYPESAFE_API_KEY", endpoint: "https://api.typesafe.ai/v1/systemone" },
  openrouter: { label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", endpoint: "https://openrouter.ai/api/alpha/decisions" },
  openai: { label: "OpenAI Platform", keyEnv: "OPENAI_API_KEY", endpoint: "https://api.openai.com/v1/decisions" },
} as const;
export type DecisionRoute = keyof typeof decisionServices;
export type DecisionFamily = "jev" | "openai-decisions";
export const decisionFamilies = { jev: "Jev", "openai-decisions": "Luna" } as const;
export const decisionChoices = [
  { id: "jev-openrouter", provider: "jev", route: "openrouter", model: "typesafe/jev-1.13-20260917", imageModel: "typesafe/jev-1.14", aliases: ["typesafe/jev-1.13"] },
  { id: "jev-typesafe", provider: "jev", route: "typesafe", model: "jev-1.13.0", imageModel: "jev-1.14.0", aliases: [] },
  { id: "openai-decisions", provider: "openai-decisions", route: "openrouter", model: "openai/gpt-6-luna-decisions", imageModel: "openai/gpt-6-luna-decisions", aliases: [] },
  { id: "openai-direct", provider: "openai-decisions", route: "openai", model: "gpt-6-luna", imageModel: "gpt-6-luna", aliases: [] },
] satisfies Array<{ id: string; provider: DecisionFamily; route: DecisionRoute; model: string; imageModel: string; aliases: string[] }>;
export function decisionChoice(settings: { provider: string; route: string }) { return decisionChoices.find(choice => choice.provider === settings.provider && choice.route === settings.route); }
export function decisionServiceLabel(route: string): string | undefined { return Object.hasOwn(decisionServices, route) ? decisionServices[route as DecisionRoute].label : undefined; }
export function decisionFamilyLabel(provider: string): string { return Object.hasOwn(decisionFamilies, provider) ? decisionFamilies[provider as DecisionFamily] : ""; }
export function decisionModelMatches(requested: string, returned: string, route: string) {
  if (requested === returned) return true;
  const aliases = decisionChoices.filter(choice => choice.route === route).flatMap(choice => [...choice.aliases, choice.imageModel, choice.model]);
  return route === "openrouter" && aliases.includes(requested) && /^\d{8}$/.test(returned.slice(requested.length + 1)) && returned.startsWith(requested + "-");
}
export function decisionImageCapable(route: string, model: string) { return decisionChoices.some(choice => choice.route === route && choice.imageModel === model); }
export function legacyDecisionIdentity(model: string | null) {
  if (!model) return undefined;
  const found = decisionChoices.filter(choice => [choice.model, choice.imageModel, ...choice.aliases].some(candidate => decisionModelMatches(candidate, model, choice.route)));
  return found.length === 1 ? { route: found[0]!.route, provider: found[0]!.provider } : undefined;
}
