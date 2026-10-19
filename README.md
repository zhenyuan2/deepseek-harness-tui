# DeepSeek Harness TUI

A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Chat with your agent, review tool output and file diffs, and approve actions from the terminal—with streaming Markdown, model selection, and conversation history.

## Installation

Requires Node.js **22.19.0 or later** and pnpm on your `PATH`.

Configure your provider credentials in Harness, or set the `DEEPSEEK_API_KEY` environment variable.

Development baseline: DeepSeek Harness **0.2.1-rc.2**.

### npm

Install the Harness CLI and TUI globally:

```sh
npm install -g @deepseek-ai/dsh @nickyuan/deepseek-harness-tui
```

Run from your project directory:

```sh
deepseek-harness-tui
```

The first launch automatically sets up a dedicated Harness profile. Settings and sessions are saved in `~/.dsh`.

**Update**

Close the TUI before updating:

```sh
npm install -g @nickyuan/deepseek-harness-tui@latest
deepseek-harness-tui
```

### Source

Clone Harness and this repository into the same parent directory:

```sh
mkdir harness-workspace
cd harness-workspace

git clone --branch dsh-v0.2.1-rc.2 https://github.com/deepseek-ai/deepseek-harness.git
git clone https://github.com/zhenyuan2/deepseek-harness-tui.git
```

Build the Harness runtime:

```sh
cd deepseek-harness
pnpm install
pnpm run build
```

Install and start the TUI:

```sh
cd ../deepseek-harness-tui
npm install
npm run setup
npm run build
npm start
```

For a different Harness location, use `npm run setup -- /path/to/deepseek-harness`. When running from source, settings and sessions are stored in `.dsh-home/`.

**Update**

Close the TUI, then run from the TUI repository:

```sh
git pull --ff-only
npm install
npm run setup
npm run build
npm start
```

Harness can be updated independently. After updating a Harness checkout, rebuild it and rerun `npm run setup` and `npm run build` here.
