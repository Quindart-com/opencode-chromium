import { Data,Effect,Semaphore } from "effect";
import { z } from "zod";

export const embeddingResultSchema = z.object({
  vectors: z.array(z.array(z.number().finite()).min(1)).min(1),
  model: z.string().nullable().optional(),
  dims: z.number().int().positive(),
  embeddingProfile: z.string().nullable().optional(),
});
export type EmbeddingResult = z.infer<typeof embeddingResultSchema>;
export type Embedder = (texts: string[], signal?: AbortSignal) => Promise<unknown>;

export class EmbeddingFailure extends Data.TaggedError("EmbeddingFailure")<{
  message: string;
  cause?: unknown;
}> {}

/** Serializes model access; the Promise boundary remains compatible with callers. */
export class EmbeddingService {
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private readonly controller = new AbortController();
  private readonly embedder: Embedder;

  constructor(embedder: Embedder) { this.embedder = embedder; }

  run(texts: string[]): Promise<EmbeddingResult> {
    const operation = Effect.tryPromise({
      try: async (signal) => {
        const result = embeddingResultSchema.parse(await this.embedder(texts, signal));
        if (result.vectors.length !== texts.length || result.vectors.some((vector) => vector.length !== result.dims)) {
          throw new Error("Embedding batch shape does not match its inputs");
        }
        return result;
      },
      catch: (cause) => new EmbeddingFailure({ message: "Embedding batch failed", cause }),
    });
    return Effect.runPromise(this.semaphore.withPermits(1)(operation), { signal: this.controller.signal });
  }

  close(): void { this.controller.abort(); }
}
