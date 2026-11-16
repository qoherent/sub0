// @sigil implements design/pi-extension.sigil PiExtension (guided init)
//
// pi's `/subzero init`: with a model it is the quick path that writes the starter
// entries, as `subzero init <model>` does; with none it turns on six init tools for
// one agent run and hands the agent the shared guide text. The tools are thin
// wrappers over the setup service. Only the apply tool writes, and only after the
// user confirms subzero's own diff in pi's dialog. The tools are off by default and
// switch off again after a write, a declined confirmation, the end of the run or the
// end of the session, so an agent can never reach them outside a user-started run.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseArgs } from 'node:util';
import { Type } from 'typebox';
import { addStarterEntries, LoadError, StarterHostConflictError, type ThinkingLevel } from '../config/agent-config.js';
import { SetupConflictError, SetupRefusedError, type Change } from '../config/agent-setup.js';
import type { Kernel } from '../kernel/kernel.js';
import { isSetupError, parseStarterOptions, SetupService, SetupServiceError, setupRefusalBody } from '../service/setup-service.js';
import { formatStarterResult } from '../service/status-text.js';
import GUIDE from '../../skills/init/guided-init.md?raw';

export const INIT_TOOL_NAMES = [
  'subzero_init_show',
  'subzero_init_models',
  'subzero_init_ask',
  'subzero_init_check',
  'subzero_init_preview',
  'subzero_init_apply',
] as const;

const OTHER = 'Other…';
/** The syntax of `/subzero init`, shared with the `/subzero` usage line. */
export const INIT_SYNTAX = 'init [<model> [--thinking <level>] [--timeout <seconds>]]';
const QUICK_USAGE = `Usage: /subzero ${INIT_SYNTAX}`;

/** How each guide step maps to a pi tool, appended to the guide in the kickoff message. */
const PI_MAPPING = `## In pi

The init tools are on only for this run, and they switch off when the run ends. Map the steps to these tools:

- **show**: \`subzero_init_show\`.
- **models**: \`subzero_init_models\`.
- **ask**: \`subzero_init_ask\` with \`question\` and, for a choice, \`options\`. It shows a pick list with an "${OTHER}" entry for a typed answer, or a text box when there are no options, and returns the user's answer.
- **check**: \`subzero_init_check\` with \`models\`, a list of \`{ model, thinking }\`.
- **preview**: \`subzero_init_preview\` with \`changes\`, a list of \`{ op: "setTier", tier, model, thinking }\`, \`{ op: "unsetTier", tier }\`, \`{ op: "setLimit", endpoint, parallel }\` and \`{ op: "clearLimit", endpoint }\`.
- **apply**: \`subzero_init_apply\` with the preview's \`fingerprint\` and the same \`changes\`. It shows subzero's diff and summary to the user and asks for confirmation itself, so in step 7 show the preview, then call apply instead of asking "Write this?" with ask. If the user declines, nothing is written and the init tools switch off; tell the user to run \`/subzero init\` again to change something.

In step 8: pi refreshes the \`subagent\` tool's tier text right after the write, so no new session is needed.`;

/** The user message `/subzero init` sends: the shared guide followed by the pi mapping. */
const INIT_KICKOFF = `Run subzero's guided init for this project, following this guide.\n\n${GUIDE.trim()}\n\n${PI_MAPPING}\n`;

export interface PiInitOptions {
  kernel: Kernel;
  /** The project root the session's delegation service resolved. */
  projectRoot: () => Promise<string>;
  /** Rebuilds the `subagent` tool's tier text from the agent file. */
  refreshTierText: () => void;
}

export interface PiInit {
  /** Runs `/subzero init` with the words after `init`. */
  command(args: string[], ctx: ExtensionContext): Promise<void>;
}

const say = (ctx: ExtensionContext, text: string, type?: 'info' | 'warning' | 'error') => {
  if (ctx.hasUI) ctx.ui.notify(text, type);
  else process.stderr.write(`subzero: ${text}\n`);
};

const reply = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

/** A refused setup call as the CLI's `config` commands print it: code, one-line reason and any refusals. */
function refusal(err: unknown) {
  const error = err instanceof Error ? err : new Error(String(err));
  return reply(setupRefusalBody(error), true);
}

