import { test, expect } from "bun:test";
import { PNG } from "pngjs";
import { JevProvider } from "../../native-host/src/decisions/provider.ts";
import { boundedJevImage } from "../../native-host/src/decisions/jev-image.ts";

const picture = (width = 320, height = 280) => `data:image/png;base64,${PNG.sync.write(new PNG({ width, height })).toString("base64")}`;
const request = { purpose: "rank" as const, context: "Choose the green control", instructions: "Choose a known ID", candidates: [{ id: "a", description: "Apply on the left" }, { id: "b", description: "Apply on the right" }] };
const answer = (model: string) => new Response(JSON.stringify({ model, answers: { decision: { type: "choice", choice: "b", confidence: 0.95, probabilities: { a: 0.02, b: 0.95, __abstain: 0.03 } } }, usage: { input_tokens: 500, output_tokens: 0, cost: 0.000021 } }));

test("TypeSafe Jev image uses one referenced asset and the experimental header", async () => {
  let calls = 0;
  const provider = new JevProvider("fixture", (async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init?.headers as Record<string, string>)["TypeSafe-Danger-Zone-Images"]).toBe("true");
    const body = JSON.parse(String(init?.body)), id = body.state.screenshot;
    expect(Object.keys(body.assets)).toEqual([id]);
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.state.text).toBe(request.context);
    expect(body.assets[id]).toEqual({ type: "image", format: "png", data_base64: picture().split(",")[1] });
    expect(JSON.stringify(body.questions)).not.toContain(id);
    return answer("jev-1.14.0");
  }) as typeof fetch, "jev-1.14.0");
  expect(await provider.decide({ ...request, image: picture() })).toMatchObject({ status: "selected", candidateId: "b", usage: { input_tokens: 500 } });
  expect(calls).toBe(1);
});

test("OpenRouter Jev uses an image part, accepts only its canonical model, and leaves text unchanged", async () => {
  const bodies: any[] = [];
  const provider = new JevProvider("fixture", (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    expect((init?.headers as Record<string, string>)["TypeSafe-Danger-Zone-Images"]).toBeUndefined();
    return answer("typesafe/jev-1.14-20261014");
  }) as typeof fetch, "typesafe/jev-1.14", 1500, "openrouter");
  expect((await provider.decide(request)).status).toBe("selected");
  expect((await provider.decide({ ...request, image: picture() })).status).toBe("selected");
  expect(bodies[0].state).toBe(request.context);
  expect(bodies[1].state).toEqual([request.context, { type: "image_url", image_url: { url: picture(), detail: "low" } }]);
  expect(bodies[1].assets).toBeUndefined();
});

test("malformed, tiny, oversized, animated and unsupported images never reach Jev", async () => {
  let calls = 0;
  const provider = new JevProvider("fixture", (async () => { calls++; return answer("jev-1.14.0"); }) as typeof fetch, "jev-1.14.0");
  for (const image of [picture(279, 320), picture(769, 320), "data:image/png;base64,YQ==", "data:image/webp;base64,YQ==", "https://example.test/photo.jpg"]) {
    expect((await provider.decide({ ...request, image })).status).toBe("abstained");
  }
  const png = Buffer.from(picture().split(",")[1]!, "base64");
  png.write("acTL", 37, "ascii");
  expect(boundedJevImage(`data:image/png;base64,${png.toString("base64")}`)).toBe(false);
  expect(calls).toBe(0);
});

test("provider switches share the concurrency cap and queued consent is checked before sending", async () => {
  let active = 0, maximum = 0, allowed = true, calls = 0;
  const fetcher = (async () => {
    calls++; maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 20)); active--; return answer("jev-1.14.0");
  }) as typeof fetch;
  const providers = Array.from({ length: 3 }, () => new JevProvider("fixture", fetcher, "jev-1.14.0", 1500, "typesafe", () => allowed));
  const pending = providers.map(provider => provider.decide(request));
  await new Promise(resolve => setTimeout(resolve, 5)); allowed = false;
  const results = await Promise.all(pending);
  expect(maximum).toBe(2); expect(calls).toBe(2);
  expect(results[2]).toMatchObject({ status: "abstained", reason: "settings_changed" });
});
