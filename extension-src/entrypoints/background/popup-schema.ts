import { z } from "zod/mini";

export const popupMessageSchema = z.looseObject({
  type: z.string(),
  method: z.optional(z.string()),
  params: z.optional(z.record(z.string(), z.unknown())),
  settings: z.optional(z.record(z.string(), z.unknown())),
  apiKey: z.optional(z.string()),
  label: z.optional(z.nullable(z.string())),
  enabled: z.optional(z.boolean()),
  token: z.optional(z.string()),
  allow: z.optional(z.boolean()),
  allowWithoutConfirmation: z.optional(z.boolean()),
  cursorId: z.optional(z.string()),
  moveSequence: z.optional(z.number()),
  modelId: z.optional(z.string()),
  preload: z.optional(z.boolean()),
  embeddingDims: z.optional(z.int()),
  strategyPreference: z.optional(z.string()),
  agentResultCount: z.optional(z.int()),
  agentResultDetail: z.optional(z.string()),
});

export const uploadMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("GET_UPLOAD_SETTINGS") }),
  z.object({ type: z.literal("SET_UPLOAD_SETTINGS"), allowWithoutConfirmation: z.boolean() }),
  z.object({ type: z.literal("GET_UPLOAD_REQUEST"), token: z.string() }),
  z.object({ type: z.literal("RESOLVE_UPLOAD_REQUEST"), token: z.string(), allow: z.boolean() }),
]);
