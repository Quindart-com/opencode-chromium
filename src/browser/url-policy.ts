export interface UrlPolicyConfig {
  allowedOrigins?: readonly string[];
  blockedOrigins?: readonly string[];
}

export type UrlPolicyResult =
  | { allowed: true; code: null; reason: null }
  | { allowed: false; code: "URL_POLICY_BLOCKED"; reason: string };

export interface UrlPolicy {
  readonly allowedOrigins: readonly string[];
  readonly blockedOrigins: readonly string[];
  evaluate(value: string): UrlPolicyResult;
  subresourcePatterns(): string[];
}

export class UrlPolicyError extends Error {
  readonly executionState = "not_started";
  readonly code = "URL_POLICY_BLOCKED";
  readonly retryable = false;
  readonly uncertain = false;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function urlFor(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

export function originMatchesRule(value: string, pattern: string): boolean {
  const url = urlFor(value);
  if (!url) return false;
  return globToRegExp(pattern).test(pattern.includes("://") ? url.origin : url.host);
}

export function createUrlPolicy(config: UrlPolicyConfig = {}): UrlPolicy {
  const allowedOrigins = (config.allowedOrigins ?? []).map(String).filter(value => value.length > 0);
  const blockedOrigins = (config.blockedOrigins ?? []).map(String).filter(value => value.length > 0);
  return {
    allowedOrigins,
    blockedOrigins,
    evaluate(value) {
      if (value === "about:blank") return { allowed: true, code: null, reason: null };
      const origin = urlFor(value)?.origin ?? value;
      if (blockedOrigins.some(pattern => originMatchesRule(origin, pattern))) {
        return { allowed: false, code: "URL_POLICY_BLOCKED", reason: `Blocked by origin policy: ${origin}` };
      }
      if (allowedOrigins.length > 0 && !allowedOrigins.some(pattern => originMatchesRule(origin, pattern))) {
        return { allowed: false, code: "URL_POLICY_BLOCKED", reason: `Origin is not allowed by policy: ${origin}` };
      }
      return { allowed: true, code: null, reason: null };
    },
    subresourcePatterns() {
      return blockedOrigins.map(pattern => {
        if (!pattern.includes("://")) return pattern;
        const hasPath = /^[a-z]+:\/\/[^/]+\/.+/i.test(pattern);
        return hasPath ? pattern : `${pattern.replace(/\/+$/, "")}/*`;
      });
    },
  };
}

export function combineUrlPolicyConfig(base: UrlPolicyConfig = {}, override: UrlPolicyConfig = {}): Required<UrlPolicyConfig> {
  return { allowedOrigins: override.allowedOrigins ?? base.allowedOrigins ?? [], blockedOrigins: override.blockedOrigins ?? base.blockedOrigins ?? [] };
}

export function assertNavigationAllowed(value: string, policy: Pick<UrlPolicy, "evaluate"> | null | undefined): void {
  if (!policy) return;
  const result = policy.evaluate(value);
  if (!result.allowed) throw new UrlPolicyError(result.reason);
}

export function urlPolicyFromEnv(env: Record<string, string | undefined> = process.env): UrlPolicy {
  const split = (value: string | undefined) => (value ?? "").split(/[,;]/).map(item => item.trim()).filter(Boolean);
  return createUrlPolicy({ allowedOrigins: split(env.AGENT_BROWSER_ALLOWED_ORIGINS), blockedOrigins: split(env.AGENT_BROWSER_BLOCKED_ORIGINS) });
}
