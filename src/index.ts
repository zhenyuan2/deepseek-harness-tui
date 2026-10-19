import { join } from 'node:path';
/** Cordis entry point: dependencies, configuration, and owned UI lifecycle. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-cmdline';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import { openTerminal } from './terminal.js';
import { TuiRuntime, type DeepSeekProvider } from './runtime.js';

/** Cordis identifies the plugin independently of its npm package name. */
export const name = 'simple-tui';

/** Activation waits until the declared service providers are available. */
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'approval'];

/** Deployment choices are configured in cordis.patch.yml. */
export interface Config {
  title: string;
  maxRows: number;
  maxOutputChars: number;
  resumeSessionId: string;
  resumeLimit: number;
  deepseekProvider: DeepSeekProvider;
  mouseTracking: boolean;
}
export const Config: z<Config> = z.object({
  title: z.string().default('DeepSeek Harness TUI'),
  maxRows: z.number().min(10).max(10000).step(1).default(500),
  maxOutputChars: z.number().min(1000).max(100_000_000).step(1).default(1_000_000),
  resumeSessionId: z.string().default(''),
  resumeLimit: z.number().min(10).max(1000).step(1).default(100),
  deepseekProvider: z.union(['deepseek-official', 'deepseek-account'] as const).default('deepseek-official'),
  mouseTracking: z.boolean().default(false),
});

/** Mount one terminal and Agent; Cordis unload cancels and disposes both. */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit');
  if (!exit) throw new Error('simple-tui must be launched through a dsh profile.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('simple-tui requires an interactive terminal.');
  ctx.effect(() => {
    const abort = new AbortController();
    let close: (() => void) | undefined;
    let exiting = false;
    const quit = (): void => {
      if (exiting) return;
      exiting = true;
      try { close?.(); } finally { runtime.abort(); exit(0); }
    };
    const settingsHome = process.env.DSH_HOME || join(process.cwd(), '.dsh-home');
    const runtime = new TuiRuntime(ctx, { ...config, statuslinePath: join(settingsHome, 'simple-tui-statusline.json'),
      modelPreferencesPath: join(settingsHome, 'simple-tui-model.json') }, (view, actions) => {
      close?.(); close = undefined;
      close = openTerminal(view, actions, config.title, undefined, { mouseTracking: config.mouseTracking });
    }, quit);
    const startup = (async () => {
      await Promise.race([
        ctx.get('loader')?.await(),
        new Promise<void>(resolve => abort.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      if (abort.signal.aborted) return;
      await runtime.start(process.env.DSH_TUI_RESUME_SESSION || config.resumeSessionId || undefined);
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      close?.();
      console.error('simple-tui:', error instanceof Error ? error.message : String(error));
      exit(1);
    });
    return async () => {
      abort.abort(); runtime.abort();
      try { close?.(); }
      finally { await startup; await runtime.dispose(); }
    };
  });
}
