import { readModelPreferences, saveModelPreferences } from './model-preferences.js';
import { readStatusline, saveStatusline, statuslineFields, defaultStatusline, type StatuslineField } from './statusline.js';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle, AgentSetup, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { brandString, installModelSelection, checkHarnessServices, hasMethod, requireMethods } from './harness.js';
import type { LlmModelInfo, LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { connect, projectSessionEvent } from './bridge.js';
import { ViewModel, type PickerOption, type PickerState } from './model.js';
import type { Actions } from './terminal.js';

/** @deprecated Legacy configuration value; Harness manages provider availability. */
export type DeepSeekProvider = 'deepseek-official' | 'deepseek-account';
export interface RuntimeConfig { maxRows: number; maxOutputChars: number; resumeLimit: number; statuslinePath?: string; modelPreferencesPath?: string; deepseekProvider?: DeepSeekProvider }
export interface RuntimeSession {
  handle?: AgentHandle;
  selection: ModelSelectionRef;
  view: ViewModel;
  actions: ReturnType<typeof connect>;
}

/** Internal notices also use the user role; only human input starts a conversation. */
function hasConversation(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && event.data.content.some(block => block.type !== 'text' || block.text.trim().length > 0));
}

/** Own session replacement, cancellable selectors, and all acquired Agent handles. */
export class TuiRuntime {
  current?: RuntimeSession;
  private readonly lifetime = new AbortController();
  private request?: AbortController;
  private readonly operations = new Set<Promise<void>>();
  private readonly owned = new Set<AgentHandle>();
  private statusline: readonly StatuslineField[] = defaultStatusline;
  private savedSelection?: ModelSelection;
  private readonly preferences = new Map<string, ModelSelection>();
  constructor(private readonly ctx: Context, private readonly config: RuntimeConfig,
    private readonly activate: (view: ViewModel, actions: Actions) => void, private readonly quit: () => void) {}

  async start(id?: string): Promise<void> {
    checkHarnessServices(this.ctx);
    let settingsError: unknown;
    try { this.statusline = await readStatusline(this.config.statuslinePath); }
    catch (error) { settingsError = error; }
    try {
      const saved = await readModelPreferences(this.config.modelPreferencesPath);
      this.savedSelection = saved.selection;
      for (const [id, selection] of Object.entries(saved.sessions)) this.preferences.set(id, selection);
    } catch (error) {
      console.error('simple-tui: could not read model preferences:', error instanceof Error ? error.message : String(error));
    }
    if (this.lifetime.signal.aborted) return;
    if (settingsError) console.error('simple-tui: could not read statusline settings:', settingsError instanceof Error ? settingsError.message : String(settingsError));
    if (!id) { this.startDraft(); return; }
    const candidate = await this.acquire(id, this.lifetime.signal);
    if (this.lifetime.signal.aborted) return;
    this.install(candidate, !!id);
  }

