#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRuntimeApplication, defaultDataRoot, runtimeVersion, safeToolError } from './application.ts';
import { createMcpServer } from './server.ts';

export type CliOptions = { workspace: string; dataDir: string; config?: string; help: boolean; version: boolean };

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(helpText); return; }
  if (options.version) { process.stdout.write(`${runtimeVersion()}\n`); return; }
  assertSupportedNode();
  const application = await createRuntimeApplication({
    workspaceRoot: options.workspace, dataRoot: options.dataDir,
    ...(options.config ? { configFile: options.config } : {}),
  });
  const server = createMcpServer(application);
  const handle = serveStdio(() => server);
  const shutdown = () => {
    void handle.close().then(() => server.shutdown()).catch(error => {
      console.error('Subzero shutdown failed:', safeToolError(error).message);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.error(`Subzero ${runtimeVersion()} MCP server started for ${application.workspaceRoot}.`);
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { workspace: process.cwd(), dataDir: defaultDataRoot(), help: false, version: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--version' || arg === '-v') { options.version = true; continue; }
    if (arg === '--workspace' || arg === '--data-dir' || arg === '--config') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--workspace') options.workspace = resolve(value);
      else if (arg === '--data-dir') options.dataDir = resolve(value);
      else options.config = resolve(value);
      continue;
    }
    throw new Error(`Unknown CLI option: ${arg}`);
  }
  return options;
}

function assertSupportedNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw new Error('Subzero requires Node.js 24.15 or newer.');
}

const helpText = `Subzero MCP server ${runtimeVersion()}

Usage: subzero-runtime [--workspace PATH] [--data-dir PATH] [--config PATH]

Runs an MCP server over stdio. Defaults: workspace=current directory,
data directory=local user data, config=<data directory>/config.json.

Config is JSON metadata with credentialRefs and optional templatesFile.
Credential entries map a name to { env, origins } and are resolved in memory.
`;

if (isCliEntrypoint()) {
  void runCli().catch(error => {
    console.error('Subzero could not start:', safeToolError(error).message);
    process.exitCode = 1;
  });
}

function isCliEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
