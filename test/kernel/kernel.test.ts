import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildDriver, ChildPort, HostModel } from '../../src/core/types.js';
import { Kernel, UnsupportedHostError } from '../../src/kernel/kernel.js';

const SRC = path.resolve(import.meta.dirname, '..', '..', 'src');

function driver(extra: Partial<ChildDriver> = {}): ChildDriver & { starts: number } {
  const state = { starts: 0 };
  const port: ChildPort = {
    start() {
      state.starts++;
      throw new Error('a test driver starts no child');
    },
  };
  return Object.assign(state, { port }, extra);
}

describe('Kernel', () => {
  it('hands out the child port of the driver registered for a host and lists the supported hosts', () => {
    const kernel = new Kernel();
    expect(kernel.supportedHosts()).toEqual([]);
    const pi = driver();
    kernel.registerChildDriver('pi', pi);
    expect(kernel.supportedHosts()).toEqual(['pi']);
    expect(kernel.childPort('pi')).toBe(pi.port);
  });

  it('refuses the child port of a host with no driver, naming the host and every supported host, and starts no child', () => {
    const kernel = new Kernel();
    const pi = driver();
    const codex = driver();
    kernel.registerChildDriver('pi', pi);
    kernel.registerChildDriver('codex', codex);
    let caught: unknown;
    try {
      kernel.childPort('claude');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedHostError);
    expect((caught as Error).message).toContain('claude');
    expect((caught as Error).message).toContain('pi, codex');
    expect(pi.starts + codex.starts).toBe(0);
  });

  it('says that no host is supported in a process whose entry point registered no driver', () => {
    expect(() => new Kernel().childPort('pi')).toThrow(/no child driver is registered for the host "pi".*\(none\)/s);
  });

  it('refuses a second driver for a host, names the host and keeps the first', () => {
    const kernel = new Kernel();
    const first = driver();
    kernel.registerChildDriver('pi', first);
    expect(() => kernel.registerChildDriver('pi', driver())).toThrow(/"pi"/);
    expect(kernel.childPort('pi')).toBe(first.port);
    expect(kernel.supportedHosts()).toEqual(['pi']);
  });

  it('refuses a second parent adapter with one name, naming it', () => {
    const kernel = new Kernel();
    kernel.registerParentAdapter('mcp');
    expect(() => kernel.registerParentAdapter('mcp')).toThrow(/"mcp"/);
    expect(() => kernel.registerParentAdapter('other')).not.toThrow();
  });

  it('offers the attach command, session export and starter tools of a host only when its driver has them', () => {
    const kernel = new Kernel();
    const attach = (spec: { command: string[] }) => spec.command;
    const sessionExport = async () => {};
    const starter = { general: ['read', 'write'], fallback: ['read'] };
    kernel.registerChildDriver('pi', driver({ attachCommand: attach as never, sessionExport, starterTools: () => starter }));
    kernel.registerChildDriver('bare', driver());
    expect(kernel.attachCommand('pi')).toBe(attach);
    expect(kernel.sessionExport('pi')).toBe(sessionExport);
    expect(kernel.starterTools('pi')).toEqual(starter);
    expect(kernel.attachCommand('bare')).toBeUndefined();
    expect(kernel.sessionExport('bare')).toBeUndefined();
    expect(kernel.starterTools('bare')).toBeUndefined();
  });

  it('offers the prerequisites check of a host only when its driver has one', () => {
    const kernel = new Kernel();
    const check = () => 'pi is missing';
    kernel.registerChildDriver('pi', driver({ prerequisites: check }));
    kernel.registerChildDriver('bare', driver());
    expect(kernel.prerequisites('pi')).toBe(check);
    expect(kernel.prerequisites('pi')?.()).toBe('pi is missing');
    expect(kernel.prerequisites('bare')).toBeUndefined();
  });

  it('refuses the prerequisites check of an unsupported host with the same error', () => {
    const kernel = new Kernel();
    kernel.registerChildDriver('pi', driver());
    expect(() => kernel.prerequisites('x')).toThrow(UnsupportedHostError);
    expect(() => kernel.prerequisites('x')).toThrow(/"x".*supported hosts: pi/s);
  });

  it('offers the model listing and model check of a host only when its driver has them', async () => {
    const kernel = new Kernel();
    const models: HostModel[] = [
      { name: 'local/qwen', endpoint: 'local', reasoning: false, thinkingLevels: ['off'], input: ['text'] },
    ];
    const listModels = async () => models;
    const checkModel = async () => ({ ok: true }) as const;
    kernel.registerChildDriver('pi', driver({ listModels, checkModel }));
    kernel.registerChildDriver('bare', driver());
    expect(kernel.listModels('pi')).toBe(listModels);
    expect(await kernel.listModels('pi')?.()).toEqual(models);
    expect(kernel.checkModel('pi')).toBe(checkModel);
    expect(await kernel.checkModel('pi')?.({ model: 'local/qwen', thinking: 'off' })).toEqual({ ok: true });
    expect(kernel.listModels('bare')).toBeUndefined();
    expect(kernel.checkModel('bare')).toBeUndefined();
  });

  it('refuses every lookup for an unsupported host with the same error', () => {
    const kernel = new Kernel();
    kernel.registerChildDriver('pi', driver());
    for (const ask of [
      () => kernel.attachCommand('x'),
      () => kernel.sessionExport('x'),
      () => kernel.starterTools('x'),
      () => kernel.listModels('x'),
      () => kernel.checkModel('x'),
    ]) {
      expect(ask).toThrow(UnsupportedHostError);
      expect(ask).toThrow(/"x".*supported hosts: pi/s);
    }
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Every module specifier that a file imports, re-exports or loads dynamically. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('the seams of the core', () => {
  it('imports src/pi/ from no file outside src/pi/ except the entry points', () => {
    const entryPoints = new Set([path.join(SRC, 'cli', 'main.ts'), path.join(SRC, 'mcp', 'main.ts')]);
    const checked = ['core', 'store', 'service', 'config', 'kernel', 'cli', 'mcp'].flatMap((d) => sourceFiles(path.join(SRC, d)));
    expect(checked.length).toBeGreaterThan(10);
    const offenders = checked
      .filter((file) => !entryPoints.has(file))
      .filter((file) => specifiers(file).some((s) => s.startsWith('.') && path.resolve(path.dirname(file), s).startsWith(path.join(SRC, 'pi'))));
    expect(offenders).toEqual([]);
  });

  it('imports nothing from a parent adapter or the routing hooks into the core, the services and the command line', () => {
    const checked = ['cli', 'core', 'store', 'service', 'config', 'kernel'].flatMap((d) => sourceFiles(path.join(SRC, d)));
    expect(checked.length).toBeGreaterThan(8);
    const forbidden = [path.join(SRC, 'mcp'), path.join(SRC, 'routing')];
    const offenders = checked.filter((file) =>
      specifiers(file).some((s) => s.startsWith('.') && forbidden.some((dir) => path.resolve(path.dirname(file), s).startsWith(dir))),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the entry points as the only place that registers PiDriver', () => {
    for (const entry of [path.join(SRC, 'cli', 'main.ts'), path.join(SRC, 'mcp', 'main.ts')]) {
      expect(specifiers(entry)).toContain('../pi/driver.js');
    }
  });

  it('imports nothing but the shapes of the core into the Kernel', () => {
    expect(specifiers(path.join(SRC, 'kernel', 'kernel.ts')).filter((s) => s.startsWith('.'))).toEqual(['../core/types.js']);
  });
});
