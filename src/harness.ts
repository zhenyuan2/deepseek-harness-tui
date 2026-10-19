/** Keep the UI's runtime dependency on Harness exports and service methods here. */
import type { Context } from '@deepseek-ai/cordis';
import * as agent from '@deepseek-ai/dsh-agent';
import * as brand from '@deepseek-ai/dsh-brand';
import * as llm from '@deepseek-ai/dsh-llm';

function requiredExport<T, K extends keyof T>(module: T, key: K, name: string): T[K] {
  if (typeof module[key] !== 'function') throw new Error(`Incompatible Harness API: ${name}.${String(key)}() is unavailable.`);
  return module[key];
}

export const installModelSelection = requiredExport(agent, 'installModelSelection', '@deepseek-ai/dsh-agent');
export const brandString = requiredExport(brand, 'brandString', '@deepseek-ai/dsh-brand');
export const createUserMessage = requiredExport(llm, 'createUserMessage', '@deepseek-ai/dsh-llm');
// Usage display is optional; its absence must not prevent a conversation.
export const lastAssistantStreamChunk = typeof llm.lastAssistantStreamChunk === 'function' ? llm.lastAssistantStreamChunk : undefined;

export function hasMethod(service: unknown, method: string): boolean {
  return !!service && typeof (service as Record<string, unknown>)[method] === 'function';
}

export function requireMethods(service: unknown, name: string, methods: readonly string[]): void {
  const missing = methods.filter(method => !hasMethod(service, method));
  if (missing.length) throw new Error(`Incompatible Harness API: ${missing.map(method => `${name}.${method}()`).join(', ')} unavailable.`);
}

export function checkHarnessServices(ctx: Context): void {
  requireMethods(ctx.get('agents'), 'agents', ['create']);
  requireMethods(ctx.get('agentDefaultModel'), 'agentDefaultModel', ['currentSelection']);
  requireMethods(ctx.get('sessions'), 'sessions', ['flush']);
}