  /** A composer and model choice need no Agent and therefore no storage identity. */
  private startDraft(clearScreen = false): void {
    const selection: ModelSelectionRef = { current: { ...(this.savedSelection ?? this.ctx.agentDefaultModel.currentSelection()) }, assembled: undefined };
    const view = new ViewModel(this.config.maxRows, this.config.maxOutputChars);
    view.statusline = this.statusline;
    view.sessionId = 'Not started'; view.cwd = process.cwd(); view.status = 'idle';
    view.model = `${selection.current!.provider}/${selection.current!.model}`;
    view.reasoning = selection.current!.reasoningEffort ?? '';
    const commands = { resume: (id?: string) => this.openResume(id), model: (route?: string, effort?: string) => this.openModel(route, effort), statusline: () => this.openStatusline(), newSession: (clearScreen?: boolean) => this.newSession(clearScreen) };
    const pending: string[] = [];
    let creating = false;
    let creation: AbortController | undefined;
    const actions = connect(this.ctx, undefined, view, this.quit, selection, commands, text => {
      if (this.lifetime.signal.aborted) return;
      if (creation?.signal.aborted) { view.add('system', 'Startup is cancelling. Recall your message with ↑ and retry when ready.'); return; }
      pending.push(text);
      if (creating) return;
      view.welcomeDismissed = true;
      creating = true; creation = new AbortController(); view.setStatus('running');
      const state = this.current!;
      const work = (async () => {
        try {
          const candidate = await this.acquire(undefined, AbortSignal.any([this.lifetime.signal, creation!.signal]), selection);
          if (this.lifetime.signal.aborted || creation?.signal.aborted || this.current !== state) { await this.release(candidate.handle); return; }
          // Keep the same view and action object so the terminal retains its transcript and editor.
          actions.dispose();
          state.handle = candidate.handle;
          view.statusline = this.statusline;
          view.sessionId = candidate.handle.agent.session.id;
          view.setStatus(candidate.handle.agent.status);
          Object.assign(actions, connect(this.ctx, candidate.handle.agent, view, this.quit, selection, commands));
          for (const input of pending.splice(0)) actions.submit(input);
        } catch (error) {
          if (!this.lifetime.signal.aborted && !creation?.signal.aborted) {
            view.setStatus('idle');
            view.add('error', `Could not start conversation: ${error instanceof Error ? error.message : String(error)}`);
          }
          pending.length = 0;
        } finally {
          if (creation?.signal.aborted) { pending.length = 0; if (this.current === state) view.setStatus('idle'); }
          creation = undefined; creating = false;
        }
      })();
      this.operations.add(work);
      void work.then(() => { this.operations.delete(work); });
    });
    const cancelDraft = actions.cancel;
    actions.cancel = () => {
      if (creating) { creation?.abort(); pending.length = 0; view.add('system', 'Cancelling conversation startup…'); }
      cancelDraft();
    };
    const previous = this.current;
    this.current = { selection, view, actions };
    if (clearScreen) view.clearScreen(true);
    try { this.activate(view, actions); }
    catch (error) { actions.dispose(); this.current = previous; if (previous) this.activate(previous.view, previous.actions); throw error; }
    previous?.actions.dispose();
    this.refreshContext(this.current);
  }

  private async acquire(id: string | undefined, signal: AbortSignal, initialSelection?: ModelSelectionRef): Promise<{ handle: AgentHandle; selection: ModelSelectionRef }> {
    requireMethods(this.ctx.get('agents'), 'agents', [id ? 'resume' : 'create']);
    const selection: ModelSelectionRef = initialSelection ?? { current: { ...(this.savedSelection ?? this.ctx.agentDefaultModel.currentSelection()) }, assembled: undefined };
    const setup: AgentSetup = (agentCtx, agent) => {
      const previous = id ? agent.session.requestHeader()?.config : undefined;
      const saved = id ? this.preferences.get(id) : undefined;
      if (saved) selection.current = { ...saved };
      else if (previous) selection.current = { provider: previous.provider, model: previous.model,
        ...(previous.reasoningEffort ? { reasoningEffort: previous.reasoningEffort } : {}) };
      installModelSelection(agentCtx, selection);
    };
    const handle = id ? await this.ctx.agents.resume({ resumeSessionId: brandString<SessionId>(id), signal, setup })
      : await this.ctx.agents.create({ sessionId: brandString<SessionId>(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() }, agentOptions: selection.current, signal, setup });
    this.owned.add(handle);
    if (id && !hasConversation(handle.agent.session.snapshotEvents())) {
      await this.release(handle);
      throw new Error('This session has no user messages to resume.');
    }
    return { handle, selection };
  }

