import type { FilePolicy,FilePolicyConfig } from "../browser/file-policy.ts";
import type { BrowserOperation } from "../browser/operation-definition.ts";
import type { UrlPolicy,UrlPolicyConfig } from "../browser/url-policy.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { createLogger } from "./logging.ts";
import type { Environment,RunInput } from "./registry.ts";

export interface RuntimeSession {
  sessionId: string;
  profileId: string | null;
  activeTabId: number | null;
  configuredTabs: Map<string, { tabId: number; profileId: string | null }>;
  createdAt: string;
  environment?: Environment;
}
export interface PendingApproval { sessionId: string; request: RunInput; expiresAt: number }
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
