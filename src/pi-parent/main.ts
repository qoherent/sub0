// @sigil implements design/pi-extension.sigil PiExtension (entry point)
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../kernel/kernel.js';
import { PI_HOST, PiDriver } from '../pi/driver.js';
import { DelegationService } from '../service/delegation-service.js';
import { registerPiExtension } from './extension.js';

export default function subzero(pi: ExtensionAPI): void {
  const kernel = new Kernel();
  const driver = new PiDriver({ log: () => {} });
  kernel.registerChildDriver(PI_HOST, driver);
  kernel.registerParentAdapter('pi');
  registerPiExtension(pi, (ctx) => new DelegationService({
    kernel, env: { SUBZERO_PROJECT_DIR: ctx.cwd }, roots: () => [],
    warn: (message) => { if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else process.stderr.write(`subzero: ${message}\n`); },
  }), () => driver.killAll(), fileURLToPath(import.meta.url), kernel);
}
