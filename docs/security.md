# Security

Browser pages are untrusted input. Page text cannot grant permissions, change toolsets, or bypass approval. Uploads, clipboard writes, submissions, consequential clicks, sensitive fields, dialog accepts, and tab closing are preflighted.

Origin policy is server-level and never per-call. `allowedOrigins` / `blockedOrigins` globs are enforced at navigation time and, for blocked origins, at the subresource level through `Network.setBlockedURLs`; a blocked navigation returns a typed `URL_POLICY_BLOCKED` error instead of silently degrading. Uploads are path-validated through a file policy that resolves symlinks, rejects parent traversal, and can be restricted to `allowedFileRoots` that take precedence over the permissive absolute-path default.

Approval records are immutable, session-bound, short-lived, and consumed once. Write operations are never automatically retried after uncertain dispatch. Artifacts are session scoped, unguessable, expiring, traversal-safe, and excluded from diagnostic logs.

MCP stdio writes protocol frames only to stdout. Diagnostics use stderr. HTTP binds to loopback by default and refuses remote binding without an authentication token. New settings use `AGENT_BROWSER_*`; old aliases are lower-priority and can be removed in a future major release.