  private install(candidate: { handle: AgentHandle; selection: ModelSelectionRef }, resumed: boolean): void {
    const view = new ViewModel(this.config.maxRows, this.config.maxOutputChars);
    const agent = candidate.handle.agent;
    const selected = candidate.selection.current!;
    view.statusline = this.statusline;
    view.sessionId = agent.session.id; view.cwd = agent.session.header?.cwd ?? process.cwd();
    view.model = `${selected.provider}/${selected.model}`; view.reasoning = selected.reasoningEffort ?? '';
    view.status = agent.status;
    if (resumed) { for (const event of agent.session.snapshotEvents()) projectSessionEvent(view, event); view.finishTurn(); }
    const actions = connect(this.ctx, agent, view, this.quit, candidate.selection, {
      resume: id => this.openResume(id), model: (route, effort) => this.openModel(route, effort), statusline: () => this.openStatusline(), newSession: (clearScreen?: boolean) => this.newSession(clearScreen),
    });
    const previous = this.current;
    const state: RuntimeSession = { ...candidate, view, actions };
    this.current = state;
    view.add('system', resumed ? `Resumed session: ${view.sessionId}` : 'Describe a task to get started. /help for shortcuts.');
    try { this.activate(view, actions); }
    catch (error) {
      actions.dispose(); this.current = previous;
      if (previous) this.activate(previous.view, previous.actions);
      throw error;
    }
    previous?.actions.dispose();
    this.refreshContext(state);
  }

  private refreshContext(state: RuntimeSession): void {
    const llm = this.ctx.get('llm');
    const selection = state.selection.current;
    if (!llm || !hasMethod(llm, 'resolveModelInfo') || !selection) return;
    const route = state.view.model;
    const work = (async () => {
      try {
        const info = await llm.resolveModelInfo(selection.provider, selection.model, this.lifetime.signal);
        if (!this.lifetime.signal.aborted && this.current === state && state.view.model === route) {
          state.view.tokens.contextWindow = info.context?.contextWindow ?? state.view.tokens.contextWindow;
          state.view.reasoning = state.selection.current?.reasoningEffort ?? info.reasoning?.defaultEffort ?? '';
          state.view.changed();
        }
      } catch { /* Metadata is optional; unknown capacity stays unavailable. */ }
    })();
    this.operations.add(work);
    void work.then(() => { this.operations.delete(work); });
  }

  private idle(state = this.current): state is RuntimeSession {
    if (!state) return false;
    if ((state.handle?.agent.status ?? state.view.status) !== 'idle' || state.view.queued.length || state.view.approval) {
      state.view.add('error', 'Stop the current turn and clear queued input before switching sessions or models.'); return false;
    }
    return true;
  }

  private picker(state: RuntimeSession, title: string, hint?: string): PickerState {
    this.request?.abort();
    const picker: PickerState = { title, hint, options: [], query: '', selection: 0, loading: true, pageSize: 5,
      cancel: () => {
        if (state.view.picker !== picker) return;
        this.request?.abort(); state.view.picker = undefined; state.view.changed();
      } };
    state.view.picker = picker; state.view.changed(); return picker;
  }

  private run(state: RuntimeSession, picker: PickerState, action: (signal: AbortSignal) => Promise<void>): void {
    this.request?.abort();
    const request = new AbortController(); this.request = request;
    const work = (async () => {
      try { await action(request.signal); }
      catch (error) {
        if (!request.signal.aborted && !this.lifetime.signal.aborted) {
          const text = error instanceof Error ? error.message : String(error);
          if (state.view.picker === picker) { picker.error = text; picker.loading = false; state.view.changed(); }
          else this.current?.view.add('error', text);
        }
      }
    })();
    this.operations.add(work);
    void work.then(() => { this.operations.delete(work); });
  }

  newSession(clearScreen = false): void {
    const state = this.current;
    if (!this.idle(state)) return;
    if (!state.handle) {
      state.view.picker?.cancel();
      if (clearScreen) {
        state.view.rows = [];
        state.view.clearScreen(true);
      }
      return;
    }
    const picker = this.picker(state, 'New conversation', 'Saving the current conversation…');
    picker.loadingText = 'Saving conversation…';
    this.run(state, picker, async signal => {
      await this.ctx.sessions.flush(state.handle!.agent.session);
      if (signal.aborted || this.current !== state || state.view.picker !== picker) return;
      this.preferences.set(state.view.sessionId, { ...state.selection.current! });
      this.startDraft(clearScreen);
      state.view.picker = undefined;
      await this.release(state.handle!);
    });
  }

