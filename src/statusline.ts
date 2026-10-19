/** Statusline preferences and provider-reported accounting; no text-length estimates. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import { lastAssistantStreamChunk } from './harness.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export const statuslineFields = [
  { id: 'model', label: 'Model', description: 'Currently selected model' },
  { id: 'reasoning', label: 'Reasoning depth', description: 'Currently selected reasoning effort' },
  { id: 'context', label: 'Context', description: 'Latest reported request input / model capacity; not live usage' },
  { id: 'input', label: 'Input', description: 'Conversation total input tokens, including cache reads and writes' },
  { id: 'output', label: 'Output', description: 'Conversation total output tokens, including reasoning' },
  { id: 'cache', label: 'Cache hit rate', description: 'Conversation cache-read / total input; — when unreported' },
] as const;
export type StatuslineField = typeof statuslineFields[number]['id'];
export const defaultStatusline: readonly StatuslineField[] = ['model', 'reasoning'];
export function parseStatusline(value: unknown): StatuslineField[] {
  if (!Array.isArray(value) || value.some(id => !statuslineFields.some(field => field.id === id))) {
    throw new Error('Invalid statusline fields.');
  }
  return [...new Set(value)] as StatuslineField[];
}
export async function readStatusline(path?: string): Promise<StatuslineField[]> {
  if (!path) return [...defaultStatusline];
  try { return parseStatusline(JSON.parse(await readFile(path, 'utf8')).fields); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...defaultStatusline]; throw error; }
}
export async function saveStatusline(path: string | undefined, fields: readonly StatuslineField[]): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ fields }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class TokenStats {
  input = 0;
  output = 0;
  cacheRead = 0;
  samples = 0;
  unknownCacheSamples = 0;
  contextTokens?: number;
  contextWindow?: number;
  private last?: { turn: number; step: number; usage: TokenUsage };
  apply(event: SessionEvent): void {
    if (event.type === 'request/context') this.contextWindow = event.data.contextWindow;
    // A retry is a separately billed attempt, even when its turn/step is unchanged.
    if (String(event.type) === 'llm/retry-started') this.last = undefined;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return;
    const usage = (event.type === 'assistant/message' ? event.data.usage : undefined)
      ?? lastAssistantStreamChunk?.(event.data.stream, 'usage')?.usage;
    if (!usage) return;
    const previous = this.last?.turn === event.data.turn && this.last.step === event.data.step ? this.last.usage : undefined;
    if (previous) this.add(previous, -1);
    this.add(usage, 1);
    this.contextTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    this.last = { turn: event.data.turn, step: event.data.step, usage };
  }
  private add(usage: TokenUsage, sign: number): void {
    this.input += sign * (usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
    this.output += sign * usage.outputTokens;
    this.cacheRead += sign * (usage.cacheReadTokens ?? 0);
    this.samples += sign;
    if (usage.cacheReadTokens === undefined) this.unknownCacheSamples += sign;
  }
  get cacheHitRate(): number | undefined {
    return this.samples && !this.unknownCacheSamples && this.input > 0 ? this.cacheRead / this.input : undefined;
  }
}
