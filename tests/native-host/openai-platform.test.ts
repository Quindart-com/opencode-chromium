import { expect, test } from "bun:test";
import { JevProvider } from "../../native-host/src/decisions/provider.ts";

const request = { purpose: "select" as const, context: "Find the save button", instructions: "Choose the save button", candidates: [{ id: "save", description: "Save" }] };
const answer = (model = "gpt-6-luna") => ({ model, answers: [{ type: "choice", name: "decision", choice: "save", confidence: 0.99, probabilities: [{ value: "save", probability: 0.99 }, { value: "__abstain", probability: 0.01 }] }], usage: { input_tokens: 12, output_tokens: 0 } });

test("direct OpenAI sends the Decisions API contract for text and images", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/decisions");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(answer());
  }) as typeof fetch;
  const provider = new JevProvider("fixture", fetcher, "gpt-6-luna", 1500, "openai");
  expect((await provider.decide(request)).candidateId).toBe("save");
  expect((await provider.decide({ ...request, image: "data:image/png;base64,YQ==" })).candidateId).toBe("save");
  expect(bodies[0]).toMatchObject({ model: "gpt-6-luna", input: request.context, questions: [{ name: "decision", type: "choice", choices: [{ value: "save" }, { value: "__abstain" }] }] });
  expect(bodies[1]).toMatchObject({ input: [{ role: "user", content: [{ type: "input_text" }, { type: "input_image", image_url: "data:image/png;base64,YQ==" }] }] });
});

test("direct OpenAI rejects unexpected models and duplicate or untrusted choices", async () => {
  for (const body of [answer("other"), { ...answer(), answers: [{ ...answer().answers[0], choice: "unknown" }] }, { ...answer(), answers: [{ ...answer().answers[0], probabilities: [{ value: "save", probability: 0.5 }, { value: "save", probability: 0.5 }] }] }]) {
    const provider = new JevProvider("fixture", (async () => Response.json(body)) as typeof fetch, "gpt-6-luna", 1500, "openai");
    expect((await provider.decide(request)).status).toBe("abstained");
  }
});
