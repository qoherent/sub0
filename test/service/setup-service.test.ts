import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupConflictError } from '../../src/config/agent-setup.js';
import { LARGE_TIER_WARNING } from '../../src/config/tier-words.js';
import type { ChildDriver, ModelCheckRequest, ModelCheckResult } from '../../src/core/types.js';
import { Kernel } from '../../src/kernel/kernel.js';
import { PI_HOST } from '../../src/pi/driver.js';
import { SetupService, SetupServiceError } from '../../src/service/setup-service.js';
import { DEFAULT_YAML, FAKE_PI_COMMAND, GLOBAL_MEDIUM_YAML, TIERED_YAML, fakePiEnv, makeProject, manualPort, piKernel, tempDir, useGlobalConfig } from '../helpers.js';

const piModel = (provider: string, id: string) => ({
  id,
  name: id,
  api: 'openai-completions',
  provider,
  baseUrl: 'http://localhost:8080/v1',
  reasoning: true,
  input: ['text'],
  contextWindow: 131072,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

function fakePiService(projectRoot: string, scenario: Record<string, unknown> = {}) {
  const fake = fakePiEnv(scenario);
  const { kernel } = piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, killWaitMs: 300, log: () => {} });
  return { fake, service: new SetupService({ kernel, projectRoot }) };
}

/** A kernel whose one host runs a hand-written driver. */
function kernelWith(driver: Partial<ChildDriver>, host = PI_HOST): Kernel {
  const kernel = new Kernel();
  kernel.registerChildDriver(host, { port: manualPort().port, ...driver });
  return kernel;
}

const STARTER = () => ({ general: ['read', 'bash'], fallback: ['read'] });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('SetupService host choice', () => {
  it('uses the single registered host', () => {
    expect(new SetupService({ kernel: kernelWith({}), projectRoot: tempDir() }).host).toBe(PI_HOST);
  });

  it('refuses a host with no driver and names the supported hosts', async () => {
    const service = new SetupService({ kernel: kernelWith({}), projectRoot: tempDir(), host: 'claude' });
    await expect(service.models()).rejects.toMatchObject({ code: 'unsupported_host', message: expect.stringContaining('supported hosts: pi') });
    expect(() => service.host).toThrow(SetupServiceError);
  });

  it('needs a named host when more than one is registered', () => {
    const kernel = kernelWith({});
    kernel.registerChildDriver('other', { port: manualPort().port });
    const service = new SetupService({ kernel, projectRoot: tempDir() });
    expect(() => service.host).toThrow(expect.objectContaining({ code: 'host_needed', message: expect.stringContaining('pi, other') }));
    expect(new SetupService({ kernel, projectRoot: tempDir(), host: 'other' }).host).toBe('other');
  });

  it('refuses when no host is registered', () => {
    const service = new SetupService({ kernel: new Kernel(), projectRoot: tempDir() });
    expect(() => service.host).toThrow(expect.objectContaining({ code: 'no_host' }));
  });
});

