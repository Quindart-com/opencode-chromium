# OpenCode Plugin

This directory contains the OpenCode plugin and custom browser tools.

OpenCode does not use Codex's Node REPL/browser-client runtime, so browser capabilities are exposed as normal OpenCode custom tools.

## Local Plugin Entry

The repository includes `.opencode/plugins/chromium-browser.js`, which re-exports `opencode-plugin/src/plugin.js` so OpenCode can load the browser tools while developing this project.

## Skill

The skill is available at `.opencode/skills/chromium-browser/SKILL.md`.
