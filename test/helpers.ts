import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished, vi } from 'vitest';
import {
  unavailableUsage,
  type ChildOutcome,
  type ChildPort,
  type ChildRun,
  type ChildRunRequest,
  type DomainEvent,
  type SteerAnswer,
  type StarterTools,
} from '../src/core/types.js';
import { Kernel } from '../src/kernel/kernel.js';
import { PI_HOST, PiDriver, type PiDriverOptions } from '../src/pi/driver.js';

export const FAKE_PI = fileURLToPath(new URL('./fake-pi/fake-pi.mjs', import.meta.url));
export const FAKE_PI_COMMAND = [process.execPath, FAKE_PI];

export function tempDir(prefix = 'subzero-test-'): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Writes a global file and points SUBZERO_GLOBAL_CONFIG at it until the test ends; returns its path. */
export function useGlobalConfig(yaml: string): string {
  const file = path.join(tempDir('subzero-global-'), 'subzero.yaml');
  writeFileSync(file, yaml);
  const previous = process.env.SUBZERO_GLOBAL_CONFIG;
  process.env.SUBZERO_GLOBAL_CONFIG = file;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.SUBZERO_GLOBAL_CONFIG;
    else process.env.SUBZERO_GLOBAL_CONFIG = previous;
  });
  return file;
}

/**
 * Writes the global file at its default place, ~/.agents/subzero.yaml of a fresh home folder that
 * os.homedir() answers until the test ends.
 */
export function useDefaultGlobalConfig(yaml: string): { home: string; file: string } {
  const home = tempDir('subzero-home-');
  const file = path.join(home, '.agents', 'subzero.yaml');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, yaml);
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  const previous = process.env.SUBZERO_GLOBAL_CONFIG;
  process.env.SUBZERO_GLOBAL_CONFIG = '';
  onTestFinished(() => {
    homedir.mockRestore();
    if (previous === undefined) delete process.env.SUBZERO_GLOBAL_CONFIG;
    else process.env.SUBZERO_GLOBAL_CONFIG = previous;
  });
  return { home, file };
}

/** A global file with a medium tier on the host pi, for the tests of a project with no file of its own. */
export const GLOBAL_MEDIUM_YAML = 'models:\n  tiers:\n    medium: { host: pi, model: local/global-medium, thinking: low }\n';

export const DEFAULT_YAML = `
skills:
  alpha: ./skills/alpha
  beta: ./skills/beta
models:
  parallel:
    local/qwen: 1
  tiers:
    medium: { host: pi, model: local/qwen, thinking: high }
    small: { host: pi, model: local/qwen, thinking: low }
    cloud: { host: pi, model: cloud/model, thinking: low }
agents:
  general:
    tools: [read, bash, write, edit]
    timeout: 9
  fallback:
    tools: [read, grep]
    timeout: 8
  helper:
    description: A test helper
    skills: [alpha, beta]
    tools: [read, write]
    timeout: 30
  other:
    description: Another helper, on a model with its own limit
    tier: small
    skills: [alpha]
    tools: [read]
    timeout: 30
  free:
    description: An agent on a model with no limit
    tier: cloud
    skills: []
    tools: [read]
    timeout: 30
`;

/**
 * DEFAULT_YAML plus the tiers medium, large and far (a host with no driver), a
 * general entry with a full tool list, a read-only fallback entry and a reviewer
 * with its own override for large.
 */
export const TIERED_YAML =
  DEFAULT_YAML.replace(
    '    medium: { host: pi, model: local/qwen, thinking: high }\n',
    '    default: { host: pi, model: local/qwen, thinking: high }\n' +
      '    medium: { host: pi, model: r9700/Qwen3.8, thinking: medium }\n',
  ).replace(
    '    cloud: { host: pi, model: cloud/model, thinking: low }\n',
    '    cloud: { host: pi, model: cloud/model, thinking: low }\n' +
      '    large: { host: pi, model: cloud/large, thinking: high }\n' +
      '    far: { host: claude, model: anthropic/opus, thinking: max }\n',
  ) +
  `  reviewer:
    description: A reviewer with its own model for large
    tiers:
      large: { model: cloud/reviewer-large }
    tools: [read]
    timeout: 7
`;

