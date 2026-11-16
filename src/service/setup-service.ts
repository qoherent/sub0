// @sigil implements design/delegation-service.sigil DelegationService (guided setup)
//
// The five setup operations both parents offer during guided init: list the host's
// models, show the agent file's tiers and limits, check chosen models, preview a
// change set and apply it. A thin layer over the agent-file editor and the child
// driver of the host; the conversation itself lives in the shared guide text. Every
// operation acts on the project root the service was made with, never the process's
// working directory, and every result is plain JSON.
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from '../config/agent-config.js';
import {
  applyChanges,
  ChangeSetError,
  DEFAULT_SETUP_TIMEOUT,
  previewChanges,
  readSetupState,
  SetupConflictError,
  SetupRefusedError,
  type Change,
  type SetupApplyResult,
  type SetupPreview,
  type SetupStarterSpec,
  type SetupState,
} from '../config/agent-setup.js';
import { LARGE_TIER_WARNING } from '../config/tier-words.js';
import type { HostModel, ModelCheckResult } from '../core/types.js';
import type { Kernel } from '../kernel/kernel.js';

export interface SetupServiceOptions {
  kernel: Kernel;
  /** The resolved project root whose .agents/subzero.yaml setup reads and writes. */
  projectRoot: string;
  /** The host to set tiers up for; none chooses the single registered host. */
  host?: string;
}

export type SetupServiceErrorCode =
  | 'no_host'
  | 'host_needed'
  | 'unsupported_host'
  | 'prerequisites_missing'
  | 'no_model_listing'
  | 'listing_failed'
  | 'no_model_check'
  | 'invalid_check'
  | 'no_starter_tools';

/** A setup operation that cannot run; the message is one line a user can act on. */
export class SetupServiceError extends Error {
  constructor(
    readonly code: SetupServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SetupServiceError';
  }
}

/** Whether the setup service refused a request, as opposed to failing. */
export function isSetupError(err: unknown): boolean {
  return (
    err instanceof SetupServiceError ||
    err instanceof ChangeSetError ||
    err instanceof SetupConflictError ||
    err instanceof SetupRefusedError
  );
}

/** A refused request as both parents report it: the error's code, its one-line reason and any refusals. */
export function setupRefusalBody(err: Error): Record<string, unknown> {
  const code = (err as { code?: unknown }).code;
  return {
    ok: false,
    code: typeof code === 'string' ? code : 'error',
    message: err.message,
    ...(err instanceof SetupRefusedError ? { refusals: err.refusals } : {}),
  };
}

/**
 * The thinking level and timeout of `init <model>`, from its optional flags: thinking
 * defaults to medium, the timeout to DEFAULT_SETUP_TIMEOUT. An error is one line
 * without a prefix, for the caller to report.
 */
export function parseStarterOptions(options: {
  thinking?: string | undefined;
  timeout?: string | undefined;
}): { thinking: ThinkingLevel; timeout: number } | { error: string } {
  const { thinking = 'medium', timeout: timeoutOption } = options;
  const timeout = timeoutOption === undefined ? DEFAULT_SETUP_TIMEOUT : Number(timeoutOption);
  if (timeoutOption !== undefined && (timeoutOption.trim() === '' || !(timeout > 0))) {
    return { error: `--timeout must be a positive number of seconds (got "${timeoutOption}")` };
  }
  if (!isThinkingLevel(thinking)) {
    return { error: `--thinking must be one of ${THINKING_LEVELS.join(', ')} (got "${thinking}")` };
  }
  return { thinking, timeout };
}

export interface ModelsResult {
  host: string;
  models: HostModel[];
}

export interface ShowResult {
  host: string;
  /** The agent file's state; each tier's `listed` is null when the listing did not run or failed. */
  state: SetupState;
  /** What configuring `large` moves off Claude, to tell before `large` is set. */
  largeWarning: string;
  /** Why the tiers carry no listed flag: the prerequisites message or the listing failure. */
  listingError?: string;
}

export interface ModelCheckInput {
  model: string;
  thinking: ThinkingLevel;
}

export type ModelCheckEntry = ModelCheckInput & ModelCheckResult;

export interface CheckResult {
  host: string;
  /** One entry per requested model, in the order requested. */
  results: ModelCheckEntry[];
}

export class SetupService {
  readonly projectRoot: string;
  private readonly kernel: Kernel;
  private readonly namedHost: string | undefined;

