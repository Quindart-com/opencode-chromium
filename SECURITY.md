# Security Policy

This project controls a real browser through a Chromium extension, native messaging, and OpenCode tools. Treat security reports seriously.

## Reporting A Vulnerability

Please open a private security advisory on GitHub if the repository is hosted there. If that is not available yet, contact the maintainer privately before publishing details.

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

Please do not publicly disclose a working exploit before the maintainer has had time to investigate and release a fix.
