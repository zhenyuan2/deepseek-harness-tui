# DeepSeek Harness TUI

A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

<img src="assets/welcome-screen.png" alt="DeepSeek Harness TUI welcome screen with the DeepSeek Harness" width="720">

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

Create a workspace with both repositories as sibling directories. `npm run setup` expects this layout by default:

```sh
mkdir harness-workspace
cd harness-workspace

git clone https://github.com/deepseek-ai/deepseek-harness.git
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
cd deepseek-harness-tui
npm install
npm run setup
npm run build
npm start
```

By default, `npm run setup` links to `../deepseek-harness`. For a different Harness location, use `npm run setup -- /path/to/deepseek-harness`. When running from source, settings and sessions are stored in `.dsh-home/`.
