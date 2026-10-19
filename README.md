# DeepSeek Harness TUI

A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built as a Cordis plugin.

Chat with your agent, review tool output and file diffs, and approve actions from the terminal. The interface supports streaming Markdown, model selection, and saved conversations, with completed output preserved in terminal scrollback on exit. Harness handles model requests, tool execution, permissions, and session storage.

## Install

Requires Node.js **22.19.0 or later** and pnpm available on your `PATH`. For live conversations, configure your provider credentials in Harness or set the `DEEPSEEK_API_KEY` environment variable.

### From npm

Install the Harness CLI and TUI globally:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2 @nickyuan/deepseek-harness-tui
```

Start the TUI from the directory you want to work in:

```sh
deepseek-harness-tui
```

The first launch automatically sets up a dedicated Harness profile. Settings and sessions are stored under `~/.dsh`, unless you specify a different location with `DSH_HOME`.

DeepSeek models use the API Key provider (`deepseek-official`) by default. To use an existing Harness account login instead, add this override to `~/.dsh/profiles/deepseek-harness-tui/cordis.patch.yml` (or the same profile under `DSH_HOME`), then restart:

```yaml
- id: simple-tui
  config:
    deepseekProvider: deepseek-account
```

Only the selected DeepSeek provider appears in `/model`; other providers remain available. If a saved model or resumed session uses the other route, sending is blocked until you explicitly choose a model with `/model` or change the profile configuration. The TUI does not switch authentication methods automatically or modify shared credentials.

The full-screen viewport keeps the composer pinned during resizing and history navigation. Use the mouse wheel or PgUp/PgDn to browse the conversation. Drag to select text: hold at the conversation's top or bottom edge to scroll automatically and extend the selection across pages, or use the wheel while holding the mouse button. Releasing the mouse automatically copies the full selection, including text outside the viewport. Ctrl+C copies and clears an active selection; Esc clears it. Scrolling after release, typing, resizing, or changes to the selected text clear the selection. Clipboard writes use OSC 52 with local clipboard tools as a fallback; over SSH, the terminal must allow OSC 52. Your terminal's native selection override, usually Shift+drag, remains available. Set `mouseTracking: false` for native dragging at all times and keyboard history navigation. Completed output is added to normal terminal scrollback when the TUI closes.

### From source

Clone Harness and this repository into the same parent directory. Replace `YOUR_REPOSITORY_URL` with this repository's Git clone URL:

```sh
mkdir harness-workspace
cd harness-workspace

git clone --branch dsh-v0.2.1-rc.2 https://github.com/deepseek-ai/deepseek-harness.git
git clone YOUR_REPOSITORY_URL deepseek-harness-tui
```

Build the supported Harness runtime:

```sh
cd deepseek-harness
pnpm install
pnpm run build
```

Switch to the TUI repository, install its dependencies, and link it to Harness:

```sh
cd ../deepseek-harness-tui
npm install
npm run setup
npm run build
```

Start a live conversation using your configured provider credentials:

```sh
npm start
```

`npm run setup` finds Harness at `../deepseek-harness` and leaves that checkout unchanged. For a different location, use `npm run setup -- /path/to/deepseek-harness`. Source launches use the same `deepseek-harness-tui` profile name as the global command, but store settings and sessions separately in this repository's `.dsh-home/`. Put provider overrides in `.dsh-home/profiles/deepseek-harness-tui/cordis.patch.yml`.

Setup migrates legacy `learn-tui` profiles when the new profile directories do not exist, preserving the live profile's custom configuration. If both names exist, setup keeps the new profile and leaves the old one untouched for manual review.

To make your source build available as a global command, run the following from `deepseek-harness-tui`:

```sh
npm pack
npm install -g @deepseek-ai/dsh@0.2.1-rc.2 ./nickyuan-deepseek-harness-tui-0.1.2.tgz
deepseek-harness-tui
```
