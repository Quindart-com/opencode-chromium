import { test, expect } from "bun:test";
import { reserve, validatePricing } from "../../scripts/benchmark-cost-guard.ts";

test("benchmark reserves every request, including failed requests, up to the limit", () => {
  let total = 0;
  for (let i = 0; i < 25; i++) total = reserve(total)!;
  expect(total).toBe(5);
  expect(reserve(total)).toBeNull();
  expect(reserve(NaN)).toBeNull();
});

test("benchmark rejects missing, more expensive, or unbounded model pricing", () => {
  const row = { id: "model", context_length: 1_050_000, pricing: { prompt: "0.0000001", completion: "0" } };
  expect(() => validatePricing([row], ["model"])).not.toThrow();
  expect(() => validatePricing([], ["model"])).toThrow();
  expect(() => validatePricing([{ ...row, context_length: 1_050_001 }], ["model"])).toThrow();
  expect(() => validatePricing([{ ...row, pricing: { ...row.pricing, prompt: "0.000001" } }], ["model"])).toThrow();
  expect(() => validatePricing([{ ...row, pricing: { ...row.pricing, completion: "1" } }], ["model"])).toThrow();
});