describe('SetupService.models', () => {
  it('returns the prerequisites message and never runs the listing', async () => {
    const listModels = vi.fn(async () => []);
    const service = new SetupService({
      kernel: kernelWith({ prerequisites: () => 'pi was not found (pi). To continue, install pi and run `subzero init` again.', listModels }),
      projectRoot: tempDir(),
    });
    await expect(service.models()).rejects.toMatchObject({ code: 'prerequisites_missing', message: expect.stringMatching(/^pi was not found/) });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('reports a missing pi through the pi driver', async () => {
    const { kernel } = piKernel({ piCommand: [path.join(tempDir(), 'no-such-pi')] });
    const service = new SetupService({ kernel, projectRoot: tempDir() });
    await expect(service.models()).rejects.toMatchObject({ code: 'prerequisites_missing', message: expect.stringMatching(/pi was not found/) });
  });

  it('lists the models of the host, run in the project root', async () => {
    const root = makeProject();
    const { fake, service } = fakePiService(root, { models: [piModel('local', 'qwen'), piModel('cloud', 'model')] });
    const result = await service.models();
    expect(result.host).toBe('pi');
    expect(result.models.map((m) => m.name)).toEqual(['local/qwen', 'cloud/model']);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(fake.log()[0].cwd).toBe(root);
  });

  it('refuses a driver that cannot list its models', async () => {
    const service = new SetupService({ kernel: kernelWith({}), projectRoot: tempDir() });
    await expect(service.models()).rejects.toMatchObject({ code: 'no_model_listing', message: expect.stringContaining('"pi"') });
  });

  it('passes the listing failure on as one line', async () => {
    const { service } = fakePiService(makeProject(), { refuseModels: 'no catalog' });
    await expect(service.models()).rejects.toMatchObject({ code: 'listing_failed', message: expect.stringContaining('no catalog') });
  });
});

describe('SetupService pi extensions', () => {
  const extension = () => {
    const file = path.join(tempDir(), 'ext.ts');
    writeFileSync(file, '');
    return file;
  };

  it('lists models with the extensions of the merged config for the project root, none when no file names one', async () => {
    const seen: unknown[] = [];
    const listModels = async (options?: unknown) => (seen.push(options), []);
    const root = tempDir();
    await new SetupService({ kernel: kernelWith({ listModels }), projectRoot: root }).models();
    expect(seen[0]).toMatchObject({ projectRoot: root });
    expect((seen[0] as any).piExtensions ?? []).toEqual([]);
    const ext = extension();
    useGlobalConfig(`pi:\n  extensions:\n    - ${ext}\n`);
    await new SetupService({ kernel: kernelWith({ listModels }), projectRoot: root }).models();
    expect(seen[1]).toEqual({ projectRoot: root, piExtensions: [ext] });
  });

  it('checks each model with the same extensions', async () => {
    const seen: ModelCheckRequest[] = [];
    const checkModel = async (request: ModelCheckRequest): Promise<ModelCheckResult> => (seen.push(request), { ok: true });
    const ext = extension();
    useGlobalConfig(`pi:\n  extensions:\n    - ${ext}\n`);
    const root = tempDir();
    await new SetupService({ kernel: kernelWith({ checkModel }), projectRoot: root }).check([
      { model: 'a/one', thinking: 'high' },
      { model: 'b/two', thinking: 'low' },
    ]);
    expect(seen.map((r) => r.piExtensions)).toEqual([[ext], [ext]]);
  });

  it('refuses in one line, without calling the driver, when the global file names a missing extension or the project names pi', async () => {
    const listModels = vi.fn(async () => []);
    const checkModel = vi.fn(async (): Promise<ModelCheckResult> => ({ ok: true }));
    const gone = path.join(tempDir(), 'gone.ts');
    const file = useGlobalConfig(`pi:\n  extensions:\n    - ${gone}\n`);
    const service = new SetupService({ kernel: kernelWith({ listModels, checkModel }), projectRoot: tempDir() });
    await expect(service.models()).rejects.toMatchObject({ code: 'invalid_config', message: expect.stringContaining(file) });
    await expect(service.check([{ model: 'a/one', thinking: 'high' }])).rejects.toMatchObject({ code: 'invalid_config', message: expect.stringContaining(gone) });
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject('pi:\n  extensions: []\n' + DEFAULT_YAML);
    const project = new SetupService({ kernel: kernelWith({ listModels, checkModel }), projectRoot: root });
    await expect(project.models()).rejects.toMatchObject({ code: 'invalid_config', message: expect.stringMatching(/global file only/) });
    expect(listModels).not.toHaveBeenCalled();
    expect(checkModel).not.toHaveBeenCalled();
  });

  it('lists through the fake pi with -e after the isolation flags', async () => {
    const ext = extension();
    useGlobalConfig(`pi:\n  extensions:\n    - ${ext}\n`);
    const { fake, service } = fakePiService(tempDir(), { models: [piModel('reggiellm', 'office')] });
    expect((await service.models()).models.map((m) => m.name)).toEqual(['reggiellm/office']);
    const argv: string[] = fake.log()[0].argv;
    expect(argv).toContain('-ne');
    expect(argv.slice(argv.indexOf('-e'), argv.indexOf('-e') + 2)).toEqual(['-e', ext]);
  });
});

describe('SetupService.show', () => {
  it('marks a tier whose model the host does not list as not listed', async () => {
    const root = makeProject(TIERED_YAML);
    const { service } = fakePiService(root, { models: [piModel('local', 'qwen'), piModel('r9700', 'Qwen3.8')] });
    const shown = await service.show();
    expect(shown.host).toBe('pi');
    expect(shown.listingError).toBeUndefined();
    if (shown.state.status === 'refused') throw new Error('unexpected refused state');
    const listed = Object.fromEntries(shown.state.tiers.map((t) => [t.tier, t.listed]));
    expect(listed).toMatchObject({ default: true, medium: true, small: false, large: false });
    expect(shown.state.tiers.find((t) => t.tier === 'far')).toMatchObject({ otherHost: true });
    expect(JSON.parse(JSON.stringify(shown))).toEqual(shown);
  });

  it('includes the large warning sentence from the tier-word table', async () => {
    const { service } = fakePiService(makeProject());
    const shown = await service.show();
    expect(shown.largeWarning).toBe(LARGE_TIER_WARNING);
    expect(LARGE_TIER_WARNING).toMatch(/compound-engineering/);
    expect(LARGE_TIER_WARNING).toMatch(/Claude/);
  });

  it('shows the state with no listed flags and the reason when the listing fails', async () => {
    const { service } = fakePiService(makeProject(), { refuseModels: 'no catalog' });
    const shown = await service.show();
    expect(shown.listingError).toMatch(/no catalog/);
    if (shown.state.status === 'refused') throw new Error('unexpected refused state');
    expect(shown.state.tiers.every((t) => t.listed === null)).toBe(true);
  });

  it('shows the state without listing when the prerequisites fail', async () => {
    const listModels = vi.fn(async () => []);
    const service = new SetupService({ kernel: kernelWith({ prerequisites: () => 'pi is missing', listModels }), projectRoot: makeProject() });
    const shown = await service.show();
    expect(shown.listingError).toBe('pi is missing');
    expect(listModels).not.toHaveBeenCalled();
  });

  it('shows both layers with a source on every tier and limit, and the entries this project overrides', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML.replace('medium: {', 'large: { host: pi, model: cloud/l, thinking: high }\n    medium: {'));
    const { service } = fakePiService(makeProject(DEFAULT_YAML));
    const shown = await service.show();
    if (shown.state.status === 'refused') throw new Error('unexpected refused state');
    expect(shown.state.tiers.map((t) => [t.tier, t.source])).toEqual([
      ['large', 'global'],
      ['medium', 'project'],
      ['small', 'project'],
      ['cloud', 'project'],
    ]);
    expect(shown.state.limits.map((l) => [l.endpoint, l.source])).toEqual([['local', 'project']]);
    expect(shown.state.overridden).toEqual({ tiers: ['medium'], limits: [] });
    // The global file's own medium rides on the overridden tier; a tier only one layer holds carries none.
    expect(shown.state.tiers.map((t) => [t.tier, t.global])).toEqual([
      ['large', undefined],
      ['medium', { host: 'pi', model: 'local/global-medium', thinking: 'low' }],
      ['small', undefined],
      ['cloud', undefined],
    ]);
    expect(shown.state.limits.map((l) => l.global)).toEqual([undefined]);
  });

  it('reports no file for a project without an agent file', async () => {
    const { service } = fakePiService(tempDir());
    expect((await service.show()).state.status).toBe('no-file');
  });
});