  openResume(id?: string): void {
    const state = this.current;
    if (!this.idle(state)) return;
    const picker = this.picker(state, 'Resume conversation', 'Search titles, session ids or directories · current session stays open until loading succeeds');
    if (id) { this.resume(state, picker, id); return; }
    this.run(state, picker, async signal => {
      const query = this.ctx.get('sessionQuery');
      if (!query) throw new Error('Session browsing requires the Harness session-query service. /resume <id> can still load a known session.');
      requireMethods(query, 'sessionQuery', ['listSessions', 'observeSession']);
      const records = (await query.listSessions(signal)).filter(item => item.header.origin !== 'subagent')
        .sort((a, b) => b.header.createdAt - a.header.createdAt);
      let failures = 0, titleFailures = 0;
      const stale = (signal: AbortSignal) => signal.aborted || this.current !== state || state.view.picker !== picker;
      const load = async (offset: number, signal: AbortSignal): Promise<void> => {
        const conversations: typeof records = [];
        let count = offset;
        // Bound full-log reads and keep scanning through empty sessions to fill a page.
        while (count < records.length && conversations.length < this.config.resumeLimit) {
          if (stale(signal)) return;
          const batch = records.slice(count, count + Math.min(8, this.config.resumeLimit - conversations.length));
          const results = await Promise.allSettled(batch.map(async record => {
            const observation = await query.observeSession(record.header.id, { signal, projectionMode: 'none' });
            try { return hasConversation(observation.events); }
            finally { observation[Symbol.dispose](); }
          }));
          if (stale(signal)) return;
          results.forEach((result, index) => {
            if (result.status === 'rejected') failures++;
            else if (result.value) conversations.push(batch[index]!);
          });
          count += batch.length;
        }
        const titles = hasMethod(query, 'readTitleSnapshots')
          ? await query.readTitleSnapshots(conversations.map(item => item.header.id), signal)
          : [];
        if (stale(signal)) return;
        titleFailures += titles.filter(item => item.status === 'rejected').length;
        const choices = conversations.map((record, index): PickerOption => {
          const result = titles[index];
          const title = result?.status === 'fulfilled' ? result.value.title?.title : undefined;
          const current = record.header.id === state.view.sessionId;
          const disabled = record.live && !current;
          return { id: record.header.id, label: title || record.header.id, current, disabled,
            description: `Created ${new Date(record.header.createdAt).toLocaleString()} · ${record.header.cwd ?? 'No directory'} · ${record.header.id}${disabled ? ' · active elsewhere' : ''}`,
            choose: () => this.resume(state, picker, record.header.id) };
        });
        picker.options = [...picker.options.filter(item => item.id !== '__load_older__'), ...choices];
        const loaded = picker.options.length;
        if (count < records.length) picker.options.push({ id: '__load_older__', label: 'Load older conversations…',
          description: `${records.length - count} sessions remaining to check`, choose: () => {
            picker.loading = true; picker.error = undefined; state.view.changed();
            this.run(state, picker, signal => load(count, signal));
          } });
        picker.hint = `${loaded} conversations · checked ${count}/${records.length} sessions · empty sessions hidden${count < records.length ? ' · clear search to load older' : ''}${failures ? ` · ${failures} sessions unreadable` : ''}${titleFailures ? ` · ${titleFailures} titles unavailable; select by id` : ''}`;
        if (offset === 0) picker.selection = Math.max(0, picker.options.findIndex(item => item.current));
        picker.loading = false; state.view.changed();
      };
      await load(0, signal);
    });
  }

  private resume(state: RuntimeSession, picker: PickerState, id: string): void {
    if (state.view.picker !== picker || this.current !== state || !this.idle(state)) return;
    if (id === state.view.sessionId) { picker.cancel(); return; }
    picker.loading = true; picker.error = undefined; picker.hint = `Loading ${id}…`; state.view.changed();
    this.run(state, picker, async signal => {
      if (state.handle) await this.ctx.sessions.flush(state.handle.agent.session);
      if (signal.aborted || this.current !== state) return;
      if (state.handle) this.preferences.set(state.view.sessionId, { ...state.selection.current! });
      const candidate = await this.acquire(id, signal);
      if (signal.aborted || this.current !== state || state.view.picker !== picker) { await this.release(candidate.handle); return; }
      try { this.install(candidate, true); }
      catch (error) { await this.release(candidate.handle); throw error; }
      state.view.picker = undefined;
      if (state.handle) await this.release(state.handle);
    });
  }