const known = (err: unknown) => isSetupError(err) || err instanceof LoadError || err instanceof StarterHostConflictError;

/** The host the starter entries are written for, chosen as `subzero init` chooses it. */
function starterHost(kernel: Kernel): string {
  const supported = kernel.supportedHosts();
  if (supported.length === 0) throw new SetupServiceError('no_host', 'no host is registered, so init has no host to write the starter entries for');
  if (supported.length === 1) return supported[0]!;
  if (supported.includes('pi')) return 'pi';
  throw new SetupServiceError('host_needed', `init has these supported hosts to choose from: ${supported.join(', ')}`);
}

export function registerPiInit(pi: ExtensionAPI, options: PiInitOptions): PiInit {
  let setup: SetupService | undefined;
  const names = new Set<string>(INIT_TOOL_NAMES);
  const isOn = () => pi.getActiveTools().some((name) => names.has(name));
  const turnOn = () => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...INIT_TOOL_NAMES])]);
  const turnOff = () => {
    setup = undefined;
    if (isOn()) pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)));
  };
  const service = () => {
    if (!setup) throw new SetupServiceError('no_host', 'guided init is not running; the user starts it with /subzero init');
    return setup;
  };
  const run = async (fn: () => Promise<unknown> | unknown) => {
    try { return reply(await fn()); }
    catch (err) {
      if (known(err)) return refusal(err);
      return reply((err as Error).message ?? String(err), true);
    }
  };

  pi.on('session_start', () => turnOff());
  pi.on('agent_settled', () => turnOff());
  pi.on('session_shutdown', () => turnOff());

  const changeSchema = Type.Object({
    op: Type.String({ description: 'setTier, unsetTier, setLimit or clearLimit' }),
    tier: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    endpoint: Type.Optional(Type.String()),
    parallel: Type.Optional(Type.Number()),
  });
  // Registered inactive: only `/subzero init`, which only the user can run, turns them on.
  const tool = { defaultActive: false } as const;

  pi.registerTool({
    ...tool, name: 'subzero_init_show', label: 'subzero init: show',
    description: "Guided subzero init: the agent file's current tiers, limits and status, and the large-tier warning.",
    parameters: Type.Object({}),
    execute: () => run(async () => ({ ok: true, ...(await service().show()) })),
  });
  pi.registerTool({
    ...tool, name: 'subzero_init_models', label: 'subzero init: models',
    description: 'Guided subzero init: the models a subzero child can use, with endpoint, thinking levels, context window and cost.',
    parameters: Type.Object({}),
    execute: () => run(async () => ({ ok: true, ...(await service().models()) })),
  });
  pi.registerTool({
    ...tool, name: 'subzero_init_ask', label: 'subzero init: ask',
    description: `Guided subzero init: ask the user one question. With options it shows a pick list plus "${OTHER}" for a typed answer; without, a text box. Returns the answer.`,
    parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, args, _signal, _update, ctx) {
      return run(async () => {
        service();
        if (!ctx.hasUI) throw new Error('asking needs pi\'s interactive UI');
        let answer: string | undefined;
        if (args.options?.length) {
          answer = await ctx.ui.select(args.question, [...args.options, OTHER]);
          if (answer === OTHER) answer = await ctx.ui.input(args.question);
        } else {
          answer = await ctx.ui.input(args.question);
        }
        return answer === undefined ? 'no answer: the user dismissed the question' : `answer: ${answer}`;
      });
    },
  });
  pi.registerTool({
    ...tool, name: 'subzero_init_check', label: 'subzero init: check',
    description: 'Guided subzero init: send each model a one-turn prompt, one after another, and report whether it answered.',
    parameters: Type.Object({ models: Type.Array(Type.Object({ model: Type.String(), thinking: Type.String() })) }),
    async execute(_id, args, signal) {
      return run(async () => ({
        ok: true,
        ...(await service().check(args.models.map((m) => ({ model: m.model, thinking: m.thinking as ThinkingLevel })), signal)),
      }));
    },
  });
  pi.registerTool({
    ...tool, name: 'subzero_init_preview', label: 'subzero init: preview',
    description: 'Guided subzero init: the diff and summary a change set would write, and the fingerprint apply needs. Writes nothing.',
    parameters: Type.Object({ changes: Type.Array(changeSchema) }),
    async execute(_id, args) {
      return run(() => {
        const { text: _text, ...preview } = service().preview(args.changes as Change[]);
        return { ok: true, ...preview };
      });
    },
  });
  pi.registerTool({
    ...tool, name: 'subzero_init_apply', label: 'subzero init: apply',
    description: "Guided subzero init: show the previewed diff to the user, and write it only when the user confirms. Pass the preview's fingerprint and the same changes.",
    parameters: Type.Object({ changes: Type.Array(changeSchema), fingerprint: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      return run(async () => {
        const svc = service();
        if (!ctx.hasUI) throw new Error('apply needs pi\'s interactive UI to confirm the write; nothing was written');
        const changes = args.changes as Change[];
        const preview = svc.preview(changes);
        if (preview.fingerprint !== args.fingerprint) throw new SetupConflictError();
        if (preview.refusals.length) throw new SetupRefusedError(preview.refusals);
        if (preview.invalid !== undefined) throw new Error(`nothing was written: the result would not load: ${preview.invalid}`);
        if (preview.nothingToChange) return { ok: true, written: false, message: 'nothing to change; nothing was written' };
        const confirmed = await ctx.ui.confirm(
          'Write .agents/subzero.yaml?',
          [preview.diff.trimEnd(), '', ...preview.summary].join('\n'),
        );
        if (!confirmed) {
          turnOff();
          return 'the user declined; nothing was written. The init tools are now off; the user can run /subzero init again.';
        }
        const { text: _text, diff: _diff, ...applied } = svc.apply(changes, args.fingerprint);
        options.refreshTierText();
        turnOff();
        return { ok: true, ...applied, note: 'pi refreshed the subagent tier text; no new session is needed. The init tools are now off.' };
      });
    },
  });

  const quick = async (args: string[], ctx: ExtensionContext) => {
    let parsed;
    try {
      parsed = parseArgs({ args, options: { thinking: { type: 'string' }, timeout: { type: 'string' } }, allowPositionals: true, strict: true });
    } catch {
      say(ctx, QUICK_USAGE);
      return;
    }
    const [model, ...extra] = parsed.positionals;
    if (model === undefined || extra.length) { say(ctx, QUICK_USAGE); return; }
    const starter = parseStarterOptions(parsed.values);
    if ('error' in starter) { say(ctx, starter.error, 'error'); return; }
    const { thinking, timeout } = starter;
    try {
      const host = starterHost(options.kernel);
      // A missing prerequisite stops init before anything is written.
      const problem = options.kernel.prerequisites(host)?.();
      if (problem !== undefined) { say(ctx, problem, 'error'); return; }
      const tools = options.kernel.starterTools(host);
      if (tools === undefined) {
        say(ctx, `the child driver of the host "${host}" offers no starter tools, so init cannot write the agent entries`, 'error');
        return;
      }
      const result = addStarterEntries(await options.projectRoot(), {
        host, model, thinking, timeout, generalTools: tools.general, fallbackTools: tools.fallback,
      });
      if (result.added.length > 0) options.refreshTierText();
      say(ctx, formatStarterResult(result).join('\n'));
    } catch (err) {
      say(ctx, (err as Error).message, 'error');
    }
  };

  const guided = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      say(ctx, 'guided init needs pi\'s interactive UI; run /subzero init <model> to write the starter entries instead');
      return;
    }
    if (!ctx.isIdle()) {
      say(ctx, 'wait for the agent to finish, then run /subzero init again', 'warning');
      return;
    }
    try {
      setup = new SetupService({ kernel: options.kernel, projectRoot: await options.projectRoot() });
    } catch (err) {
      say(ctx, (err as Error).message, 'error');
      return;
    }
    turnOn();
    try {
      pi.sendUserMessage(INIT_KICKOFF);
    } catch (err) {
      turnOff();
      say(ctx, `guided init did not start: ${(err as Error).message}`, 'error');
    }
  };

  return {
    async command(args, ctx) {
      if (args.length === 0) await guided(ctx);
      else await quick(args, ctx);
    },
  };
}