  constructor(options: SetupServiceOptions) {
    this.kernel = options.kernel;
    this.projectRoot = options.projectRoot;
    this.namedHost = options.host;
  }

  /** The host setup writes tiers for, chosen as `subzero init` chooses it. */
  get host(): string {
    const supported = this.kernel.supportedHosts();
    if (supported.length === 0) {
      throw new SetupServiceError('no_host', 'no host is registered, so setup has no host to set tiers up for');
    }
    const host = this.namedHost ?? (supported.length === 1 ? supported[0] : undefined);
    if (host === undefined) {
      throw new SetupServiceError('host_needed', `a host must be named; setup has these supported hosts to choose from: ${supported.join(', ')}`);
    }
    if (!supported.includes(host)) {
      throw new SetupServiceError('unsupported_host', `the host "${host}" is not supported; supported hosts: ${supported.join(', ')}`);
    }
    return host;
  }

  /** The models a child of the host can use. Runs the host's prerequisites check first. */
  async models(): Promise<ModelsResult> {
    const host = this.host;
    return { host, models: await this.listModels(host) };
  }

  /** The agent file's state, with each tier marked listed or not when the host lists its models. */
  async show(): Promise<ShowResult> {
    const host = this.host;
    let listedModels: string[] | undefined;
    let listingError: string | undefined;
    try {
      listedModels = (await this.listModels(host)).map((m) => m.name);
    } catch (err) {
      if (!(err instanceof SetupServiceError)) throw err;
      listingError = err.message;
    }
    const state = readSetupState(this.projectRoot, { host, ...(listedModels ? { listedModels } : {}) });
    return { host, state, largeWarning: LARGE_TIER_WARNING, ...(listingError !== undefined ? { listingError } : {}) };
  }

  /**
   * Sends each model the host's one-turn check, one after another so a single local
   * server is not overloaded. Aborting the signal cancels the running check and
   * reports the rest cancelled.
   */
  async check(models: readonly ModelCheckInput[], signal?: AbortSignal): Promise<CheckResult> {
    const host = this.host;
    for (const [i, { model, thinking }] of models.entries()) {
      if (typeof model !== 'string' || model.trim() === '' || /[\r\n]/.test(model)) {
        throw new SetupServiceError('invalid_check', `model ${i + 1} must be a non-empty one-line model name`);
      }
      if (!isThinkingLevel(thinking)) {
        throw new SetupServiceError('invalid_check', `the thinking level of ${model} must be one of ${THINKING_LEVELS.join(', ')}`);
      }
    }
    const checkModel = this.kernel.checkModel(host);
    if (checkModel === undefined) {
      throw new SetupServiceError('no_model_check', `the child driver of the host "${host}" cannot check a model`);
    }
    const results: ModelCheckEntry[] = [];
    for (const { model, thinking } of models) {
      const result = await checkModel({ model, thinking, projectRoot: this.projectRoot, ...(signal ? { signal } : {}) });
      results.push({ model, thinking, ...result });
    }
    return { host, results };
  }

  /** What applying the change set would write; nothing is written. */
  preview(changes: readonly Change[]): SetupPreview {
    return previewChanges(this.projectRoot, changes, this.starter());
  }

  /** Writes a change set exactly as previewed; refuses when the file or the change set moved since. */
  apply(changes: readonly Change[], fingerprint: string): SetupApplyResult {
    return applyChanges(this.projectRoot, changes, fingerprint, this.starter());
  }

  private async listModels(host: string): Promise<HostModel[]> {
    const problem = this.kernel.prerequisites(host)?.();
    if (problem !== undefined) throw new SetupServiceError('prerequisites_missing', problem);
    const listModels = this.kernel.listModels(host);
    if (listModels === undefined) {
      throw new SetupServiceError('no_model_listing', `the child driver of the host "${host}" cannot list its models`);
    }
    try {
      return await listModels({ projectRoot: this.projectRoot });
    } catch (err) {
      throw new SetupServiceError('listing_failed', err instanceof Error ? err.message : String(err));
    }
  }

  private starter(): SetupStarterSpec {
    const host = this.host;
    const tools = this.kernel.starterTools(host);
    if (tools === undefined) {
      throw new SetupServiceError(
        'no_starter_tools',
        `the child driver of the host "${host}" offers no starter tools, so setup cannot write the agent entries`,
      );
    }
    return { host, timeout: DEFAULT_SETUP_TIMEOUT, generalTools: tools.general, fallbackTools: tools.fallback };
  }
}