describe('SetupService.check', () => {
  it('checks three models one after another and returns a result for each', async () => {
    let running = 0;
    let overlap = false;
    const seen: ModelCheckRequest[] = [];
    const checkModel = async (request: ModelCheckRequest): Promise<ModelCheckResult> => {
      seen.push(request);
      running += 1;
      if (running > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return request.model === 'b/two' ? { ok: false, kind: 'failed', message: 'no key' } : { ok: true };
    };
    const root = tempDir();
    const service = new SetupService({ kernel: kernelWith({ checkModel }), projectRoot: root });
    const result = await service.check([
      { model: 'a/one', thinking: 'high' },
      { model: 'b/two', thinking: 'low' },
      { model: 'c/three', thinking: 'off' },
    ]);
    expect(overlap).toBe(false);
    expect(seen.map((r) => r.projectRoot)).toEqual([root, root, root]);
    expect(result).toEqual({
      host: 'pi',
      results: [
        { model: 'a/one', thinking: 'high', ok: true },
        { model: 'b/two', thinking: 'low', ok: false, kind: 'failed', message: 'no key' },
        { model: 'c/three', thinking: 'off', ok: true },
      ],
    });
  });

  it('runs one pi at a time against the fake pi, in order', async () => {
    const root = makeProject();
    const { fake, service } = fakePiService(root, { unknownModels: ['nowhere/missing'] });
    const result = await service.check([
      { model: 'local/qwen', thinking: 'high' },
      { model: 'nowhere/missing', thinking: 'off' },
      { model: 'cloud/model', thinking: 'low' },
    ]);
    expect(result.results.map((r) => [r.model, r.ok])).toEqual([
      ['local/qwen', true],
      ['nowhere/missing', false],
      ['cloud/model', true],
    ]);
    expect(result.results[1]).toMatchObject({ kind: 'unknown_model' });
    const starts = fake.log().filter((l) => l.argv !== undefined);
    expect(starts.map((l) => l.argv[l.argv.indexOf('--model') + 1])).toEqual(['local/qwen', 'nowhere/missing', 'cloud/model']);
    expect(starts.every((l) => l.cwd === root)).toBe(true);
  });

  it('reports every model cancelled once the signal is aborted', async () => {
    const { service } = fakePiService(makeProject());
    const controller = new AbortController();
    controller.abort();
    const result = await service.check(
      [
        { model: 'local/qwen', thinking: 'high' },
        { model: 'cloud/model', thinking: 'low' },
      ],
      controller.signal,
    );
    expect(result.results.map((r) => !r.ok && r.kind)).toEqual(['cancelled', 'cancelled']);
  });

  it('refuses a driver that cannot check a model', async () => {
    const service = new SetupService({ kernel: kernelWith({}), projectRoot: tempDir() });
    await expect(service.check([{ model: 'a/b', thinking: 'off' }])).rejects.toMatchObject({ code: 'no_model_check' });
  });

  it('refuses a malformed request before checking anything', async () => {
    const checkModel = vi.fn(async (): Promise<ModelCheckResult> => ({ ok: true }));
    const service = new SetupService({ kernel: kernelWith({ checkModel }), projectRoot: tempDir() });
    await expect(service.check([{ model: 'a/b', thinking: 'loud' as never }])).rejects.toMatchObject({ code: 'invalid_check' });
    await expect(service.check([{ model: '', thinking: 'off' }])).rejects.toMatchObject({ code: 'invalid_check' });
    expect(checkModel).not.toHaveBeenCalled();
  });
});

describe('SetupService.preview and apply', () => {
  it('act on the service project root, not the working directory', () => {
    const root = makeProject(DEFAULT_YAML);
    const elsewhere = makeProject(DEFAULT_YAML);
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    const service = new SetupService({ kernel: kernelWith({ starterTools: STARTER }), projectRoot: root });
    const changes = [{ op: 'setTier' as const, tier: 'large', model: 'local/qwen', thinking: 'high' as const }];
    const preview = service.preview(changes);
    expect(preview.agentFile).toBe(path.join(root, '.agents', 'subzero.yaml'));
    expect(preview.nothingToChange).toBe(false);
    const applied = service.apply(changes, preview.fingerprint);
    expect(applied.written).toBe(true);
    expect(readFileSync(path.join(root, '.agents', 'subzero.yaml'), 'utf8')).toContain('large: { host: pi, model: local/qwen, thinking: high }');
    expect(readFileSync(path.join(elsewhere, '.agents', 'subzero.yaml'), 'utf8')).toBe(DEFAULT_YAML);
  });

  it('previews a guided change as the changed tiers only: no starter entries, none added', () => {
    const root = tempDir();
    const service = new SetupService({ kernel: kernelWith({ starterTools: STARTER }), projectRoot: root });
    const changes = [{ op: 'setTier' as const, tier: 'medium', model: 'local/qwen', thinking: 'high' as const }];
    const preview = service.preview(changes);
    expect(preview).not.toHaveProperty('addedStarter');
    expect(preview.text).toBe('models:\n  tiers:\n    medium: { host: pi, model: local/qwen, thinking: high }\n');
    expect(service.apply(changes, preview.fingerprint).written).toBe(true);
  });

  it('takes the scope: the global file is previewed and written, the project file left alone', () => {
    const global = path.join(tempDir(), '.agents', 'subzero.yaml');
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', global);
    const root = makeProject(DEFAULT_YAML);
    const service = new SetupService({ kernel: kernelWith({}), projectRoot: root });
    const changes = [{ op: 'setTier' as const, tier: 'medium', model: 'local/everywhere', thinking: 'low' as const }];
    const preview = service.preview(changes, 'global');
    expect(preview).toMatchObject({ scope: 'global', agentFile: global, fileExists: false, overridden: { tiers: ['medium'], limits: [] } });
    expect(() => service.apply(changes, preview.fingerprint)).toThrow(SetupConflictError);
    expect(service.apply(changes, preview.fingerprint, 'global').written).toBe(true);
    expect(readFileSync(global, 'utf8')).toBe('models:\n  tiers:\n    medium: { host: pi, model: local/everywhere, thinking: low }\n');
    expect(readFileSync(path.join(root, '.agents', 'subzero.yaml'), 'utf8')).toBe(DEFAULT_YAML);
  });

  it('passes a stale preview refusal on', () => {
    const root = makeProject();
    const service = new SetupService({ kernel: kernelWith({ starterTools: STARTER }), projectRoot: root });
    const changes = [{ op: 'unsetTier' as const, tier: 'cloud' }];
    expect(() => service.apply(changes, 'not-the-fingerprint')).toThrow(SetupConflictError);
  });

  it('needs no starter tools from the host for a guided preview', () => {
    const service = new SetupService({ kernel: kernelWith({}), projectRoot: makeProject() });
    expect(service.preview([{ op: 'setTier', tier: 'large', model: 'local/qwen', thinking: 'low' }]).refusals).toEqual([]);
  });
});
