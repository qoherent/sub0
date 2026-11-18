import { chmodSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runCli } from '../../src/cli/cli.js';
import { INIT_TOOL_NAMES } from '../../src/pi-parent/init.js';
import { registerPiExtension } from '../../src/pi-parent/extension.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { fakePi } from './fake-pi-api.js';
import { FAKE_PI_COMMAND, GENERAL_MEDIUM_YAML, TIERED_YAML, fakePiEnv, makeProject, manualPort, piKernel, tempDir, useGeneralConfig } from '../helpers.js';

const agentFile = (root: string) => path.join(root, '.agents', 'subzero.yaml');
const GUIDE_LINE = 'Ask about `medium` first, because it is required.';
const SIX = ['subzero_init_show', 'subzero_init_models', 'subzero_init_ask', 'subzero_init_check', 'subzero_init_preview', 'subzero_init_apply'];

/** A pi session with subzero loaded, on a kernel whose pi is the scripted fake. */
async function session(root: string, mode: 'tui' | 'print' = 'tui', piCommand: string[] = FAKE_PI_COMMAND, extraHosts: string[] = []) {
  const child = fakePiEnv();
  const fake = fakePi(root, mode);
  const { kernel } = piKernel({ piCommand, env: child.env, piAgentDir: tempDir(), killWaitMs: 300, log: () => {} });
  for (const host of extraHosts) kernel.registerChildDriver(host, { port: manualPort().port });
  registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel, warn: () => {} }), () => {}, undefined, kernel);
  await fake.emit('session_start');
  const tool = (name: string, args: Record<string, unknown> = {}) =>
    fake.tools.get(name)!.execute('call', args, undefined, undefined, fake.context as any);
  const text = (reply: { content: { type: string; text?: string }[] }) => reply.content.map((c) => c.text ?? '').join('');
  const initActive = () => fake.activeTools().filter((name) => name.startsWith('subzero_init_'));
  const subagentText = () => fake.tools.get('subagent')!.prepareLoadout?.({} as any)?.descriptions?.subagent ?? '';
  return { fake, tool, text, initActive, subagentText };
}

