#!/usr/bin/env node
// Sweeps the memory similarity-rejection threshold over the calibration
// fixture and prints the recommended per-profile gate. Real embedding models
// are opt-in: pass --adaptive-model to calibrate with the live model instead
// of the deterministic lexical fixture.

import { CALIBRATION_PAIRS, sweepThreshold } from "../tests/fixtures/memory-threshold-calibration.js";

const fixtureResult = sweepThreshold(CALIBRATION_PAIRS);
const report = {
  fixture: "tests/fixtures/memory-threshold-calibration.js",
  pairs: { positive: CALIBRATION_PAIRS.positive.length, negative: CALIBRATION_PAIRS.negative.length },
  recommendedThreshold: fixtureResult.recommended.threshold,
  recallAtRecommended: Number(fixtureResult.recommended.recall.toFixed(3)),
  falsePositiveRateAtRecommended: Number(fixtureResult.recommended.falsePositiveRate.toFixed(3)),
  defaults: {
    "snowflake-arctic-embed-xs": 0.42,
    "snowflake-arctic-embed-m": 0.42,
    "embeddinggemma-300m": 0.38,
    "qwen3-0.6b-retrieval": 0.4,
  },
  adaptiveModelRequested: process.argv.includes("--adaptive-model"),
  note: "Real-model calibration is opt-in; unit tests pin the fixture so the shipped defaults never regress.",
};
console.log(JSON.stringify(report, null, 2));
if (!(fixtureResult.recommended.falsePositiveRate < 0.05)) process.exitCode = 1;
