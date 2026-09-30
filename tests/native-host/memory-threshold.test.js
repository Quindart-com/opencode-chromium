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

// 1.7.2 compared a fixed 0.6 confidence gate against a 0.42 retrieval
// threshold, so every correct candidate in between was admitted by search and
// then discarded as "below confidence". The floor is now derived from the
// retrieval threshold, and this pins the invariant so the two cannot cross.
test("the auto-execute replay floor can never fall below its retrieval threshold", async () => {
  const {
    MEMORY_REPLAY_SIMILARITY_MARGIN,
    MEMORY_SIMILARITY_THRESHOLDS,
    memoryReplayThreshold,
    similarityThreshold,
  } = await import("../../native-host/src/memory/index.js");
  for (const profile of [null, ...Object.keys(MEMORY_SIMILARITY_THRESHOLDS)]) {
    const label = profile ?? "default";
    const retrieval = similarityThreshold(profile);
    const replay = memoryReplayThreshold(profile);
    assert.ok(replay >= retrieval, `replay floor ${replay} must not sit below retrieval ${retrieval} for ${label}`);
    assert.ok(replay >= retrieval + MEMORY_REPLAY_SIMILARITY_MARGIN - 1e-9, `replay floor must keep its margin for ${label}`);
    assert.ok(replay <= 0.9, `replay floor must stay reachable for ${label}`);
  }
});

test("the replay floor executes only clearly related recipes", async () => {
  const { memoryReplayThreshold } = await import("../../native-host/src/memory/index.js");
  const { positives, negatives } = sweepThreshold(CALIBRATION_PAIRS);
  const floor = memoryReplayThreshold("snowflake-arctic-embed-xs:q8:d384:prompt-v1");
  assert.equal(floor, 0.62);
  assert.equal(negatives.filter((item) => item.similarity >= floor).length, 0, "auto-execution must never admit an unrelated recipe");
  assert.ok(positives.filter((item) => item.similarity >= floor).length >= 3, "auto-execution must still admit clearly related recipes");
});