describe('pi /subzero init', () => {
  it('registers six init tools that stay inactive until /subzero init turns them all on', async () => {
    const { fake, initActive } = await session(tempDir());
    expect([...INIT_TOOL_NAMES].sort()).toEqual([...SIX].sort());
    for (const name of SIX) expect(fake.tools.has(name)).toBe(true);
    expect(initActive()).toEqual([]);
    expect(fake.activeTools()).toContain('subagent');
    await fake.command('subzero', 'init');
    expect(initActive().sort()).toEqual([...SIX].sort());
    expect(fake.activeTools()).toContain('subagent');
    expect(fake.userMessages).toHaveLength(1);
    const kickoff = String(fake.userMessages[0]);
    expect(kickoff).toContain(GUIDE_LINE);
    for (const name of SIX) expect(kickoff).toContain(name);
    expect(kickoff).toMatch(/no new session/i);
  });

  it('refuses guided init without a UI, naming the quick path, and activates nothing', async () => {
    const { fake, initActive } = await session(tempDir(), 'print');
    const errors: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await fake.command('subzero', 'init');
    } finally {
      process.stderr.write = write;
    }
    expect([...fake.notifications, ...errors].join('\n')).toContain('/subzero init <model>');
    expect(initActive()).toEqual([]);
    expect(fake.userMessages).toEqual([]);
  });

  it('refuses guided init while the agent is running', async () => {
    const { fake, initActive } = await session(tempDir());
    fake.setIdle(false);
    await fake.command('subzero', 'init');
    expect(fake.notifications.join('\n')).toMatch(/agent/);
    expect(initActive()).toEqual([]);
    expect(fake.userMessages).toEqual([]);
  });

  it('quick path writes the starter entries, then reports them already there', async () => {
    const root = tempDir();
    const { fake, subagentText } = await session(root);
    await fake.command('subzero', 'init local/qwen --thinking low --timeout 60');
    expect(fake.notifications.at(-1)).toBe('added the medium tier, the general agent, the fallback agent');
    const yaml = readFileSync(agentFile(root), 'utf8');
    expect(yaml).toMatch(/model: local\/qwen/);
    expect(yaml).toMatch(/thinking: low/);
    expect(yaml).toMatch(/timeout: 60/);
    expect(yaml).toMatch(/^ {2}general:/m);
    expect(yaml).toMatch(/^ {2}fallback:/m);
    expect(subagentText()).toMatch(/mid-tier \(medium\): pass model: "medium"/);
    await fake.command('subzero', 'init local/qwen');
    expect(fake.notifications.at(-1)).toBe(
      'all three entries (the medium tier, the general agent and the fallback agent) are already there; nothing changed',
    );
    expect(fake.userMessages).toEqual([]);
  });

  it('quick path refuses cleanly when pi is missing and writes nothing', async () => {
    const root = tempDir();
    const { fake } = await session(root, 'tui', ['/nonexistent/pi-binary']);
    await fake.command('subzero', 'init local/qwen');
    expect(fake.notifications.at(-1)).toMatch(/pi was not found/);
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it('quick path rejects a bad thinking level with usage', async () => {
    const root = tempDir();
    const { fake } = await session(root);
    await fake.command('subzero', 'init local/qwen --thinking loud');
    expect(fake.notifications.at(-1)).toMatch(/--thinking must be one of/);
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it('quick path refuses when several child hosts are registered, naming them, and writes nothing', async () => {
    const root = tempDir();
    const { fake, subagentText } = await session(root, 'tui', FAKE_PI_COMMAND, ['other']);
    const before = subagentText();
    await fake.command('subzero', 'init local/qwen');
    expect(fake.notifications.at(-1)).toMatch(/supported hosts to choose from: pi, other/);
    expect(existsSync(agentFile(root))).toBe(false);
    expect(subagentText()).toBe(before);
  });

  it('ask shows a select with an Other entry that falls back to free text, or free text alone', async () => {
    const { fake, tool, text } = await session(tempDir());
    await fake.command('subzero', 'init');
    fake.answers.select.push('local/qwen');
    expect(text(await tool('subzero_init_ask', { question: 'Model for medium?', options: ['local/qwen', 'local/big'] }))).toContain('local/qwen');
    expect(fake.dialogs.at(-1)).toMatchObject({ kind: 'select', title: 'Model for medium?', detail: ['local/qwen', 'local/big', 'Other…'] });
    fake.answers.select.push('Other…');
    fake.answers.input.push('local/typed');
    expect(text(await tool('subzero_init_ask', { question: 'Model for small?', options: ['local/qwen'] }))).toContain('local/typed');
    expect(fake.dialogs.at(-1)).toMatchObject({ kind: 'input', title: 'Model for small?' });
    fake.answers.input.push('2');
    expect(text(await tool('subzero_init_ask', { question: 'Limit for local?' }))).toContain('2');
    expect(text(await tool('subzero_init_ask', { question: 'Limit for local?' }))).toMatch(/dismissed/);
  });

  it('show, models and preview return compact JSON without the full file text', async () => {
    const root = makeProject();
    const { fake, tool, text } = await session(root);
    await fake.command('subzero', 'init');
    const shown = JSON.parse(text(await tool('subzero_init_show')));
    expect(shown).toMatchObject({ ok: true, host: 'pi', state: { status: 'ok' } });
    const models = JSON.parse(text(await tool('subzero_init_models')));
    expect(models.ok).toBe(true);
    expect(Array.isArray(models.models)).toBe(true);
    const preview = JSON.parse(text(await tool('subzero_init_preview', { changes: [{ op: 'setTier', tier: 'small', model: 'local/q', thinking: 'high' }] })));
    expect(preview).toMatchObject({ ok: true, nothingToChange: false });
    expect(preview.text).toBeUndefined();
    expect(preview.diff).toMatch(/local\/q/);
    expect(preview.fingerprint).toMatch(/\S/);
  });

  it('apply with confirm answered no writes nothing and turns the tools off', async () => {
    const root = tempDir();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }];
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    fake.answers.confirm.push(false);
    const reply = await tool('subzero_init_apply', { changes, fingerprint });
    expect(text(reply)).toMatch(/nothing was written/);
    expect(fake.dialogs.at(-1)).toMatchObject({ kind: 'confirm', detail: expect.stringContaining('local/q') });
    expect(existsSync(agentFile(root))).toBe(false);
    expect(initActive()).toEqual([]);
  });

  it('apply with confirm answered yes writes, turns the tools off and lists medium as configured', async () => {
    const root = tempDir();
    const { fake, tool, text, initActive, subagentText } = await session(root);
    expect(subagentText()).not.toMatch(/pass model: "medium"/);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }, { op: 'setLimit', endpoint: 'local', parallel: 1 }];
    const { fingerprint, diff } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    fake.answers.confirm.push(true);
    const reply = await tool('subzero_init_apply', { changes, fingerprint });
    expect(reply.isError).toBeFalsy();
    expect(JSON.parse(text(reply))).toMatchObject({ ok: true, written: true });
    const confirm = fake.dialogs.find((d) => d.kind === 'confirm')!;
    expect(confirm.detail).toContain(diff.trim().split('\n').at(-1));
    expect(readFileSync(agentFile(root), 'utf8')).toMatch(/model: local\/q/);
    expect(initActive()).toEqual([]);
    expect(subagentText()).toMatch(/mid-tier \(medium\): pass model: "medium"/);
  });

  it('apply refuses a stale fingerprint without asking and keeps the tools on', async () => {
    const root = tempDir();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }];
    const reply = await tool('subzero_init_apply', { changes, fingerprint: 'stale' });
    expect(reply.isError).toBe(true);
    expect(text(reply)).toMatch(/preview again/i);
    expect(fake.dialogs.filter((d) => d.kind === 'confirm')).toEqual([]);
    expect(existsSync(agentFile(root))).toBe(false);
    expect(initActive()).toHaveLength(6);
  });

  /** The init is over: the tools are off, the next call is refused, and the agent file is as it was. */
  async function expectEnded(
    fake: Awaited<ReturnType<typeof session>>['fake'],
    tool: Awaited<ReturnType<typeof session>>['tool'],
    text: Awaited<ReturnType<typeof session>>['text'],
    initActive: () => string[],
    root: string,
    before: string,
  ) {
    expect(initActive()).toEqual([]);
    expect(readFileSync(agentFile(root), 'utf8')).toBe(before);
    const later = await tool('subzero_init_show');
    expect(later.isError).toBe(true);
    expect(text(later)).toMatch(/not running/);
    expect(fake.dialogs.filter((d) => d.kind === 'confirm')).toEqual([]);
  }

  it('apply with a refused change returns the refusal, writes nothing and ends the init', async () => {
    const root = makeProject(TIERED_YAML);
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const before = readFileSync(agentFile(root), 'utf8');
    const changes = [{ op: 'unsetTier', tier: 'large' }];
    const preview = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    expect(preview.refusals).toHaveLength(1);
    const reply = await tool('subzero_init_apply', { changes, fingerprint: preview.fingerprint });
    expect(reply.isError).toBe(true);
    expect(JSON.parse(text(reply))).toMatchObject({ ok: false, code: 'refused_change', note: expect.stringMatching(/init tools are now off/i) });
    expect(text(reply)).toContain('reviewer');
    await expectEnded(fake, tool, text, initActive, root, before);
  });

  it('apply when the agent file no longer loads returns the load error and ends the init', async () => {
    const root = makeProject();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setLimit', endpoint: 'local', parallel: 2 }];
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    writeFileSync(agentFile(root), 'models: [unclosed\n');
    const reply = await tool('subzero_init_apply', { changes, fingerprint });
    expect(reply.isError).toBe(true);
    expect(JSON.parse(text(reply))).toMatchObject({ ok: false, code: 'load_error' });
    await expectEnded(fake, tool, text, initActive, root, 'models: [unclosed\n');
  });

  it.skipIf(process.getuid?.() === 0)('apply whose write the file system refuses returns the write error and ends the init', async () => {
    const root = makeProject();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const before = readFileSync(agentFile(root), 'utf8');
    const changes = [{ op: 'setLimit', endpoint: 'local', parallel: 2 }];
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    fake.answers.confirm.push(true);
    const dir = path.join(root, '.agents');
    chmodSync(dir, 0o500);
    try {
      const reply = await tool('subzero_init_apply', { changes, fingerprint });
      expect(reply.isError).toBe(true);
      expect(JSON.parse(text(reply))).toMatchObject({ ok: false, code: 'write_failed', note: expect.stringMatching(/init tools are now off/i) });
      expect(fake.dialogs.filter((d) => d.kind === 'confirm')).toHaveLength(1);
      expect(initActive()).toEqual([]);
      expect(readFileSync(agentFile(root), 'utf8')).toBe(before);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('apply refuses with the stale preview error when the file changes while the dialog is open, and keeps the tools on', async () => {
    const root = makeProject();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setLimit', endpoint: 'local', parallel: 2 }];
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    const edited = `${readFileSync(agentFile(root), 'utf8')}# edited while the dialog was open\n`;
    (fake.context as any).ui.confirm = async () => {
      writeFileSync(agentFile(root), edited);
      return true;
    };
    const reply = await tool('subzero_init_apply', { changes, fingerprint });
    expect(reply.isError).toBe(true);
    expect(JSON.parse(text(reply))).toMatchObject({ ok: false, code: 'stale_preview' });
    expect(readFileSync(agentFile(root), 'utf8')).toBe(edited);
    expect(initActive()).toHaveLength(6);
  });

  it('tells the agent in the kickoff that a stale preview means preview again and any other refusal ends the init', async () => {
    const { fake } = await session(tempDir());
    await fake.command('subzero', 'init');
    const kickoff = String(fake.userMessages[0]);
    expect(kickoff).toMatch(/stale preview error[^.]*preview again/i);
    expect(kickoff).toMatch(/any other refusal[^.]*write error[^.]*load error[^.]*end/i);
  });

  /** Points the general file at a path in a fresh temp folder, where no file exists yet. */
  function freshGeneralPath(): string {
    const file = path.join(tempDir('subzero-general-'), 'subzero.yaml');
    const previous = process.env.SUBZERO_GENERAL_CONFIG;
    process.env.SUBZERO_GENERAL_CONFIG = file;
    onTestFinished(() => {
      if (previous === undefined) delete process.env.SUBZERO_GENERAL_CONFIG;
      else process.env.SUBZERO_GENERAL_CONFIG = previous;
    });
    return file;
  }

  it('F1: an every-project answer previews and applies against the general file, then the tools switch off', async () => {
    const general = freshGeneralPath();
    const root = tempDir();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }];
    const preview = JSON.parse(text(await tool('subzero_init_preview', { changes, scope: 'general' })));
    expect(preview).toMatchObject({ ok: true, scope: 'general', agentFile: general, fileExists: false, overridden: { tiers: [], limits: [] } });
    fake.answers.confirm.push(true);
    const reply = await tool('subzero_init_apply', { changes, fingerprint: preview.fingerprint, scope: 'general' });
    expect(reply.isError).toBeFalsy();
    expect(JSON.parse(text(reply))).toMatchObject({ ok: true, written: true, scope: 'general' });
    expect(readFileSync(general, 'utf8')).toMatch(/model: local\/q/);
    expect(existsSync(agentFile(root))).toBe(false);
    expect(fake.dialogs.find((d) => d.kind === 'confirm')!.title).toContain('general');
    expect(initActive()).toEqual([]);
  });

  it('F2: a this-project answer previews a project write that adds only the changed tier', async () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = tempDir();
    const { fake, tool, text } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/project-q', thinking: 'high' }];
    const preview = JSON.parse(text(await tool('subzero_init_preview', { changes, scope: 'project' })));
    expect(preview).toMatchObject({ ok: true, scope: 'project', agentFile: agentFile(root) });
    expect(preview.diff).toMatch(/local\/project-q/);
    expect(preview.diff).not.toMatch(/agents:|general:|fallback:/);
    fake.answers.confirm.push(true);
    expect((await tool('subzero_init_apply', { changes, fingerprint: preview.fingerprint, scope: 'project' })).isError).toBeFalsy();
    const written = readFileSync(agentFile(root), 'utf8');
    expect(written).toMatch(/model: local\/project-q/);
    expect(written).not.toMatch(/agents:/);
  });

  it('AE6: the general-scope preview returns what this project overrides, and the kickoff tells the model to say it', async () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = makeProject();
    const { fake, tool, text } = await session(root);
    await fake.command('subzero', 'init');
    const preview = JSON.parse(text(await tool('subzero_init_preview', {
      changes: [{ op: 'setTier', tier: 'medium', model: 'local/everywhere', thinking: 'low' }],
      scope: 'general',
    })));
    expect(preview.overridden.tiers).toEqual(['medium']);
    const kickoff = String(fake.userMessages[0]);
    expect(kickoff).toMatch(/every project or only this one/i);
    expect(kickoff).toMatch(/overridden[^.]*this project keeps its own/i);
    expect(kickoff).toMatch(/subzero_init_preview[^.]*`scope`/);
    expect(kickoff).toMatch(/subzero_init_apply[^.]*`scope`/);
  });

  it('apply with a scope different from the preview\'s is a stale preview: nothing is written and the tools stay on', async () => {
    const general = freshGeneralPath();
    const root = tempDir();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }];
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes, scope: 'general' })));
    const reply = await tool('subzero_init_apply', { changes, fingerprint });
    expect(reply.isError).toBe(true);
    expect(JSON.parse(text(reply))).toMatchObject({ ok: false, code: 'stale_preview' });
    expect(fake.dialogs.filter((d) => d.kind === 'confirm')).toEqual([]);
    expect(existsSync(general)).toBe(false);
    expect(existsSync(agentFile(root))).toBe(false);
    expect(initActive()).toHaveLength(6);
  });

  it('refuses an init tool call before /subzero init', async () => {
    const root = tempDir();
    const { tool, text } = await session(root);
    const reply = await tool('subzero_init_show');
    expect(reply.isError).toBe(true);
    expect(text(reply)).toContain('guided init is not running');
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it('refuses preview and apply after a confirmed apply and writes nothing more', async () => {
    const root = tempDir();
    const { fake, tool, text } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }];
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    fake.answers.confirm.push(true);
    expect((await tool('subzero_init_apply', { changes, fingerprint })).isError).toBeFalsy();
    const written = readFileSync(agentFile(root));
    const again = [{ op: 'setTier', tier: 'small', model: 'local/other', thinking: 'low' }];
    const preview = await tool('subzero_init_preview', { changes: again });
    expect(preview.isError).toBe(true);
    expect(text(preview)).toContain('guided init is not running');
    fake.answers.confirm.push(true);
    const apply = await tool('subzero_init_apply', { changes: again, fingerprint });
    expect(apply.isError).toBe(true);
    expect(text(apply)).toContain('guided init is not running');
    expect(fake.dialogs.filter((d) => d.kind === 'confirm')).toHaveLength(1);
    expect(readFileSync(agentFile(root)).equals(written)).toBe(true);
  });

  it('refuses preview and apply after a declined apply and writes nothing', async () => {
    const root = tempDir();
    const { fake, tool, text } = await session(root);
    await fake.command('subzero', 'init');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }];
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    fake.answers.confirm.push(false);
    expect(text(await tool('subzero_init_apply', { changes, fingerprint }))).toMatch(/declined/);
    const preview = await tool('subzero_init_preview', { changes });
    expect(preview.isError).toBe(true);
    expect(text(preview)).toContain('guided init is not running');
    fake.answers.confirm.push(true);
    const apply = await tool('subzero_init_apply', { changes, fingerprint });
    expect(apply.isError).toBe(true);
    expect(text(apply)).toContain('guided init is not running');
    expect(fake.dialogs.filter((d) => d.kind === 'confirm')).toHaveLength(1);
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it('keeps the tools on for the run the kickoff starts', async () => {
    const root = makeProject();
    const { fake, tool, initActive } = await session(root);
    await fake.command('subzero', 'init');
    await fake.startRun({ prompt: String(fake.userMessages[0]) });
    expect(initActive()).toHaveLength(6);
    expect((await tool('subzero_init_show')).isError).toBeFalsy();
  });

  it('turns the tools off when a run other than the kickoff starts, as after a kickoff that never ran', async () => {
    const root = tempDir();
    const { fake, tool, text, initActive } = await session(root);
    await fake.command('subzero', 'init');
    expect(initActive()).toHaveLength(6);
    // The kickoff failed before its run started (no model, no API key), so no agent_settled follows.
    await fake.startRun({ prompt: 'fix the failing test in src/foo.ts' });
    expect(initActive()).toEqual([]);
    const shown = await tool('subzero_init_show');
    expect(shown.isError).toBe(true);
    expect(text(shown)).toContain('guided init is not running');
    const changes = [{ op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' }];
    const preview = await tool('subzero_init_preview', { changes });
    expect(preview.isError).toBe(true);
    expect(text(preview)).toContain('guided init is not running');
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it('turns the tools off when a custom message starts the next run instead of the kickoff', async () => {
    const { fake, tool, initActive } = await session(tempDir());
    await fake.command('subzero', 'init');
    await fake.startRun({ message: { role: 'custom', customType: 'other', content: 'hi', display: true } });
    expect(initActive()).toEqual([]);
    expect((await tool('subzero_init_show')).isError).toBe(true);
  });

  it('turns the tools off when the kickoff prompt starts a run after another run already used up the start', async () => {
    const { fake, tool, initActive } = await session(tempDir());
    await fake.command('subzero', 'init');
    const kickoff = String(fake.userMessages[0]);
    await fake.startRun({ prompt: 'something else' });
    await fake.startRun({ prompt: kickoff });
    expect(initActive()).toEqual([]);
    expect((await tool('subzero_init_show')).isError).toBe(true);
  });

  it('ending the agent run turns the tools off', async () => {
    const { fake, initActive } = await session(tempDir());
    await fake.command('subzero', 'init');
    expect(initActive()).toHaveLength(6);
    await fake.emit('agent_settled', { aborted: false });
    expect(initActive()).toEqual([]);
  });

  it('session shutdown turns the tools off', async () => {
    const { fake, initActive } = await session(tempDir());
    await fake.command('subzero', 'init');
    expect(initActive()).toHaveLength(6);
    await fake.emit('session_shutdown', { reason: 'quit' });
    expect(initActive()).toEqual([]);
  });

  it('a change set applied through the CLI and through the pi apply tool writes byte-identical files', async () => {
    const original = makeProject();
    const viaCli = tempDir('subzero-parity-cli-');
    const viaPi = tempDir('subzero-parity-pi-');
    cpSync(original, viaCli, { recursive: true });
    cpSync(original, viaPi, { recursive: true });

    const flags = ['--tier', 'small=local/qwen-tiny:low', '--tier', 'large=cloud/big:high', '--tier', 'medium=local/qwen2:medium', '--limit', 'local=2'];
    const changes = [
      { op: 'setTier', tier: 'small', model: 'local/qwen-tiny', thinking: 'low' },
      { op: 'setTier', tier: 'large', model: 'cloud/big', thinking: 'high' },
      { op: 'setTier', tier: 'medium', model: 'local/qwen2', thinking: 'medium' },
      { op: 'setLimit', endpoint: 'local', parallel: 2 },
    ];

    const out: string[] = [];
    const { kernel } = piKernel({ piCommand: FAKE_PI_COMMAND, env: fakePiEnv().env, piAgentDir: tempDir(), log: () => {} });
    const cli = (...argv: string[]) => {
      out.length = 0;
      return runCli(argv, { out: (t) => out.push(t), err: () => {} }, { env: { SUBZERO_PROJECT_DIR: viaCli }, warn: () => {}, interactive: false, kernel });
    };
    expect(await cli('config', 'preview', ...flags)).toBe(0);
    const { fingerprint: cliFingerprint } = JSON.parse(out[0]!);
    expect(await cli('config', 'apply', '--expect', cliFingerprint, ...flags)).toBe(0);

    const { fake, tool, text } = await session(viaPi);
    await fake.command('subzero', 'init');
    const { fingerprint } = JSON.parse(text(await tool('subzero_init_preview', { changes })));
    expect(fingerprint).toBe(cliFingerprint);
    fake.answers.confirm.push(true);
    expect((await tool('subzero_init_apply', { changes, fingerprint })).isError).toBeFalsy();

    const cliText = readFileSync(agentFile(viaCli));
    expect(cliText.equals(readFileSync(agentFile(original)))).toBe(false);
    expect(readFileSync(agentFile(viaPi)).equals(cliText)).toBe(true);
  });
});
