import { expect,test } from "bun:test";
import { legacyDecisionIdentity } from "../../src/shared/decision-catalog.ts";
import { providerModel,providerSettingsSchema } from "../../native-host/src/decisions/settings.ts";
import { JevProvider } from "../../native-host/src/decisions/provider.ts";

test("legacy attribution uses known model evidence and leaves unfamiliar names unassigned", () => {
  expect(legacyDecisionIdentity("openai/gpt-6-luna-decisions-20261029")).toEqual({ route: "openrouter", provider: "openai-decisions" });
  expect(legacyDecisionIdentity("gpt-6-luna")).toEqual({ route: "openai", provider: "openai-decisions" });
  for (const model of ["gpt-other-luna", "typesafe/jev-unknown", "openai/gpt-6-luna-decisions-unknown", null]) expect(legacyDecisionIdentity(model)).toBeUndefined();
});

test("custom model selection stays at the fixed service endpoint and images require explicit capability selection", async () => {
  const settings = providerSettingsSchema.parse({ provider: "openai-decisions", route: "openai", textModel: "custom-text", imageModelOverride: "custom-image" });
  expect(providerModel(settings)).toBe("custom-text"); expect(providerModel(settings, true)).toBe("custom-image");
  const calls: string[] = [];
  const fetcher = (async (url, init) => {
    calls.push(String(url)); const request = JSON.parse(String(init?.body));
    return Response.json({ model: request.model, answers: [{ type: "choice", name: "decision", choice: "save", confidence: 0.99, probabilities: [{ value: "save", probability: 0.99 }, { value: "__abstain", probability: 0.01 }] }], usage: { input_tokens: 1, output_tokens: 0 } });
  }) as typeof fetch;
  const request = { purpose: "select" as const, context: "Synthetic custom model test", instructions: "Select save", candidates: [{ id: "save", description: "Save" }] };
  expect((await new JevProvider("synthetic", fetcher, "custom-text", 1500, "openai").decide(request)).candidateId).toBe("save");
  const image = { ...request, image: "data:image/png;base64,YQ==" };
  expect((await new JevProvider("synthetic", fetcher, "custom-image", 1500, "openai").decide(image)).status).toBe("abstained");
  expect(calls).toHaveLength(1);
  expect((await new JevProvider("synthetic", fetcher, "custom-image", 1500, "openai", () => true, true).decide(image)).candidateId).toBe("save");
  expect(calls).toEqual(["https://api.openai.com/v1/decisions", "https://api.openai.com/v1/decisions"]);
});
