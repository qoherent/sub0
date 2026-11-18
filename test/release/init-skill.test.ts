import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LARGE_TIER_WARNING } from '../../src/config/tier-words.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => (existsSync(path.join(REPO, file)) ? readFileSync(path.join(REPO, file), 'utf8') : '');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const SKILL = read('skills/init/SKILL.md');
const GUIDE = read('skills/init/guided-init.md');
const front = parseYaml(SKILL.split('---')[1] ?? '') as { 'allowed-tools': string[]; 'disable-model-invocation': boolean };
const PREFIX = 'SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero"';

describe('the /subzero:init skill', () => {
  it('stays user-only', () => {
    expect(front['disable-model-invocation']).toBe(true);
  });

  it('keeps the quick-path pattern unchanged and pins each config command', () => {
    const tools = front['allowed-tools'];
    expect(tools).toContain(`Bash(${PREFIX} init *)`);
    for (const command of ['config show', 'config models', 'config check *', 'config preview *', 'config apply *']) {
      expect(tools).toContain(`Bash(${PREFIX} ${command})`);
    }
    expect(tools).toContain('Bash(cat "${CLAUDE_PLUGIN_ROOT}/skills/init/guided-init.md")');
  });

  it('grants no file-writing tool', () => {
    for (const tool of front['allowed-tools']) expect(tool).not.toMatch(/^(Write|Edit|MultiEdit|NotebookEdit)\b/);
  });

  it('branches on the arguments and points the guided branch at the shared guide', () => {
    expect(SKILL).toContain('$ARGUMENTS');
    expect(flat(SKILL)).toContain('cat "${CLAUDE_PLUGIN_ROOT}/skills/init/guided-init.md"');
    expect(flat(SKILL)).toMatch(/AskUserQuestion tool, for every question/);
    expect(flat(SKILL)).toMatch(/timeout set to 180000 ms/);
    expect(flat(SKILL)).toMatch(/start a new Claude Code session/);
  });
});

describe('the shared guided-init guide', () => {
  it('states the standing rules first', () => {
    const rules = flat(GUIDE.split('## Steps')[0] ?? '');
    expect(rules).toMatch(/never end your turn/i);
    expect(rules).toMatch(/Never create, edit or delete `\.agents\/subzero\.yaml` yourself/);
    expect(rules).toMatch(/Show subzero's preview diff and summary unchanged, and confirm once/);
  });

  it('keeps going after a refused change or a stale preview, and ends on any other refusal of an apply', () => {
    const rules = flat(GUIDE.split('## Steps')[0] ?? '');
    expect(rules).toMatch(/A refused change does not end the run/);
    expect(rules).toMatch(/stale preview error of an apply means[^.]*\. Preview again and confirm again/);
    expect(rules).toMatch(/Any other refusal, the write error and the load error included, ends the run\. Say what was refused, say that nothing was written, and stop/);
    expect(rules).not.toMatch(/keep going/i);
    expect(flat(GUIDE)).toMatch(/If apply refuses, follow rule 4/);
  });

  it('names every step the parents map', () => {
    for (const step of ['show', 'models', 'ask', 'check', 'preview', 'apply']) expect(GUIDE).toContain(`**${step}**`);
  });

  it('takes the large warning from show instead of restating it', () => {
    expect(flat(GUIDE)).toMatch(/show the large warning from \*\*show\*\*/);
    expect(GUIDE).not.toContain(LARGE_TIER_WARNING);
  });
});
