import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** The extension-facing surface needed to exercise a session without pi's UI. */
export function fakePi(root: string, mode: 'tui' | 'rpc' | 'json' | 'print' = 'tui') {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const active = new Set<string>();
  const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, unknown>();
  const messages: unknown[] = [];
  const userMessages: unknown[] = [];
  const notifications: string[] = [];
  const widgets: (string[] | undefined)[] = [];
  const registeredTools: any[] = [];
  const registeredCommands: any[] = [];
  /** Scripted dialog answers, taken in order; an empty queue answers as a dismissed dialog. */
  const answers = { select: [] as (string | undefined)[], input: [] as (string | undefined)[], confirm: [] as boolean[] };
  const dialogs: { kind: 'select' | 'input' | 'confirm'; title: string; detail?: unknown }[] = [];
  let idle = true;
  const context = {
    cwd: root, mode, hasUI: mode === 'tui' || mode === 'rpc', sessionManager: { getSessionId: () => 'pi-session' },
    isIdle: () => idle,
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      select: async (title: string, options: string[]) => { dialogs.push({ kind: 'select', title, detail: options }); return answers.select.shift(); },
      input: async (title: string, placeholder?: string) => { dialogs.push({ kind: 'input', title, detail: placeholder }); return answers.input.shift(); },
      confirm: async (title: string, message: string) => { dialogs.push({ kind: 'confirm', title, detail: message }); return answers.confirm.shift() ?? false; },
    },
  } as unknown as ExtensionContext;
  const api = {
    registerTool: (tool: ToolDefinition<any, any>) => {
      tools.set(tool.name, tool);
      if ((tool as { defaultActive?: boolean }).defaultActive !== false) active.add(tool.name);
    },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    sendMessage: (...args: unknown[]) => messages.push(args),
    sendUserMessage: (content: unknown) => { userMessages.push(content); },
    getAllTools: () => registeredTools, getCommands: () => registeredCommands,
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active.clear();
      for (const name of names) if (tools.has(name)) active.add(name);
    },
  } as unknown as ExtensionAPI;
  const emit = async (event: string, data: unknown = {}) => {
    let last: unknown;
    for (const handler of handlers.get(event) ?? []) last = await handler(data, context);
    return last;
  };
  /**
   * Fires `before_agent_start` as pi does when a run is about to start: `messageType: 'user'` with the
   * prompt text for a typed prompt or `pi.sendUserMessage()`, or `'custom'` with the starting message.
   */
  const startRun = (start: { prompt: string } | { message: unknown }) =>
    emit('before_agent_start', {
      type: 'before_agent_start', systemPrompt: '', systemPromptOptions: { selectedTools: [...active] },
      ...('prompt' in start ? { messageType: 'user', prompt: start.prompt } : { messageType: 'custom', message: start.message }),
    });
  /** Runs a `/name` command as if the user typed it. */
  const command = (name: string, args: string) =>
    (commands.get(name) as { handler: (args: string, ctx: ExtensionContext) => Promise<void> }).handler(args, context);
  return {
    api, context, tools, commands, messages, userMessages, notifications, widgets, registeredTools, registeredCommands,
    answers, dialogs, emit, startRun, command,
    activeTools: () => [...active],
    setIdle: (value: boolean) => { idle = value; },
  };
}
