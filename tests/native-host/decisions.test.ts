import { test, expect } from "bun:test";
import { JevProvider, UnavailableProvider, decisionSchema } from "../../native-host/src/decisions/provider.ts";

const request = { purpose: "select" as const, context: "Settings dialog", instructions: "Select save", candidates: [{ id: "n1", description: "Save settings" }] };
function mockResponse(choice = "n1", confidence = 0.95) {
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice,
    confidence, probabilities: { n1: 0.95, __abstain: 0.05 } } }, usage: { input_tokens: 10, output_tokens: 0 } }));
}
test("Jev sends finite candidates to official endpoint and validates answers", async () => {
  const provider = new JevProvider("fake-test-key", (async (url, init) => {
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(init?.body));
    expect(body.questions.decision.criteria.n1).toBe("Save settings");
    expect(body.model).toBe("jev-1.13.0");
    return mockResponse();
  }) as typeof fetch);
  expect((await provider.decide(request)).candidateId).toBe("n1");
});
test("invalid IDs and low confidence abstain", async () => {
  expect((await new JevProvider("fake", (async () => mockResponse("arbitrary")) as typeof fetch).decide(request)).status).toBe("abstained");
  expect((await new JevProvider("fake", (async () => mockResponse("n1", 0.4)) as typeof fetch).decide(request)).status).toBe("abstained");
});
test("rate limits cannot disclose response bodies or credentials", async () => {
  const result = await new JevProvider("fake-secret", (async () => new Response("fake-secret", { status: 429 })) as typeof fetch).decide(request);
  expect(result.status).toBe("abstained");
  expect(JSON.stringify(result)).not.toContain("fake-secret");
});
test("timeout interrupts fetch and returns abstention", async () => {
  const provider = new JevProvider("fake", (async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch, "jev-1.13.0", 10);
  expect((await provider.decide(request)).status).toBe("abstained");
});
test("duplicate candidates are invalid and Luna is explicitly unavailable", async () => {
  expect(decisionSchema.safeParse({ ...request, candidates: [request.candidates[0], request.candidates[0]] }).success).toBe(false);
  expect((await new UnavailableProvider().decide()).status).toBe("unavailable");
});
test("OpenRouter uses its decisions endpoint and reports the dated model and cost", async () => {
  const provider = new JevProvider("fake", (async (url) => {
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    const body = await mockResponse().json();
    body.model = "typesafe/jev-1.13-20260917";
    body.usage.cost = 0.00002;
    return new Response(JSON.stringify(body));
  }) as typeof fetch, "typesafe/jev-1.13", 5000, "openrouter");
  const result = await provider.decide(request);
  expect(result.status).toBe("selected");
  expect(result.model).toBe("typesafe/jev-1.13-20260917");
  expect(result.usage?.cost).toBe(0.00002);
});
test("a failed OpenRouter request never switches endpoints", async () => {
  const endpoints: string[] = [];
  const provider = new JevProvider("fake", (async (url) => {
    endpoints.push(String(url));
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch, "typesafe/jev-1.13", 5000, "openrouter");
  expect((await provider.decide(request)).status).toBe("abstained");
  expect(endpoints).toEqual(["https://openrouter.ai/api/alpha/decisions"]);
});
