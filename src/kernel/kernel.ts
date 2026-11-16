// @sigil implements design/kernel.sigil Kernel
//
// The registry of the two seams. Child drivers register by host and parent adapters
// by name; the entry point of each process does the registering. Kernel imports
// only the shapes of TaskCore, never a particular driver or adapter.
import type {
  AttachCommand,
  CheckModel,
  ChildDriver,
  ChildPort,
  ListModels,
  PrerequisitesCheck,
  SessionExport,
  StarterTools,
} from '../core/types.js';

/** A host with no registered child driver; names the host and every supported host. */
export class UnsupportedHostError extends Error {
  readonly code = 'unsupported_host';
  constructor(
    readonly host: string,
    readonly supportedHosts: string[],
  ) {
    super(
      `no child driver is registered for the host "${host}"; supported hosts: ${
        supportedHosts.length === 0 ? '(none)' : supportedHosts.join(', ')
      }`,
    );
    this.name = 'UnsupportedHostError';
  }
}

export class Kernel {
  private readonly drivers = new Map<string, ChildDriver>();
  private readonly parentAdapters = new Set<string>();

  /** Refuses a second driver for a host with the host named; the first stays. */
  registerChildDriver(host: string, driver: ChildDriver): void {
    if (this.drivers.has(host)) {
      throw new Error(`a child driver is already registered for the host "${host}"; a host has exactly one`);
    }
    this.drivers.set(host, driver);
  }

  /** Refuses a second parent adapter of one name; the names are kept only for that. */
  registerParentAdapter(name: string): void {
    if (this.parentAdapters.has(name)) {
      throw new Error(`a parent adapter named "${name}" is already registered`);
    }
    this.parentAdapters.add(name);
  }

  supportedHosts(): string[] {
    return [...this.drivers.keys()];
  }

  childPort(host: string): ChildPort {
    return this.driver(host).port;
  }

  /** Undefined when the driver of the host offers none; the caller refuses naming the host. */
  attachCommand(host: string): AttachCommand | undefined {
    return this.driver(host).attachCommand;
  }

  sessionExport(host: string): SessionExport | undefined {
    return this.driver(host).sessionExport;
  }

  starterTools(host: string): StarterTools | undefined {
    return this.driver(host).starterTools?.();
  }

  /** Undefined when the driver of the host offers none; the caller then has nothing to check. */
  prerequisites(host: string): PrerequisitesCheck | undefined {
    return this.driver(host).prerequisites;
  }

  /** Undefined when the driver of the host cannot list its models. */
  listModels(host: string): ListModels | undefined {
    return this.driver(host).listModels;
  }

  /** Undefined when the driver of the host cannot check a model. */
  checkModel(host: string): CheckModel | undefined {
    return this.driver(host).checkModel;
  }

  private driver(host: string): ChildDriver {
    const driver = this.drivers.get(host);
    if (driver === undefined) throw new UnsupportedHostError(host, this.supportedHosts());
    return driver;
  }
}
