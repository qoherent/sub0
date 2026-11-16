import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/config/agent-config.js';
import { attachCommand, childRpcArgs, launchArgs } from '../../src/pi/launch.js';
import { makeProject } from '../helpers.js';

describe('launch spec', () => {
  it('uses exactly the isolation flag set and never --session', () => {
    const root = makeProject();
    const agent = getAgent(root, 'helper');
    const args = launchArgs({ taskId: 'sz-abcdef', agent, overlaySkills: ['/o/alpha', '/o/beta'], sessionsFolder: '/p/.agents/subzero/sessions' });
    expect(args).toEqual([
      '--mode', 'rpc', '--offline', '-na', '-ne', '-nc', '-np', '--no-themes', '-ns',
      '--skill', '/o/alpha', '--skill', '/o/beta',
      '--model', 'local/qwen', '--thinking', 'high', '--tools', 'read,write',
      '--session-dir', '/p/.agents/subzero/sessions', '--session-id', 'sz-abcdef',
      '--name', 'subzero:helper:sz-abcdef',
    ]);
    expect(args).not.toContain('--session');
  });

  it('builds the children\'s RPC isolation flags in one place, which every child run starts with', () => {
    expect(childRpcArgs()).toEqual(['--mode', 'rpc', '--offline', '-na', '-ne', '-nc', '-np', '--no-themes', '-ns']);
    const root = makeProject();
    const args = launchArgs({ taskId: 'sz-abcdef', agent: getAgent(root, 'helper'), overlaySkills: [], sessionsFolder: '/s' });
    expect(args.slice(0, childRpcArgs().length)).toEqual(childRpcArgs());
  });

  it('builds the attach command without --mode rpc and without --session', () => {
    const command = ['pi', '--mode', 'rpc', '--offline', '--session-dir', '/s', '--session-id', 'sz-abcdef', '--session', '/x'];
    const attach = attachCommand({ command, cwd: '/p', envNames: [], version: '0.87.0', skillFolders: [], thinkingLevel: 'high' });
    expect(attach).toEqual(['pi', '--offline', '--session-dir', '/s', '--session-id', 'sz-abcdef']);
  });
});
