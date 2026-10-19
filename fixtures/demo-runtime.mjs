/** Keyless UI exercise only: canned events, no model calls or actual tools. */
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';

export const name = 'simple-tui-demo-runtime';

export function apply(ctx) {
  const selection = { provider: 'offline', model: 'canned-demo' };
  const history = new Map(); const live = new Set();
  for (const [id, title] of [['demo-login', 'Investigate login (simulation)'], ['demo-tests', 'Review tests (simulation)']]) {
    history.set(id, { header: { id, version: 4, createdAt: Date.now() - (history.size + 1) * 60_000, cwd: process.cwd(), isSeeded: false }, title,
      events: [{ type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: title }], source: { kind: 'user' } }) },
        { type: 'assistant/message', seq: 1, time: Date.now(), surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'This is a simulated historical conversation. No files or model APIs were used.' }], source: selection }) } }] });
  }
  ctx.on('session/event', (session, event) => {
    const record = history.get(session.id);
    if (record) record.events.push({ ...event, seq: record.events.length, time: Date.now() });
  });
  ctx.provide('agentDefaultModel', { currentSelection: () => selection });
  ctx.provide('sessions', { flush: async () => {} });
  ctx.provide('approval', {});
  ctx.provide('sessionQuery', {
    async listSessions() { return [...history.values()].map(record => ({ header: record.header, live: live.has(record.header.id), persisted: true })); },
    async observeSession(id) { return { events: [...history.get(id).events], [Symbol.dispose]() {} }; },
    async readTitleSnapshots(ids) { return ids.map(id => ({ status: 'fulfilled', value: { session: history.get(id).header,
      title: { title: history.get(id).title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0, updatedAt: Date.now() } } })); },
  });
  ctx.provide('llm', {
    listProviders: () => [{ id: 'offline', name: 'Offline simulation' }],
    async listModels() { return ['canned-demo', 'canned-fast'].map(id => ({ provider: 'offline', id, name: id, description: 'Simulated model; no API calls' })); },
    async resolveModelInfo(provider, id) {
      if (provider !== 'offline' || !['canned-demo', 'canned-fast'].includes(id)) throw new Error('Unknown simulated model');
      return { provider, id, name: id, context: { contextWindow: 128_000 }, reasoning: { defaultEffort: 'high', efforts: [
        { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Maximum' },
      ] } };
    },
  });
  const create = async options => {
      const record = history.get(options.sessionId) ?? { header: { id: options.sessionId, version: 4, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false }, events: [], title: 'New demo conversation (simulation)' };
      history.set(options.sessionId, record); live.add(options.sessionId);
      let running; let turn = 0;
      let signal;
      let disposed = false;
      const queue = [];
      const agent = {
        session: { id: options.sessionId, header: record.header, requestHeader: () => undefined, snapshotEvents: () => [...record.events] }, status: 'idle',
        followup(message) {
          if (disposed) throw new Error('Demo agent disposed');
          queue.push(message);
          if (!running) {
            agent.status = 'running';
            ctx.emit('agent/status', { agent, status: 'running' });
            running = drain().finally(() => {
              running = undefined;
              agent.status = 'idle';
              ctx.emit('agent/status', { agent, status: 'idle' });
            });
          }
        },
        cancel() { queue.length = 0; signal?.abort(); },
        async whenIdle() { await running; },
      };
      await options.setup?.(new Context(), agent);
      async function drain() {
        while (queue.length && !disposed) {
          const message = queue.shift();
          signal = new AbortController(); turn++;
          ctx.emit('session/event', agent.session, { type: 'request/context', data: { ...selection, contextWindow: 128_000 } });
          ctx.emit('session/event', agent.session, { type: 'user/message', data: message });
          try {
            if (message.content.some(block => block.text?.includes('approval'))) {
              const callId = `demo-${message.id}`;
              ctx.emit('session/event', agent.session, { type: 'tool/call', data: { callId, name: 'demo_action', arguments: '{"simulation":true}' } });
              const outcome = await ctx.waterfall('approval/request', {
                agent, callId, toolName: 'demo_action', reason: 'Simulated approval only; no command executes.', signal: signal.signal,
              }, async () => 'unavailable');
              ctx.emit('session/event', agent.session, { type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: outcome }] } } });
            }
            const demoCall = `read-${message.id}`;
            ctx.emit('session/event', agent.session, { type: 'tool/call', data: { callId: demoCall, name: 'Read', arguments: '{"file_path":"src/terminal.ts"}' } });
            await delay(300, undefined, { signal: signal.signal });
            ctx.emit('session/event', agent.session, { type: 'tool/result', data: { message: { toolCallId: demoCall, content: [{ type: 'text', text: 'Normal terminal buffer\nAppend completed messages\nKeep an editable live footer\nPreserve native scrollback' }] } } });
            const editCall = `edit-${message.id}`;
            ctx.emit('session/event', agent.session, { type: 'tool/call', data: { callId: editCall, name: 'Edit (simulation)', arguments: '{"file_path":"example.ts"}' } });
            await delay(250, undefined, { signal: signal.signal });
            ctx.emit('session/event', agent.session, { type: 'tool/result', data: {
              message: { toolCallId: editCall, content: [{ type: 'text', text: 'Preview only. No file was changed.' }] },
              meta: { diffs: [{ path: 'example.ts', oldText: 'const mode = "fullscreen";\n', newText: 'const mode = "scrollback";\n' }] },
            } });
            ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
            ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '先确认终端模式，再检查消息归档与输入区域。这里只模拟展示，不读取或修改文件。' } } });
            const response = [
              '## 终端界面演示', '',
              '现在，完成的对话会保留在**终端滚动历史**里。可以直接滚动、选择和复制。', '',
              '- 消息按角色排列，工具输出默认收起',
              '- 使用 `/details` 查看完整工具结果',
              '- 按 Ctrl+J 换行，Enter 整体发送', '',
              '```ts', 'const mode = "scrollback";', 'console.log("你好，DeepSeek");', '```', '',
              '这是离线模拟，没有调用模型或执行真实工具。',
            ].join('\n');
            for (const text of response) {
              await delay(9, undefined, { signal: signal.signal });
              ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } });
            }
            ctx.emit('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, stream: [], usage: { inputTokens: 1200, outputTokens: 180, cacheReadTokens: 3600 }, message: createAssistantMessage({ content: [{ type: 'text', text: response }], source: selection }) } });
            ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', outcome: { kind: 'committed' } } });
            ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          } catch (error) {
            if (error.name !== 'AbortError') throw error;
            ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', outcome: { kind: 'abandoned' } } });
            ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
          }
        }
      }
      return {
        agent,
        async dispose() { disposed = true; agent.cancel(); await agent.whenIdle(); live.delete(options.sessionId); },
      };
    };
  ctx.provide('agents', {
    create,
    async resume(options) {
      if (!history.has(options.resumeSessionId)) throw new Error('Demo conversation not found');
      return create({ ...options, sessionId: options.resumeSessionId });
    },
  });
}
