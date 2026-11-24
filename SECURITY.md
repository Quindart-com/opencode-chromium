# Security Policy

This project controls a real browser for coding agents. It uses Chromium and Firefox extensions, native messaging, a local runtime controller, and MCP, OpenCode and SDK adapters. Treat security reports seriously.

Security fixes are made in the latest release. If you can, update with `npx -y opencode-chromium@latest setup --all` and confirm the issue there before reporting.

## Reporting A Vulnerability

Please [open a private security advisory](https://github.com/Quindart-com/opencode-chromium/security/advisories/new) on GitHub. Do not use public issues or discussions for vulnerabilities.

Include:

- Affected version or commit.
- Steps to reproduce.
- Expected and actual behavior.
- Whether the issue requires local access, a malicious web page, or a malicious extension/user profile.

## Scope

Security-sensitive areas include:

- Extension permissions and content scripts.
- Native messaging manifest installation.
- Local IPC socket/pipe behavior.
- Clipboard and file upload tools.
- CDP execution and tab/session ownership.
- The Firefox WebDriver BiDi connection to the loopback Remote Agent.
- Runtime controller updates, release validation and rollback.
- Stored decision-provider credentials and data sent to opt-in cloud services.
- Local action memory and session artifacts.
- MCP HTTP transport, authentication and origin policy.

Please do not publicly disclose a working exploit before the maintainer has had time to investigate and release a fix.
