import { z } from "zod";
import { unsupportedLadybird } from "../browser/ladybird/backend.ts";
import { LADYBIRD_PROFILE } from "../browser/ladybird/config.ts";
import { record } from "../shared/values.ts";
import { BrowserRuntimeError } from "./errors.ts";
import type { BrowserProfile } from "./profiles.ts";

const claimSchema = z.object({
  claimToken: z.string().min(1),
  expiresAt: z.number(),
  tab: z.object({ id: z.number().int().positive(), title: z.string(), url: z.string(), tabGroup: z.number().nullable(), claimReason: z.enum(["ungrouped", "grouped"]) }),
});

export type TabClaimApproval = z.infer<typeof claimSchema> & { profileId: string; profileLabel: string | null };
type ClaimRequest = (method: string, params: Record<string, unknown>, options: { profileId: string }) => Promise<unknown>;

export async function prepareTabClaim(request: ClaimRequest, profile: BrowserProfile, sessionId: string, tabId: number, urlPolicy: { allowedOrigins: readonly string[]; blockedOrigins: readonly string[] }): Promise<TabClaimApproval> {
  if (profile.profileId === LADYBIRD_PROFILE) throw unsupportedLadybird("claiming existing tabs");
  const { allowedOrigins, blockedOrigins } = urlPolicy;
  const reply = await request("prepareTabClaim", { profile_id: profile.profileId, session_id: sessionId, tabId, url_policy: { allowedOrigins, blockedOrigins } }, { profileId: profile.profileId }).catch((error: unknown) => {
    if (record(error).code === -32601) throw new BrowserRuntimeError("Reload the updated browser extension before claiming existing tabs.", { code: "TAB_CLAIM_EXTENSION_UPDATE_REQUIRED" });
    throw error;
  });
  const claim = claimSchema.parse(reply);
  if (claim.tab.id !== tabId) throw new BrowserRuntimeError("The browser returned a different tab for approval.", { code: "TAB_CLAIM_CHANGED" });
  return { ...claim, profileId: profile.profileId, profileLabel: profile.profileLabel ?? null };
}

export function publicClaimTarget({ tab, profileId, profileLabel }: TabClaimApproval) {
  return { ...tab, profileId, profileLabel };
}
