// Bundles each entry into one file under dist/, so the plugin runs with no install step.
// The version in package.json is stamped into each bundle as __SUBZERO_VERSION__.
// A `<file>?raw` import (as vitest reads it) is inlined as the file's text, so the pi
// bundle carries the guided init guide without shipping the skills folder.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const rawText = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw-text',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const entries = {
  server: 'src/mcp/main.ts',
  hook: 'src/mcp/session-hook.ts',
  'wake-hook': 'src/mcp/wake-hook.ts',
  'prompt-hook': 'src/mcp/prompt-hook.ts',
  'agent-hook': 'src/routing/agent-hook.ts',
  cli: 'src/cli/main.ts',
  'pi-extension': 'src/pi-parent/main.ts',
};

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    ...(name === 'pi-extension' ? { external: ['@earendil-works/*', 'typebox'] } : {}),
    define: { __SUBZERO_VERSION__: JSON.stringify(version) },
    plugins: [rawText],
    banner: {
      js: [
        name === 'cli' ? '#!/usr/bin/env node' : '',
        "import { createRequire as __subzeroCreateRequire } from 'node:module';",
        'const require = __subzeroCreateRequire(import.meta.url);',
      ].filter(Boolean).join('\n'),
    },
    logLevel: 'warning',
  });
}
