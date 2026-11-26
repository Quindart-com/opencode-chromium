const kinds = ["autonomous", "relayed", "guided", "replay", "fixtureAuthor"];
export function trialKind(trial) {
  if (kinds.includes(trial.operatorMode)) return trial.operatorMode;
  // These are the exact operator labels in the two frozen evidence sets.
  if (trial.operator === "Fixed workflow, Luna low evidence reader") return "guided";
  if (trial.operator === "GPT-6.2 Astra (xhigh), fixture-author session") return "fixtureAuthor";
  throw Error("Missing or unknown operator mode");
}
export function compareAgents(a, b, kind) {
  const left = a.agentTrials?.[kind], right = b.agentTrials?.[kind];
  if (!kinds.includes(kind) || !left || !right || left.operator !== right.operator || left.mode !== right.mode)
    throw Error("operator mismatch or missing trial");
  if (a.seed !== b.seed || a.readFixtureSha256 !== b.readFixtureSha256 || a.browserSha256 !== b.browserSha256 ||
      left.total !== right.total || left.answers?.map(r => r.id).join() !== right.answers?.map(r => r.id).join())
    throw Error("agent fixture mismatch");
  return { mode: kind, before: left.correct, after: right.correct, total: left.total };
}
export function summarizeTrials(primary, metrics, additional = {}) {
  const result = Object.fromEntries(kinds.map(key => [key, null]));
  const mode = trialKind(primary);
  result[mode] = { ...metrics, mode };
  for (const [key, trial] of Object.entries(additional)) {
    if (!kinds.includes(key) || result[key] || !trial.complete || trial.seed !== primary.seed ||
      trial.fixtureSha256 !== primary.fixtureSha256 || trial.browserSha256 !== primary.browserSha256 ||
      trial.build.sourceSha256 !== primary.build.sourceSha256 ||
      trial.rows.map(row => row.id).join() !== primary.rows.map(row => row.id).join()) throw Error("unmatched agent evidence");
    result[key] = { mode: key, operator: trial.operator, correct: trial.rows.filter(row => row.correct).length,
      total: trial.rows.length, answers: trial.rows.map(({ id, correct }) => ({ id, correct })) };
  }
  return result;
}
