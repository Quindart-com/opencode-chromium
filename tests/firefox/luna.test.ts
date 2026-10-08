import { test, expect } from "bun:test";
import { JevProvider } from "../../native-host/src/decisions/provider.ts";
const model = "openai/gpt-6-luna-decisions";
const request = { purpose: "rank" as const, context: "Choose the blue control", instructions: "Choose among known IDs", candidates: [{ id: "blue", description: "First control" }, { id: "red", description: "Second control" }] };
const response = (choice = "blue", probabilities = { blue: 0.9, red: 0.08, __abstain: 0.02 }) => new Response(JSON.stringify({ model, answers: { decision: { type: "choice", choice, probabilities, confidence: 0.9 } }, usage: { input_tokens: 90, output_tokens: 0, cost: 0.000009 } }));
test("Luna text and bounded image use the documented Decisions state contract", async () => {
  const bodies: any[] = [];
  const provider = new JevProvider("synthetic", (async (url, init) => { expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions"); bodies.push(JSON.parse(String(init?.body))); return response(); }) as typeof fetch, model, 1500, "openrouter");
  expect((await provider.decide(request)).candidateId).toBe("blue");
  expect((await provider.decide({ ...request, image: "data:image/png;base64,YQ==" })).candidateId).toBe("blue");
  expect(bodies[0].state).toBe(request.context);
  expect(bodies[1].state).toEqual([request.context, { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "low" } }]);
});
test("malformed probabilities and unknown targets abstain", async () => {
  for (const result of [() => response("unknown"), () => response("blue", { blue: 0.99, red: 0.99, __abstain: 0.01 })]) {
    const provider = new JevProvider("synthetic", (async () => result()) as typeof fetch, model, 1500, "openrouter");
    expect(await provider.decide(request)).toMatchObject({ status: "abstained", reason: "invalid_decision" });
  }
});
test("Luna accepts its dated canonical response ID but rejects another model", async () => {
  for (const [returnedModel, expected] of [["openai/gpt-6-luna-decisions-20261006", "selected"], ["openai/gpt-6-luna", "abstained"], ["openai/gpt-6-luna-decisions-untrusted", "abstained"]] as const) {
    const provider = new JevProvider("synthetic", (async () => { const body = await response().json(); body.model = returnedModel; return new Response(JSON.stringify(body)); }) as typeof fetch, model, 1500, "openrouter");
    expect((await provider.decide(request)).status).toBe(expected);
  }
});
test("credential, credit and rate errors fall back without retry", async () => {
  for (const [status, reason] of [[401, "invalid_key"], [402, "insufficient_credit"], [429, "rate_limited"]] as const) {
    let calls = 0; const provider = new JevProvider("synthetic", (async () => { calls++; return new Response("private", { status }); }) as typeof fetch, model, 1500, "openrouter");
    expect(await provider.decide(request)).toMatchObject({ status: "abstained", reason }); expect(calls).toBe(1);
  }
});
test("cancellation and timeouts abort the paid request", async () => {
  let aborted = false;
  const fetcher = (async (_url, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }); })) as typeof fetch;
  const provider = new JevProvider("synthetic", fetcher, model, 30, "openrouter");
  expect((await provider.decide(request)).status).toBe("abstained"); expect(aborted).toBe(true);
  aborted = false; const controller = new AbortController(); const pending = provider.decide(request, controller.signal); setTimeout(() => controller.abort(), 5);
  expect((await pending).reason).toBe("cancelled"); expect(aborted).toBe(true);
});
test("Jev remains text-only and rejects oversized or external images", async () => {
  let calls = 0; const provider = new JevProvider("synthetic", (async () => { calls++; return response(); }) as typeof fetch);
  expect((await provider.decide({ ...request, image: "data:image/png;base64,YQ==" })).reason).toBe("images_not_supported");
  expect((await provider.decide({ ...request, image: "https://private.test/image" })).status).toBe("abstained"); expect(calls).toBe(0);
});
