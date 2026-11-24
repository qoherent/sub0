// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer (progress notification)
//
// One line per notification: the agent, the kind of the latest domain event, the
// tool and its target path for tool activity, and the elapsed time. Never agent
// text, tool output, other tool arguments, the stderr tail or skill content.
import type { ChildRunState, DomainEvent } from '../core/types.js';
import { describeEvent, formatProgress } from '../service/status-text.js';

export interface ProgressOptions {
  minIntervalMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

export class ProgressReporter {
  private counter = 0;
  private latest: string;
  private lastSent = Number.NEGATIVE_INFINITY;
  private trailing: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly started: number;
  private readonly minInterval: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private stopped = false;
  private waiting = false;

  constructor(
    private readonly agent: string,
    private readonly send: (progress: number, message: string) => void,
    options: ProgressOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.minInterval = options.minIntervalMs ?? 1000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.started = this.now();
    this.latest = 'starting';
    this.armHeartbeat();
  }

  /** Waiting while the run is Pending; once it is released the line says so and never says waiting again. */
  onState(state: ChildRunState): void {
    if (state === 'Pending') {
      this.waiting = true;
      this.update('waiting');
    } else if (this.waiting && (state === 'Starting' || state === 'Live')) {
      this.waiting = false;
      this.update('running');
    }
  }

  onEvent(event: DomainEvent): void {
    this.update(describeEvent(event));
  }

  private update(what: string): void {
    if (this.stopped) return;
    this.latest = what;
    const wait = this.lastSent + this.minInterval - this.now();
    if (wait <= 0) {
      this.flush();
    } else if (this.trailing === null) {
      // At most once a second, carrying the latest line.
      this.trailing = setTimeout(() => {
        this.trailing = null;
        this.flush();
      }, wait);
    }
  }

  private line(): string {
    return formatProgress(this.agent, this.latest, this.now() - this.started);
  }

  private flush(): void {
    if (this.stopped) return;
    this.lastSent = this.now();
    this.counter += 1;
    this.send(this.counter, this.line());
    this.armHeartbeat();
  }

  /** After 30 seconds of silence, repeat the latest line with the new elapsed time. */
  private armHeartbeat(): void {
    if (this.heartbeat !== null) clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => this.flush(), this.heartbeatMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.trailing !== null) clearTimeout(this.trailing);
    if (this.heartbeat !== null) clearTimeout(this.heartbeat);
  }
}
