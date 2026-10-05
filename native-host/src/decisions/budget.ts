import { createHash } from "node:crypto";

// Paid decisions are the only part of retrieval that costs money and blocks on
// a network round trip, so they are gated, deduplicated and capped here.
//
// The gate is deliberately local: the caller's own ranking is authoritative, and
// a paid decision only ever reorders it. Nothing in this module changes the
// result when the provider is unavailable, abstains, or runs out of budget.

export const MAX_CANDIDATE_DESCRIPTION_CHARS = 160;
export const MAX_CANDIDATE_LABEL_CHARS = 40;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 64;
const BUCKET_CAPACITY = 6;
const BUCKET_REFILL_MS = 3_000;

export interface DecisionCandidate {
  id: string;
  description: string;
}

export interface DecisionStats {
  skipped: number;
  cacheHits: number;
  coalesced: number;
  budgetSkipped: number;
  called: number;
  lastSkipReason: string | null;
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// A description is the only text sent to the provider, so it is bounded here
// rather than at each call site.
export function describeCandidate(parts: unknown[]): string {
  const seen = new Set<string>();
  for (const part of parts) {
    const text = normalize(part);
    if (text) seen.add(text.slice(0, MAX_CANDIDATE_LABEL_CHARS));
    if (seen.size >= 4) break;
  }
  return [...seen].join(" | ").slice(0, MAX_CANDIDATE_DESCRIPTION_CHARS);
}

export function decisionFingerprint(query: string, pageFingerprint: string, candidates: DecisionCandidate[]): string {
  const material = [normalize(query), normalize(pageFingerprint), ...candidates.map((candidate) => `${candidate.id}:${candidate.description}`)].join("\u0000");
  return createHash("sha1").update(material).digest("hex");
}

interface RankedResult {
  node_id?: unknown;
  nodeId?: unknown;
  name?: unknown;
  text?: unknown;
  label?: unknown;
  score?: unknown;
  interactive?: unknown;
  scores?: { lexical?: unknown } | null;
}

function resultScore(result: RankedResult | undefined): number {
  const score = Number(result?.score);
  if (Number.isFinite(score)) return score;
  return Number(result?.scores?.lexical ?? 0);
}

function resultLabel(result: RankedResult | undefined): string {
  return normalize(result?.name ?? result?.label ?? result?.text);
}

function resultContains(result: RankedResult, phrase: string): boolean {
  return resultLabel(result).toLocaleLowerCase().includes(phrase);
}

// A query that names exactly one interactive element has an unambiguous answer,
// and the local pipeline does not always surface it: a container's aggregated
// text scores well against the same phrase, so the container can lead. Promoting
// the named element is deterministic — it uses the element's own label, not a
// score — and the paid decision that would have done the same reordering is
// skipped. Broad or paraphrased queries match nothing here and are unaffected.
export function leadingExactMatch(query: string, results: RankedResult[]): RankedResult | null {
  const phrase = normalize(query).toLocaleLowerCase();
  if (!phrase) return null;
  const matches = results.filter((result) => result.interactive !== false && resultContains(result, phrase));
  return matches.length === 1 ? matches[0] ?? null : null;
}

// When the caller's own ranking already puts the one element named by the query
// on top, a paid decision cannot add information; calling it only adds latency
// and cost.
//
// The competition check matters. A container's text is the concatenation of its
// children, so it contains almost every label on a dense page; counting raw
// phrase matches would find "matches" everywhere and never skip. Only a
// competing interactive element counts as competition.
//
// `modelUsed` matters too: a wide margin between raw lexical scores is normal and
// says nothing about confidence, while a wide margin after a fused
// embedding-and-lexical score does. A decision is only skipped on a margin when
// the local pipeline actually embedded the query.
export function rankingIsDecisive(
  query: string,
  results: RankedResult[],
  options: { modelUsed?: boolean; margin?: number } = {},
): { decisive: boolean; reason: string | null } {
  if (results.length < 2) return { decisive: true, reason: "single_candidate" };
  const normalized = normalize(query).toLocaleLowerCase();
  if (normalized && results[0] && resultContains(results[0], normalized)) {
    const rivals = results.filter((result) => result !== results[0] && result.interactive !== false && resultContains(result, normalized));
    if (rivals.length === 0) return { decisive: true, reason: "unique_exact_match" };
  }
  const margin = options.margin ?? 0.18;
  if (options.modelUsed === true && resultScore(results[0]) - resultScore(results[1]) >= margin) {
    return { decisive: true, reason: "score_margin" };
  }
  return { decisive: false, reason: null };
}

export class DecisionBudget {
  #entries = new Map<string, { expiresAt: number; value: unknown }>();
  #inflight = new Map<string, Promise<unknown>>();
  #tokens: number;
  #updatedAt: number;
  #stats: DecisionStats = { skipped: 0, cacheHits: 0, coalesced: 0, budgetSkipped: 0, called: 0, lastSkipReason: null };

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly capacity = BUCKET_CAPACITY,
    private readonly refillMs = BUCKET_REFILL_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.#tokens = capacity;
    this.#updatedAt = now();
  }

  skipped(reason: string): void {
    this.#stats.skipped += 1;
    this.#stats.lastSkipReason = reason;
  }

  get(key: string): unknown | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#stats.cacheHits += 1;
    this.#stats.lastSkipReason = null;
    return entry.value;
  }

  store(key: string, value: unknown): void {
    this.#entries.delete(key);
    this.#entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  // Without this, identical concurrent searches bill twice for the same answer.
  coalesce(key: string, run: () => Promise<unknown>): Promise<unknown> {
    const existing = this.#inflight.get(key);
    if (existing) {
      this.#stats.coalesced += 1;
      return existing;
    }
    const promise = run().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  #refill(): void {
    const now = this.now();
    const elapsed = now - this.#updatedAt;
    if (elapsed < this.refillMs) return;
    const gained = Math.floor(elapsed / this.refillMs);
    this.#tokens = Math.min(this.capacity, this.#tokens + gained);
    this.#updatedAt += gained * this.refillMs;
  }

  allow(): boolean {
    this.#refill();
    if (this.#tokens <= 0) {
      this.#stats.budgetSkipped += 1;
      this.#stats.lastSkipReason = "budget_exhausted";
      return false;
    }
    this.#tokens -= 1;
    return true;
  }

  called(): void {
    this.#stats.called += 1;
    this.#stats.lastSkipReason = null;
  }

  stats(): DecisionStats & { cacheEntries: number; inFlight: number } {
    return { ...this.#stats, cacheEntries: this.#entries.size, inFlight: this.#inflight.size };
  }
}

export const decisionBudget = new DecisionBudget();