  openStatusline(): void {
    const state = this.current;
    if (!state) return;
    const selected = new Set(this.statusline);
    const picker = this.picker(state, 'Configure statusline', 'Space toggles a field · Enter saves · Esc discards · token totals belong to this conversation');
    picker.statuslineDraft = [...this.statusline];
    let saving = false;
    const cancel = picker.cancel;
    picker.cancel = () => { if (!saving) cancel(); };
    picker.options = statuslineFields.map(field => ({ ...field, checked: selected.has(field.id), choose: () => {
      if (saving) return;
      if (selected.has(field.id)) selected.delete(field.id); else selected.add(field.id);
      picker.options.find(option => option.id === field.id)!.checked = selected.has(field.id);
      picker.statuslineDraft = statuslineFields.filter(field => selected.has(field.id)).map(field => field.id);
      state.view.changed();
    } }));
    picker.loading = false;
    picker.confirm = () => {
      if (saving) return;
      saving = true; picker.loading = true; picker.error = undefined; state.view.changed();
      const fields = statuslineFields.filter(field => selected.has(field.id)).map(field => field.id);
      this.run(state, picker, async () => {
        try {
          await saveStatusline(this.config.statuslinePath, fields);
          this.statusline = fields;
          if (this.current) { this.current.view.statusline = fields; this.current.view.changed(); }
          if (state.view.picker === picker) { state.view.picker = undefined; state.view.changed(); }
        } finally { saving = false; }
      });
    };
    state.view.changed();
  }

