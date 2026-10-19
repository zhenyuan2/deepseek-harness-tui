# Changelog

## Unreleased

- Remove the offline demo command, simulated runtime, and demo profile setup.

## 0.1.2 — 2026-10-19

- Restore raw mode, cursor visibility, scroll margins, mouse reporting, and bracketed paste on SIGINT/SIGTERM/SIGHUP, uncaught errors, and process exit; launchers now forward termination signals to the TUI.

- Treat only exact catalog commands as slash commands, so absolute paths such as `/Users/nick/file.ts` are sent as messages instead of failing as unknown commands; Enter no longer rewrites a partial command (Tab still completes).

- Show the terminal's native caret at the composer and drop the painted duplicate, so IME preedit and candidate windows anchor below the input instead of the top-left corner.

- Enable native terminal text selection by default, with application mouse-wheel handling available through the `mouseTracking` option.

- Show concrete reasoning depths only, focusing the effective selection and skipping the picker for models without adjustable reasoning.

## 0.1.1 — 2026-10-19

- Use consistent profile names for global and source launches, migrating legacy local profiles without overwriting existing profiles.
- Default to the DeepSeek API route, with an explicit account-provider option and guards against conflicting saved selections.
- Hide injected workspace instructions and runtime-context snapshots in live conversations and resumed history.

## 0.1.0

First version of `deepseek-harness-tui`.

- Global command with automatic Harness profile registration.
- Cordis plugin for interactive DeepSeek Harness conversations.
- Streaming Markdown, tool output, diffs, and approval prompts.
- Session resume, model selection, and configurable status line.
- Offline demo and local Harness setup scripts.
