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

  it('adds -e <path> for each extension right after the isolation flags, keeping -ne, and nothing when there are none', () => {
    expect(childRpcArgs([])).toEqual(childRpcArgs());
    expect(childRpcArgs(['/e/one.ts', '/e/two.ts'])).toEqual([
      '--mode', 'rpc', '--offline', '-na', '-ne', '-nc', '-np', '--no-themes', '-ns',
      '-e', '/e/one.ts', '-e', '/e/two.ts',
    ]);
    const root = makeProject();
    const args = launchArgs({ taskId: 'sz-abcdef', agent: getAgent(root, 'helper'), overlaySkills: ['/o/alpha'], sessionsFolder: '/s', piExtensions: ['/e/one.ts'] });
    expect(args.slice(0, 11)).toEqual([...childRpcArgs(), '-e', '/e/one.ts']);
    expect(args.slice(11, 13)).toEqual(['--skill', '/o/alpha']);
    expect(args).toContain('-ne');
    expect(launchArgs({ taskId: 'sz-abcdef', agent: getAgent(root, 'helper'), overlaySkills: [], sessionsFolder: '/s' })).not.toContain('-e');
  });

  it('keeps the -e flags in the attach command, which reopens the child with the same extensions', () => {
    const command = ['pi', '--mode', 'rpc', '--offline', '-ne', '-e', '/e/one.ts', '--session-dir', '/s', '--session-id', 'sz-abcdef'];
    const attach = attachCommand({ command, cwd: '/p', envNames: [], version: '0.87.0', skillFolders: [], thinkingLevel: 'high' });
    expect(attach).toEqual(['pi', '--offline', '-ne', '-e', '/e/one.ts', '--session-dir', '/s', '--session-id', 'sz-abcdef']);
  });

  it('builds the attach command without --mode rpc and without --session', () => {
    const command = ['pi', '--mode', 'rpc', '--offline', '--session-dir', '/s', '--session-id', 'sz-abcdef', '--session', '/x'];
    const attach = attachCommand({ command, cwd: '/p', envNames: [], version: '0.87.0', skillFolders: [], thinkingLevel: 'high' });
    expect(attach).toEqual(['pi', '--offline', '--session-dir', '/s', '--session-id', 'sz-abcdef']);
  });
});