  openModel(route?: string, effort?: string): void {
    const state = this.current;
    if (!this.idle(state)) return;
    const picker = this.picker(state, 'Select model', `Current: ${state.view.model} · reasoning ${state.view.reasoning}`);
    if (route) { this.depth(state, picker, route, effort); return; }
    this.run(state, picker, async signal => {
      const llm = this.ctx.get('llm'); if (!llm) throw new Error('This profile has no model provider service.');
      requireMethods(llm, 'llm', ['listProviders', 'listModels']);
      const providers = llm.listProviders();
      const catalogs = await Promise.allSettled(providers.map(provider => llm.listModels(provider.id)));
      if (signal.aborted || state.view.picker !== picker || this.current !== state) return;
      const models: LlmModelInfo[] = []; const failures: string[] = [];
      catalogs.forEach((result, index) => {
        if (result.status === 'fulfilled') models.push(...result.value);
        else failures.push(`${providers[index]!.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      });
      const selected = state.selection.current!;
      if (!models.some(model => model.provider === selected.provider && model.id === selected.model)) {
        models.unshift({ provider: selected.provider, id: selected.model, name: selected.model, description: 'Current route (not advertised in the catalog)' });
      }
      picker.options = models.map(model => ({ id: `${model.provider}/${model.id}`, label: model.name,
        description: `${model.provider}/${model.id}${model.description ? ` · ${model.description}` : ''}`,
        current: model.provider === selected.provider && model.id === selected.model,
        choose: () => this.depth(state, picker, `${model.provider}/${model.id}`) }));
      picker.selection = Math.max(0, picker.options.findIndex(item => item.current));
      picker.hint = failures.length ? `Some catalogs could not load: ${failures.join('; ')}` : 'Choose a model, then choose its reasoning depth';
      picker.loading = false; state.view.changed();
    });
  }

  private depth(state: RuntimeSession, previous: PickerState, route: string, effort?: string): void {
    if (state.view.picker !== previous || this.current !== state) return;
    const picker = this.picker(state, 'Reasoning depth', route);
    picker.back = () => this.openModel();
    this.run(state, picker, async signal => {
      const separator = route.indexOf('/');
      if (separator < 1 || separator === route.length - 1 || /\s/.test(route)) throw new Error('Usage: /model provider/model [effort]');
      const provider = route.slice(0, separator), model = route.slice(separator + 1);
      const llm = this.ctx.get('llm');
      requireMethods(llm, 'llm', ['listProviders', 'resolveModelInfo']);
      if (!llm?.listProviders().some(item => item.id === provider)) throw new Error(`Provider is not registered: ${provider}`);
      const info = await llm.resolveModelInfo(provider, model, signal);
      if (signal.aborted || state.view.picker !== picker || this.current !== state) return;
      const choices = (info.reasoning?.efforts ?? []).map(item => ({
        id: String(item.id), label: item.name, description: item.description ?? String(item.id), effort: item.id,
      }));
      const sameModel = route === state.view.model;
      const effective = (sameModel ? state.selection.current?.reasoningEffort : undefined) ?? info.reasoning?.defaultEffort;
      picker.hint = choices.length ? `${info.name} · supported depths from ${provider}` : `${info.name} · no adjustable reasoning depth`;
      picker.options = choices.map(choice => ({ id: choice.id, label: choice.label, description: choice.description,
        current: sameModel && choice.effort === effective,
        choose: () => this.applyModel(state, picker, info, choice.effort) }));
      picker.selection = Math.max(0, choices.findIndex(choice => choice.effort === effective));
      picker.loading = false;
      // Keep the explicit command alias for existing scripts; it is not a UI option.
      if (effort === 'default') this.applyModel(state, picker, info, undefined);
      else if (effort !== undefined) {
        const option = picker.options.find(item => item.id === effort);
        if (!option) picker.error = `Unsupported depth ${effort}. Supported: ${choices.map(item => item.id).join(', ') || 'none'}`;
        else option.choose();
      } else if (!choices.length) this.applyModel(state, picker, info, undefined);
      state.view.changed();
    });
  }

  private applyModel(state: RuntimeSession, picker: PickerState, info: LlmResolvedModelInfo, effort: ReasoningEffortId | undefined): void {
    if (this.current !== state || state.view.picker !== picker || !this.idle(state)) return;
    const selected: ModelSelection = { provider: info.provider, model: info.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    const commit = () => {
      this.savedSelection = selected;
      state.selection.current = { ...selected };
      if (state.handle) this.preferences.set(state.view.sessionId, { ...selected });
      state.view.tokens.contextWindow = info.context?.contextWindow;
      const depth = effort ?? info.reasoning?.defaultEffort ?? '';
      state.view.model = `${info.provider}/${info.id}`; state.view.reasoning = depth; state.view.picker = undefined;
      state.view.add('system', `Model: ${state.view.model} · reasoning: ${depth || 'unavailable'} · applies to the next request.`);
    };
    if (!this.config.modelPreferencesPath) { commit(); return; }
    if (picker.loading) return;
    picker.loading = true; picker.saving = true; picker.loadingText = 'Saving model preferences…'; picker.error = undefined;
    const cancel = picker.cancel;
    const back = picker.back;
    let saving = true;
    picker.cancel = () => { if (!saving) cancel(); };
    picker.back = () => { if (!saving) back?.(); };
    state.view.changed();
    this.run(state, picker, async () => {
      try {
        const persisted = await readModelPreferences(this.config.modelPreferencesPath);
        const sessions = new Map(Object.entries(persisted.sessions));
        if (state.handle) sessions.set(state.view.sessionId, selected);
        await saveModelPreferences(this.config.modelPreferencesPath!, { selection: selected, sessions: Object.fromEntries(sessions) });
        commit();
      } finally { saving = false; picker.saving = false; picker.cancel = cancel; picker.back = back; }
    });
  }

  private async release(handle: AgentHandle): Promise<void> {
    handle.agent.cancel({ kind: 'disposed' });
    await handle.agent.whenIdle();
    try { await this.ctx.sessions.flush(handle.agent.session); }
    finally { await handle.dispose(); this.owned.delete(handle); }
  }

  abort(): void {
    this.lifetime.abort(); this.request?.abort();
    this.current?.view.picker?.cancel();
    this.current?.handle?.agent.cancel({ kind: 'disposed' });
  }

  async dispose(): Promise<void> {
    this.abort(); this.current?.actions.dispose();
    await Promise.allSettled([...this.operations]);
    const results = await Promise.allSettled([...this.owned].map(handle => this.release(handle)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
