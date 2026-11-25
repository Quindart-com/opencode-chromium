import type { FilePolicy,FilePolicyConfig } from "../browser/file-policy.ts";
import type { BrowserOperation } from "../browser/operation-definition.ts";
import type { UrlPolicy,UrlPolicyConfig } from "../browser/url-policy.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { TabClaimApproval } from "./claim-approval.ts";
import type { createLogger } from "./logging.ts";
import type { Environment,RunInput } from "./registry.ts";

export interface RuntimeSession {
  sessionId: string;
  profileId: string | null;
  profileIds?: Set<string>;
  activeTabId: number | null;
  configuredTabs: Map<string, { tabId: number; profileId: string | null }>;
  createdAt: string;
  environment?: Environment;
  /** Default pointer route for click/hover/focus steps. */
  inputMode?: "auto" | "pointer" | "dom";
  /** false keeps the cursor overlay out of the page. */
  cursor?: boolean;
  /** Hostnames that closed, blanked, or redirected the tab after an action; they get low-footprint input. */
  guardedHosts: Set<string>;
}
export interface PendingApproval { sessionId: string; callerSessionId?: string; request: RunInput | null; claim?: TabClaimApproval; expiresAt: number }
export interface SearchPreferences { maxResults: number; detail: string; mode: string }
export interface RuntimeOptions {
  artifactStore?: ArtifactStore;
  approvalTtlMs?: number;
  operationFactory?: () => Promise<{ tool: Record<string, BrowserOperation> }>;
  hostRequest?: (method: string, params?: Record<string, unknown>, options?: { profileId?: string | null }) => Promise<unknown>;
  urlPolicy?: UrlPolicy;
  urlPolicyConfig?: UrlPolicyConfig;
  filePolicy?: FilePolicy;
  filePolicyConfig?: FilePolicyConfig;
  logger?: ReturnType<typeof createLogger>;
}
