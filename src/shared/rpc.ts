import { z } from "zod";

export const rpcMessageSchema = z.looseObject({
  jsonrpc: z.literal("2.0").default("2.0"),
  id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
  clientVersion: z.string().optional(),
});
export type RpcMessage = z.output<typeof rpcMessageSchema>;
export type RpcId = NonNullable<RpcMessage["id"]>;

export const profileHelloSchema = z.object({
  profileId: z.string().min(1).max(160),
  profileLabel: z.string().max(80).nullable().optional(),
  profileFingerprint: z.string().optional(),
  connectionId: z.string().nullable().optional(),
  connectionGeneration: z.number().int().optional(),
  browserName: z.string().nullable().optional(),
  browserVersion: z.string().nullable().optional(),
  extensionId: z.string().nullable().optional(),
  extensionVersion: z.string().nullable().optional(),
  uploadConsentVersion: z.number().int().optional(),
});
export type ProfileHello = z.output<typeof profileHelloSchema>;
