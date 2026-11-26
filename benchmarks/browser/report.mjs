export const schemaVersion = 1;

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
}

function timings(rows) {
  const values = rows.map(row => row.wallMs).filter(Number.isFinite);
  return { n: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
}

const ratio = (numerator, denominator) => denominator && numerator !== null ? numerator / denominator : null;
const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);

function costs(calls, attempts, verified, tokenized) {
  const publicCalls = calls.filter(row => row.method === "tools/call" || row.method === "resources/read");
  const argumentsTokens = tokenized ? sum(calls, "requestTokens") : null;
  const returnedTextTokens = tokenized ? sum(calls, "responseTextTokens") : null;
  const tokens = tokenized ? argumentsTokens + returnedTextTokens : null;
  const recovery = calls.filter(row => ["artifact", "lookup_fallback", "recovery"].includes(row.phase));
  return {
    calls: publicCalls.length, roundTrips: calls.filter(row => row.method !== "injected").length,
    requestWireBytes: sum(calls, "requestWireBytes"), responseWireBytes: sum(calls, "responseWireBytes"),
    argumentsTokens, returnedTextTokens, tokens,
    schemaTokens: tokenized ? sum(calls.filter(row => row.phase === "schema"), "responseTextTokens") : null,
    recoveryCalls: recovery.length, recoveryTokens: tokenized ? sum(recovery, "requestTokens") + sum(recovery, "responseTextTokens") : null,
    callsPerAttempt: ratio(publicCalls.length, attempts), callsPerVerified: ratio(publicCalls.length, verified),
    tokensPerAttempt: ratio(tokens, attempts), tokensPerVerified: ratio(tokens, verified),
    timeouts: calls.filter(row => row.code === "TIMEOUT").length,
    mutationCalls: Object.fromEntries(["not_started", "acknowledged", "unknown"].map(state => [state, calls.filter(row => row.execution === state).length])),
    approvals: { requested: calls.filter(row => row.approval === "requested").length, granted: calls.filter(row => row.approval === "granted").length,
      declined: calls.filter(row => row.approval === "declined").length, expired: calls.filter(row => row.approval === "expired").length, waitMs: 0 },
  };
}

function failures(attempts, setup) {
  const groups = new Map();
  function add(failure, when) {
    const { phase, code } = failure;
    const group = groups.get(`${phase}/${code}`) ?? { phase, code, count: 0, firstSeen: when, lastSeen: when };
    group.count++;
    if (when < group.firstSeen) group.firstSeen = when;
    if (when > group.lastSeen) group.lastSeen = when;
    groups.set(`${phase}/${code}`, group);
  }
  for (const row of attempts) {
    if (row.error) add(row.error, row.endedAt);
    if (row.verifierError) add(row.verifierError, row.endedAt);
    for (const code of row.verification?.issues ?? []) add({ phase: "verification", code }, row.endedAt);
  }
  for (const row of setup) {
    if (row.error || row.startupError) add(row.error ?? row.startupError, row.endedAt);
    for (const cleanup of row.cleanupFailures ?? []) add(cleanup, row.endedAt);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function summarize(run, rows) {
  const waves = rows.filter(row => row.kind === "wave");
  const matrix = waves.map(wave => {
    const attempts = rows.filter(row => row.kind === "attempt" && row.clients === wave.clients);
    const lifecycle = rows.filter(row => row.kind === "client" && row.clients === wave.clients);
    const verified = attempts.filter(row => row.outcome === "verified");
    const eligible = attempts.filter(row => !row.guard && !row.fault);
    const taskCalls = attempts.flatMap(row => row.calls);
    const sessionCalls = [...taskCalls, ...lifecycle.flatMap(row => row.calls), ...(wave.claimRace?.calls ?? [])];
    const verificationIssues = attempts.flatMap(row => row.verification?.issues ?? []);
    const mainCosts = costs(taskCalls, attempts.length, verified.length, !!run.tokenizer);
    const firstObservationHits = attempts.filter(row => row.firstObservationMiss === false).length;
    const byPhase = Object.fromEntries([...new Set(taskCalls.map(call => call.phase))].sort().map(phase => {
      const samples = taskCalls.filter(call => call.phase === phase);
      return [phase, { count: samples.length, p50Ms: percentile(samples.map(call => call.ms), 0.5), p95Ms: percentile(samples.map(call => call.ms), 0.95) }];
    }));
    return {
      clients: wave.clients, topology: wave.topology, browser: wave.browser, startupMs: wave.startupMs, sessionMs: wave.sessionMs,
      actionWindowMs: wave.actionWindowMs, attempts: attempts.length, eligible: eligible.length, verified: verified.length,
      successRate: ratio(verified.length, eligible.length),
      guards: { passed: attempts.filter(row => row.outcome === "guard_pass").length, total: attempts.filter(row => row.guard).length },
      probes: { passed: attempts.filter(row => row.outcome === "probe_pass").length, total: attempts.filter(row => row.fault).length },
      holdouts: { verified: verified.filter(row => row.holdout).length, total: eligible.filter(row => row.holdout).length },
      verifiedPerSecond: ratio(verified.length, wave.actionWindowMs / 1000), firstObservationHits,
      alreadyVisible: run.observationPolicy === "targeted" ? null : firstObservationHits,
      agentConfirmed: attempts.filter(row => row.agentConfirmed).length,
      latency: { all: timings(attempts), verified: timings(verified), byPhase, runtimeQueueMs: null },
      perClient: lifecycle.map(client => {
        const clientRows = attempts.filter(row => row.client === client.client);
        return { client: client.client, verified: clientRows.filter(row => row.outcome === "verified").length, attempts: clientRows.length,
          ...timings(clientRows), failedToStart: Boolean(wave.error || client.startupError) };
      }),
      costs: { action: mainCosts, session: costs(sessionCalls, attempts.length, verified.length, !!run.tokenizer) },
      wrongEffects: verificationIssues.filter(code => code === "WRONG_EFFECT").length,
      extraEffects: verificationIssues.filter(code => code === "EXTRA_EFFECT").length,
      failures: failures(attempts, [wave, ...lifecycle]),
      startupFailure: wave.error ?? null, cleanupFailures: wave.cleanupFailures, attachment: wave.attachment ?? null,
      sentinel: wave.sentinel, claimRace: wave.claimRace ? { ...wave.claimRace, calls: undefined } : null, host: wave.host,
    };
  });
  const solo = matrix.find(row => row.clients === 1);
  for (const row of matrix) row.p95SlowdownVsOne = ratio(row.latency.verified.p95Ms, solo?.latency.verified.p95Ms);
  return { schemaVersion, run, matrix };
}

export function outcome(task, verification, error) {
  if (task.guard) return verification.ok && error?.code === task.guard ? "guard_pass" : "failed";
  if (task.fault === "wrong") return verification.issues.includes("WRONG_EFFECT") ? "probe_pass" : "failed";
  if (task.fault === "duplicate") return verification.issues.includes("EXTRA_EFFECT") && verification.effects.every(event => event.key === task.expected.effect) ? "probe_pass" : "failed";
  if (task.fault === "lookup") return error?.code === "INJECTED_LOOKUP" && verification.issues.length === 1 && verification.issues[0] === "MISSING_EFFECT" ? "probe_pass" : "failed";
  if (task.fault === "confirmation") return error?.code === "INJECTED_CONFIRMATION" && verification.ok ? "probe_pass" : "failed";
  if (error?.approval) return verification.effects.length || verification.drafts.length ? "failed" : "blocked";
  return verification.ok ? "verified" : "failed";
}
