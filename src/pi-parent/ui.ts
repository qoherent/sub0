// @sigil implements design/pi-extension.sigil PiExtension (session widget, clash warning)
import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { DelegationService } from '../service/delegation-service.js';
import { listingStatus } from '../service/status-text.js';

/** The winning tool and all commands must be inspected: a losing tool is not in the registry. */
export function clashWarning(pi: ExtensionAPI, ownFile: string): string | undefined {
  const tools = pi.getAllTools();
  const commands = pi.getCommands();
  const owner = tools.find((tool) => tool.name === 'subagent');
  const canonical = (file: string) => {
    try { return realpathSync(file); } catch { return path.resolve(file); }
  };
  const foreignOwner = owner !== undefined && canonical(owner.sourceInfo.path) !== canonical(ownFile);
  const conflict = [...tools, ...commands].some((item) => item.sourceInfo.path.toLowerCase().includes('pi-subagents'));
  if (!foreignOwner && !conflict) return undefined;
  const ownerName = owner === undefined ? 'unknown' : foreignOwner ? owner.sourceInfo.path : 'subzero';
  return `pi-subagents or another extension conflicts with subzero; subagent is owned by ${ownerName}. Remove pi-subagents.`;
}

export class SessionWidget {
  private timer: NodeJS.Timeout | undefined;
  private revision = 0;
  private closed = false;

  constructor(private readonly service: DelegationService, private readonly sessionId: string, private readonly ctx: ExtensionContext) {}

  async refresh(): Promise<void> {
    if (this.closed || !this.ctx.hasUI) return;
    const revision = ++this.revision;
    const tasks = await this.service.listLiveSession(this.sessionId);
    if (this.closed || revision !== this.revision) return;
    const rows = tasks.map((task) => `${task.taskId} · ${task.agent} · ${task.tier ?? 'unknown'} · ${task.model ?? 'unknown'} · ${listingStatus(task)}`);
    this.ctx.ui.setWidget('subzero', rows.length ? rows : undefined);
    if (rows.length && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), 1000);
      this.timer.unref();
    }
    if (!rows.length && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.ctx.hasUI) this.ctx.ui.setWidget('subzero', undefined);
  }
}
