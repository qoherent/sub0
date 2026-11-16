import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/cli.js';
import { INIT_TOOL_NAMES } from '../../src/pi-parent/init.js';
import { registerPiExtension } from '../../src/pi-parent/extension.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { fakePi } from './fake-pi-api.js';
import { FAKE_PI_COMMAND, fakePiEnv, makeProject, piKernel, tempDir } from '../helpers.js';

const agentFile = (root: string) => path.join(root, '.agents', 'subzero.yaml');
const GUIDE_LINE = 'Ask about `medium` first, because it is required.';
const SIX = ['subzero_init_show', 'subzero_init_models', 'subzero_init_ask', 'subzero_init_check', 'subzero_init_preview', 'subzero_init_apply'];

/** A pi session with subzero loaded, on a kernel whose pi is the scripted fake. */
async function session(root: string, mode: 'tui' | 'print' = 'tui', piCommand: string[] = FAKE_PI_COMMAND) {
  const child = fakePiEnv();
  const fake = fakePi(root, mode);
  const { kernel } = piKernel({ piCommand, env: child.env, piAgentDir: tempDir(), killWaitMs: 300, log: () => {} });
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
