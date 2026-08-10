function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function urlFor(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

export function originMatchesRule(value, pattern) {
  const url = urlFor(value);
  if (!url) return false;
  const normalized = String(pattern);
  if (normalized.includes("://")) return globToRegExp(normalized).test(url.origin);
  return globToRegExp(normalized).test(url.host);
}

export function createUrlPolicy(config = {}) {
  const allowedOrigins = (config.allowedOrigins ?? []).map(String).filter((value) => value.length > 0);
  const blockedOrigins = (config.blockedOrigins ?? []).map(String).filter((value) => value.length > 0);
  return {
    allowedOrigins,
    blockedOrigins,
    evaluate(value) {
      const origin = urlFor(value)?.origin ?? String(value);
      if (blockedOrigins.some((pattern) => originMatchesRule(origin, pattern))) {
        return { allowed: false, code: "URL_POLICY_BLOCKED", reason: `Blocked by origin policy: ${origin}` };
      }
      if (allowedOrigins.length > 0 && !allowedOrigins.some((pattern) => originMatchesRule(origin, pattern))) {
        return { allowed: false, code: "URL_POLICY_BLOCKED", reason: `Origin is not allowed by policy: ${origin}` };
      }
      return { allowed: true, code: null, reason: null };
    },
    subresourcePatterns() {
      return blockedOrigins.map((pattern) => {
        if (!pattern.includes("://")) return pattern;
        const hasPath = /^[a-z]+:\/\/[^/]+\/.+/i.test(pattern);
        return hasPath ? pattern : `${pattern.replace(/\/+$/, "")}/*`;
      });
    },
  };
}

export function combineUrlPolicyConfig(base = {}, override = {}) {
  return {
    allowedOrigins: override.allowedOrigins ?? base.allowedOrigins ?? [],
    blockedOrigins: override.blockedOrigins ?? base.blockedOrigins ?? [],
  };
}

export function assertNavigationAllowed(value, policy) {
  if (!policy) return;
  const result = policy.evaluate(value);
  if (result.allowed) return;
  const error = new Error(result.reason);
  error.code = result.code;
  error.retryable = false;
  error.uncertain = false;
  throw error;
}

export function urlPolicyFromEnv(env = process.env) {
  const split = (value) => (value ?? "").split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  return createUrlPolicy({
    allowedOrigins: split(env.AGENT_BROWSER_ALLOWED_ORIGINS),
    blockedOrigins: split(env.AGENT_BROWSER_BLOCKED_ORIGINS),
  });
}