/** A project root with .agents/subzero.yaml and the skill folders it names. */
export function makeProject(yaml = DEFAULT_YAML): string {
  const root = tempDir('subzero-project-');
  mkdirSync(path.join(root, '.agents', 'skills', 'alpha'), { recursive: true });
  mkdirSync(path.join(root, '.agents', 'skills', 'beta'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nAlpha.\n');
  writeFileSync(path.join(root, '.agents', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\nBeta.\n');
  writeFileSync(path.join(root, '.agents', 'subzero.yaml'), yaml);
  return root;
}

export interface FakePiEnv {
  env: NodeJS.ProcessEnv;
  logFile: string;
  log(): any[];
}

export function fakePiEnv(scenario: Record<string, unknown> = {}): FakePiEnv {
  const logFile = path.join(tempDir('subzero-fakepi-'), 'log.jsonl');
  writeFileSync(logFile, '');
  return {
    env: { ...process.env, FAKE_PI_SCENARIO: JSON.stringify(scenario), FAKE_PI_LOG: logFile },
    logFile,
    log: () =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** What an entry point does: a Kernel with PiDriver registered for the host pi. */
export function piKernel(options: PiDriverOptions = {}): { kernel: Kernel; driver: PiDriver } {
  const driver = new PiDriver(options);
  const kernel = new Kernel();
  kernel.registerChildDriver(PI_HOST, driver);
  return { kernel, driver };
}

/** A Kernel whose host pi runs the given child port, for tests that settle runs by hand. */
export function kernelWithPort(port: ChildPort, starterTools?: () => StarterTools): Kernel {
  const kernel = new Kernel();
  kernel.registerChildDriver(PI_HOST, { port, ...(starterTools !== undefined ? { starterTools } : {}) });
  return kernel;
}

/** A child port that the test settles by hand, recording each start. */
/** One run a manual port started, which the test drives by hand. */
export interface ManualRun {
  taskId: string;
  /** `start` for a first start or a release with the brief, `resume` for a resumed session. */
  kind: 'start' | 'resume';
  /** The brief of the request; for a resume, the message that is the prompt. */
  brief: string;
  prompt: string;
  request: ChildRunRequest;
  emit: (event: DomainEvent) => void;
  settle: (o?: Partial<ChildOutcome>) => void;
  cancelled: boolean;
  /** The steering messages the run was given, in order. */
  steers: string[];
  /** What the run answers a steering message: a fixed answer, or a function of the message. */
  steerAnswer: SteerAnswer | ((message: string) => SteerAnswer | Promise<SteerAnswer>);
}

export interface ManualPortOptions {
  /** The port offers turn steering. */
  steers?: boolean;
  /** The port offers session resume; or a function that throws, such as SessionMissingError, to refuse. */
  resume?: boolean | ((request: ChildRunRequest) => void);
  /** A cancel only marks the run cancelled, so the test settles it, as a child whose turn ended first. */
  lateCancel?: boolean;
}

/**
 * A child port whose runs the test settles by hand. By default it offers neither steering nor
 * resume, as a minimal driver; `started` and `runs` are the same list.
 */
export function manualPort(options: ManualPortOptions = {}) {
  const started: ManualRun[] = [];
  const begin = (kind: ManualRun['kind'], request: ChildRunRequest, prompt: string, onEvent: (e: DomainEvent) => void): ChildRun => {
    let resolve!: (o: ChildOutcome) => void;
    const outcome = new Promise<ChildOutcome>((r) => (resolve = r));
    const run: ManualRun = {
      taskId: request.taskId,
      kind,
      brief: request.brief,
      prompt,
      request,
      emit: onEvent,
      settle: (o: Partial<ChildOutcome> = {}) =>
        resolve({ lastAssistantText: 'ok', status: 'completed', usage: unavailableUsage('n/a'), ...o }),
      cancelled: false,
      steers: [],
      steerAnswer: 'delivered',
    };
    started.push(run);
    return {
      outcome,
      cancel: () => {
        run.cancelled = true;
        if (options.lateCancel !== true) run.settle({ status: 'cancelled' });
      },
      ...(options.steers === true
        ? {
            async steer(message: string) {
              const answer = typeof run.steerAnswer === 'function' ? await run.steerAnswer(message) : run.steerAnswer;
              if (answer === 'delivered') run.steers.push(message);
              return answer;
            },
          }
        : {}),
    };
  };
  const port: ChildPort = {
    start: (request, onEvent) => begin('start', request, request.brief, onEvent),
    ...(options.steers === true ? { steers: true } : {}),
    ...(options.resume !== undefined && options.resume !== false
      ? {
          resume: (request: ChildRunRequest, message: string, onEvent: (e: DomainEvent) => void) => {
            if (typeof options.resume === 'function') options.resume(request);
            return begin('resume', request, message, onEvent);
          },
        }
      : {}),
  };
  return { port, started, runs: started };
}
