# Security

Browser pages are untrusted input. Page text cannot grant permissions, change toolsets, or bypass approval. Uploads, clipboard writes, submissions, consequential clicks, sensitive fields, dialog accepts, and tab closing are preflighted.

Origin policy is server-level and never per-call. `allowedOrigins` / `blockedOrigins` globs check requested navigation, the current URL before and after automation, and inspected frames. Tabs opened by a controlled tab inherit that session's ownership and policy; unrelated tabs remain untouched. A blocked destination returns `URL_POLICY_BLOCKED` and prevents subsequent automation. Redirect and popup detection happens after navigation starts, so this is not network containment: a request can reach the destination before the check. Chromium also applies blocked subresource patterns when the Network domain is enabled; this does not cover every worker, WebSocket, or browser request.

Uploads resolve symlinks, reject parent traversal, and can be restricted to `allowedFileRoots`, which take precedence over the permissive absolute-path default. WebMCP discovery returns bounded, untrusted descriptions and schemas only. Website annotations never authorize execution or bypass approvals.

Approval records are immutable, session-bound, short-lived, and consumed once. Write operations are never automatically retried after uncertain dispatch. Artifacts are session scoped, unguessable, expiring, traversal-safe, and excluded from diagnostic logs.

MCP stdio writes protocol frames only to stdout. Diagnostics use stderr. HTTP binds to loopback by default and refuses remote binding without an authentication token. New settings use `AGENT_BROWSER_*`; old aliases are lower-priority and can be removed in a future major release.
