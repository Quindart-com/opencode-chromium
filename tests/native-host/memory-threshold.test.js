import assert from "node:assert/strict";
import test from "node:test";
import { CALIBRATION_PAIRS, sweepThreshold } from "../../tests/fixtures/memory-threshold-calibration.js";
import { DEFAULT_MEMORY_SIMILARITY_THRESHOLD } from "../../native-host/src/memory/index.js";

test("the default rejection threshold keeps the fixture false-positive rate under 5%", () => {
  const { positives, negatives } = sweepThreshold(CALIBRATION_PAIRS);
  const falsePositives = negatives.filter((item) => item.similarity >= DEFAULT_MEMORY_SIMILARITY_THRESHOLD).length;
  const truePositives = positives.filter((item) => item.similarity >= DEFAULT_MEMORY_SIMILARITY_THRESHOLD).length;
  assert.ok(
    falsePositives / negatives.length < 0.05,
    `false-positive rate ${(falsePositives / negatives.length).toFixed(3)} must stay below 0.05 at threshold ${DEFAULT_MEMORY_SIMILARITY_THRESHOLD}`,
  );
  assert.ok(truePositives > 0, "the gate must still admit clearly related queries");
});

test("per-profile thresholds are calibrated, not one arbitrary universal value", async () => {
  const { MEMORY_SIMILARITY_THRESHOLDS } = await import("../../native-host/src/memory/index.js");
  assert.equal(MEMORY_SIMILARITY_THRESHOLDS["embeddinggemma-300m:q4:d256:prompt-v1"], 0.38);
  assert.equal(MEMORY_SIMILARITY_THRESHOLDS["snowflake-arctic-embed-xs:q8:d384:prompt-v1"], 0.42);
  assert.notEqual(MEMORY_SIMILARITY_THRESHOLDS["embeddinggemma-300m:q4:d256:prompt-v1"], MEMORY_SIMILARITY_THRESHOLDS["snowflake-arctic-embed-xs:q8:d384:prompt-v1"]);
});
