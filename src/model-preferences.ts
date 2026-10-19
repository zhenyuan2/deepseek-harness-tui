import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';

export interface ModelPreferences {
  selection?: ModelSelection;
  sessions: Record<string, ModelSelection>;
}
function selection(value: unknown): ModelSelection {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved model selection.');
  const item = value as Record<string, unknown>;
  for (const key of ['provider', 'model']) {
    if (typeof item[key] !== 'string' || !item[key].trim()) throw new Error(`Invalid saved ${key}.`);
  }
  if (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string' || !item.reasoningEffort.trim())) {
    throw new Error('Invalid saved reasoning effort.');
  }
  return { provider: item.provider, model: item.model,
    ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: item.reasoningEffort }) } as ModelSelection;
}
export async function readModelPreferences(path?: string): Promise<ModelPreferences> {
  if (!path) return { sessions: {} };
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) {
      throw new Error('Invalid model preferences.');
    }
    return { selection: value.selection === undefined ? undefined : selection(value.selection),
      sessions: Object.fromEntries(Object.entries(value.sessions).map(([id, item]) => [id, selection(item)])) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {} };
    throw error;
  }
}
export async function saveModelPreferences(path: string, preferences: ModelPreferences): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(preferences, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
