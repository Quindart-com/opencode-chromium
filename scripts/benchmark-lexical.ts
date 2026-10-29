import { createHash } from "node:crypto";
import { rankPageUnits } from "../native-host/src/semantic-search.ts";

// Fixed synthetic input: compare the result hash as well as latency and CPU.
// Run in a fresh process on both revisions; this is not an agent accuracy test.
const units = Array.from({ length: 500 }, (_, index) => ({
  node_id: `n${index}`, role: "button", text: `Workspace control ${index} save settings`, interactive: true,
}));
const times: number[] = [];
const answers: string[] = [];
const cpu = process.cpuUsage();
for (let index = 0; index < 150; index++) {
  const start = performance.now();
  const result = await rankPageUnits({ query: `workspace control ${index}`, units, mode: "lexical", maxResults: 5 });
  times.push(performance.now() - start);
  answers.push(JSON.stringify(result.results));
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({
  scope: "150 lexical searches over 500 synthetic controls; one process, no browser or cloud calls",
  p50Ms: times[75], p95Ms: times[142], cpuMicros: process.cpuUsage(cpu), peakRss: process.resourceUsage().maxRSS,
  resultSha256: createHash("sha256").update(answers.join("\n")).digest("hex"),
}, null, 2));
