import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNavigationAllowed, createUrlPolicy, urlPolicyFromEnv } from "../../src/browser/url-policy.js";

test("blocked origins are rejected with a typed non-retryable error", () => {
  const policy = createUrlPolicy({ blockedOrigins: ["https://bank.example.com"] });
  const result = policy.evaluate("https://bank.example.com/account");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "URL_POLICY_BLOCKED");
  assert.throws(() => assertNavigationAllowed("https://bank.example.com/login", policy), (error) => {
    assert.equal(error.code, "URL_POLICY_BLOCKED");
    assert.equal(error.retryable, false);
    assert.equal(error.uncertain, false);
    return true;
  });
});

test("allowlist rejects origins outside the configured set", () => {
  const policy = createUrlPolicy({ allowedOrigins: ["https://example.com", "https://*.dev.example.com"] });
  assert.equal(policy.evaluate("https://example.com/path").allowed, true);
  assert.equal(policy.evaluate("https://api.dev.example.com/v1").allowed, true);
  assert.equal(policy.evaluate("https://evil.example.net").allowed, false);
});

test("host-only patterns match across schemes", () => {
  const policy = createUrlPolicy({ blockedOrigins: ["example.com"] });
  assert.equal(policy.evaluate("https://example.com/a").allowed, false);
  assert.equal(policy.evaluate("http://example.com/b").allowed, false);
});

test("subresource patterns expand bare origins to cover the full URL", () => {
  const policy = createUrlPolicy({ blockedOrigins: ["https://ads.example.com", "https://cdn.example.com/blocked"] });
  assert.deepEqual(policy.subresourcePatterns(), ["https://ads.example.com/*", "https://cdn.example.com/blocked"]);
});

test("a permissive default policy allows every origin", () => {
  const policy = createUrlPolicy({});
  assert.equal(policy.evaluate("https://anything.example").allowed, true);
  assert.equal(policy.evaluate("data:text/plain,hello").allowed, true);
});

test("env policy reads comma- and semicolon-separated origin lists", () => {
  const policy = urlPolicyFromEnv({
    AGENT_BROWSER_ALLOWED_ORIGINS: "https://example.com, https://other.example",
    AGENT_BROWSER_BLOCKED_ORIGINS: "https://bad.example;https://worse.example",
  });
  assert.deepEqual(policy.allowedOrigins, ["https://example.com", "https://other.example"]);
  assert.deepEqual(policy.blockedOrigins, ["https://bad.example", "https://worse.example"]);
});