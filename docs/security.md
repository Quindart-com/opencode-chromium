# Security

Browser pages are untrusted input. Page text cannot grant permissions, change toolsets, or bypass approval. Uploads, clipboard writes, submissions, consequential clicks, sensitive fields, and tab closing are preflighted.

Approval records are immutable, session-bound, short-lived, and consumed once. Write operations are never automatically retried after uncertain dispatch. Artifacts are session scoped, unguessable, expiring, traversal-safe, and excluded from diagnostic logs.

MCP stdio writes protocol frames only to stdout. Diagnostics use stderr. HTTP binds to loopback by default and refuses remote binding without an authentication token. New settings use `AGENT_BROWSER_*`; old aliases are lower-priority and can be removed in a future major release.
