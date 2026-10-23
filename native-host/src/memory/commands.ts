import { z } from "zod";
export const memoryCommandSchema = z.object({
  limit: z.number().int().positive().max(200).optional(), capability: z.string().nullable().optional(), hostname: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(), sinceId: z.number().int().nullable().optional(), untilId: z.number().int().nullable().optional(),
  query: z.string().nullable().optional(), kind: z.string().optional(), modelId: z.string().nullable().optional(), includeLegacy: z.boolean().optional(),
  steps: z.array(z.object({ action: z.string().nullable().optional(), target: z.unknown() })).max(24).optional(),
  quota_bytes: z.number().nullable().optional(), purge_days: z.number().nullable().optional(), power_user: z.boolean().nullable().optional(),
  days: z.number().nullable().optional(), now: z.number().optional(), profileIds: z.array(z.string()).max(50).nullable().optional(), includeUnattributed: z.boolean().optional(),
  chainId: z.union([z.string(), z.number()]).nullable().optional(), position: z.number().int().nullable().optional(), action: z.string().nullable().optional(),
  target: z.unknown(), success: z.boolean().nullable().optional(), durationMs: z.number().nullable().optional(), errorCode: z.string().nullable().optional(),
  supersedes: z.number().nullable().optional(), eventType: z.string().optional(), actionId: z.number().nullable().optional(), stepsReused: z.number().nullable().optional(), reason: z.string().nullable().optional(),
});
