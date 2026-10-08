import { Data, Effect } from "effect";
import { z } from "zod";

const candidateSchema = z.object({ id: z.string().min(1).max(100).refine(id => id !== "__abstain"), description: z.string().min(1).max(160) });
export const decisionImageSchema = z.string().max(400000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
export const decisionSchema = z.object({
  purpose: z.enum(["select", "rank", "verify"]), context: z.string().max(32000),
  instructions: z.string().min(1).max(2000), candidates: z.array(candidateSchema).min(1).max(128),
  image: decisionImageSchema.optional(),
}).superRefine((value, ctx) => {
  if (new Set(value.candidates.map(candidate => candidate.id)).size !== value.candidates.length) ctx.addIssue({ code: "custom", message: "Duplicate candidate IDs" });
  if (Buffer.byteLength(JSON.stringify({ ...value, image: undefined })) > 64000) ctx.addIssue({ code: "custom", message: "Decision input exceeds byte budget" });
});
export type DecisionRequest = z.infer<typeof decisionSchema>;
export interface DecisionResult {
  status: "selected" | "abstained" | "unavailable";
  candidateId?: string;
  ranking?: string[];
  model?: string;
  confidence?: number;
  elapsedMs: number;
  reason?: string;
  usage?: { input_tokens: number; output_tokens: number; cost?: number };
}
export interface DecisionProvider { decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> }
export class DecisionFailure extends Data.TaggedError("DecisionFailure")<{ code: string }> {}

// Ranking sits on a tool call's critical path, so its budget is a fraction of
// the round trips the recorded usage shows. Connecting a key still uses the
// longer budget in connection.ts.
export const DEFAULT_DECISION_TIMEOUT_MS = 1500;
const responseSchema = z.object({
  model: z.string(),
  answers: z.object({ decision: z.object({ type: z.literal("choice"), choice: z.string(),
    probabilities: z.record(z.string(), z.number().min(0).max(1)), confidence: z.number().min(0).max(1) }) }),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), cost: z.number().nonnegative().optional() }),
});
export class JevProvider implements DecisionProvider {
  private readonly semaphore = Effect.unsafeMakeSemaphore(2);
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch,
    private readonly model = "jev-1.13.0", private readonly timeoutMs = DEFAULT_DECISION_TIMEOUT_MS,
    private readonly route: "typesafe" | "openrouter" = "typesafe") {}
  async decide(input: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    const started = performance.now();
    const operation = Effect.tryPromise({
      try: async (effectSignal) => {
        const request = decisionSchema.parse(input);
        if (request.image && this.model !== "openai/gpt-6-luna-decisions") throw new DecisionFailure({ code: "images_not_supported" });
        const criteria = Object.fromEntries(request.candidates.map(candidate => [candidate.id, candidate.description]));
        criteria.__abstain = "None of the candidates can be selected reliably from this context.";
        const response = await this.fetcher(this.route === "openrouter" ? "https://openrouter.ai/api/alpha/decisions" : "https://api.typesafe.ai/v1/systemone", {
          method: "POST", signal: effectSignal, headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, state: request.image ? [request.context, { type: "image_url", image_url: { url: request.image, detail: "low" } }] : request.context, questions: {
            decision: { type: "choice", instructions: request.instructions, criteria },
          } }),
        });
        if (!response.ok) throw new DecisionFailure({ code: ({ 401: "invalid_key", 403: "access_denied", 402: "insufficient_credit", 429: "rate_limited" } as Record<number, string>)[response.status] ?? "provider_http_error" });
        const reader = response.body?.getReader();
        if (!reader) throw new DecisionFailure({ code: "empty_response" });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 128000) {
              await reader.cancel();
              throw new DecisionFailure({ code: "oversized_response" });
            }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        const text = Buffer.concat(chunks).toString("utf8");
        const result = responseSchema.parse(JSON.parse(text));
        const answer = result.answers.decision;
        const ids = Object.keys(criteria);
        const modelMatches = result.model === this.model || (this.route === "openrouter" && (
          this.model === "typesafe/jev-1.13" && /^typesafe\/jev-1\.13-\d{8}$/.test(result.model) ||
          this.model === "openai/gpt-6-luna-decisions" && /^openai\/gpt-6-luna-decisions-\d{8}$/.test(result.model)
        ));
        if (!modelMatches || !ids.includes(answer.choice) || answer.probabilities[answer.choice] !== Math.max(...Object.values(answer.probabilities)) || Object.keys(answer.probabilities).length !== ids.length ||
          ids.some(id => answer.probabilities[id] === undefined) ||
          Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.01) {
          throw new DecisionFailure({ code: "invalid_decision" });
        }
        const common = { model: result.model, confidence: answer.confidence, usage: result.usage, elapsedMs: performance.now() - started };
        if (answer.choice === "__abstain" || answer.confidence < 0.8) return { ...common, status: "abstained" as const, reason: "insufficient_confidence" };
        return { ...common, status: "selected" as const, candidateId: answer.choice,
          ranking: request.candidates.map(candidate => candidate.id).sort((a, b) => answer.probabilities[b]! - answer.probabilities[a]!) };
      },
      catch: cause => cause instanceof DecisionFailure ? cause : new DecisionFailure({ code: "invalid_or_failed_response" }),
    });
    try {
      const outcome = await Effect.runPromise(this.semaphore.withPermits(1)(operation).pipe(Effect.timeout(this.timeoutMs), Effect.either), { signal });
      if (outcome._tag === "Right") return outcome.right;
      return { status: "abstained", elapsedMs: performance.now() - started,
        reason: outcome.left instanceof DecisionFailure ? outcome.left.code : "timeout" };
    } catch {
      return { status: "abstained", elapsedMs: performance.now() - started,
        reason: signal?.aborted ? "cancelled" : "provider_unavailable_or_invalid_response" };
    }
  }
}

