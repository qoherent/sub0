// @sigil implements design/pi-extension.sigil PiExtension (completion notice)
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function sendCompletion(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: 'subzero-completion', content, display: true }, { triggerTurn: true, deliverAs: 'steer' });
}

export function sendStopped(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: 'subzero-stopped', content, display: true }, { triggerTurn: false, deliverAs: 'nextTurn' });
}
