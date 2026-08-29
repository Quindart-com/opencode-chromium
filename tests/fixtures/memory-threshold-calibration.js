// Deterministic concept fixture for calibrating the memory rejection gate.
// Domain concepts occupy fixed coordinates, so positively related texts share
// components (high similarity) and unrelated texts share almost none. This
// mimics trained-embedding separation without downloading a model. Real-model
// calibration is opt-in via scripts/benchmark-memory-threshold.js.

const CONCEPTS = [
  "settings", "toggle", "notification", "workspace", "rename", "name",
  "checkout", "pay", "card", "billing", "account",
  "github", "repository", "issue", "search", "query", "enter",
  "network", "inspect", "request", "log",
  "modal", "save", "compact", "mode", "open",
  "filter", "table", "row", "detail",
  "theme", "dark", "upload", "file", "ticket", "delete", "draft", "document",
  "actions", "pull",
];

const DIMS = CONCEPTS.length;

function conceptIndexFor(token) {
  for (let index = 0; index < CONCEPTS.length; index += 1) {
    const concept = CONCEPTS[index];
    if (token === concept) return index;
    if (token.length > 4 && (token.startsWith(concept) || concept.startsWith(token))) return index;
  }
  return -1;
}

export function embedFixtureText(text) {
  const vector = new Float32Array(DIMS);
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    const index = conceptIndexFor(token);
    if (index !== -1) vector[index] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return Array.from(vector);
  return Array.from(vector, (value) => value / magnitude);
}

export function dot(first, second) {
  let total = 0;
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) total += first[index] * second[index];
  return total;
}

export const CALIBRATION_PAIRS = {
  positive: [
    ["rename my workspace", "example.com click settings | click workspace | fill workspace name | click save"],
    ["open billing settings", "example.com click account | click billing"],
    ["pay with saved card", "checkout.stripe.com click card number | fill card number | click pay now"],
    ["create a new repository", "github.com click new | fill repository name | click create repository"],
    ["search issues for bug reports", "github.com click issues | fill search query | press enter"],
    ["open the network inspector", "example.com click network tab | click inspect requests"],
  ],
  negative: [
    ["rename my workspace", "checkout.stripe.com fill card number | click pay now"],
    ["checkout with my card", "github.com click issues | fill search query"],
    ["upload a file to the ticket", "example.com click account | click billing"],
    ["inspect network logs", "github.com click new | fill repository name | click create repository"],
    ["delete the draft document", "checkout.stripe.com click card number | click pay now"],
    ["change the theme to dark", "github.com click issues | click pull requests"],
  ],
};

export function sweepThreshold(pairs = CALIBRATION_PAIRS) {
  const positives = pairs.positive.map(([query, summary]) => ({ similarity: dot(embedFixtureText(query), embedFixtureText(summary)), pair: [query, summary] }));
  const negatives = pairs.negative.map(([query, summary]) => ({ similarity: dot(embedFixtureText(query), embedFixtureText(summary)), pair: [query, summary] }));
  const sweep = [];
  for (let threshold = 0; threshold <= 90; threshold += 1) {
    const value = threshold / 100;
    const truePositives = positives.filter((item) => item.similarity >= value).length;
    const falsePositives = negatives.filter((item) => item.similarity >= value).length;
    sweep.push({
      threshold: value,
      recall: truePositives / positives.length,
      falsePositiveRate: falsePositives / negatives.length,
    });
  }
  const viable = sweep.filter((point) => point.falsePositiveRate < 0.05);
  const recommended = [...viable].reverse().find((point) => point.recall >= 0.6) ?? viable[viable.length - 1] ?? { threshold: 0.42, recall: 0, falsePositiveRate: 1 };
  return { positives, negatives, sweep, recommended };
}
