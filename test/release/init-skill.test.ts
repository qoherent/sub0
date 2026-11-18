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

  it('maps preview and apply with the scope flag, and every command it names matches a pin', () => {
    const table = SKILL.split('| Guide step').slice(1).join('');
    expect(flat(table)).toMatch(/config preview --scope <scope> <changes>/);
    expect(flat(table)).toMatch(/config apply --scope <scope> --expect <fingerprint> <changes>/);
    expect(flat(SKILL)).toMatch(/`<scope>` is `general` for every project or `project` for this one/);
    const pins = front['allowed-tools'].map((tool) => /^Bash\((.*)\)$/s.exec(tool)![1]!);
    const matches = (pin: string, command: string) => (pin.endsWith(' *') ? command.startsWith(pin.slice(0, -1)) : command === pin);
    const named = [...SKILL.matchAll(/`(SUBZERO_PROJECT_DIR=[^`]*)`/g)].map((m) => m[1]!.replace(/<[^>]+>/g, 'x'));
    expect(named.length).toBeGreaterThanOrEqual(5);
    for (const command of named) expect(pins.some((pin) => matches(pin, command)), command).toBe(true);
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

  it('asks the scope after show, and every later preview and apply carries it', () => {
    const guide = flat(GUIDE);
    const show = guide.indexOf('### 1. Show the current state');
    const scope = guide.indexOf('every project or only this one');
    const models = guide.indexOf('### 4. Choose a model');
    expect(scope).toBeGreaterThan(show);
    expect(scope).toBeLessThan(models);
    expect(guide).toMatch(/default is the general file when it exists and this project has no overrides, otherwise this project/);
    expect(guide).toMatch(/Run \*\*preview\*\* with the scope and every change/);
    expect(guide).toMatch(/Run \*\*apply\*\* with the scope, the preview's fingerprint and the same changes/);
    expect(guide).toMatch(/first-time general setup uses the general scope/i);
  });

  it('reads out the overridden list of a general-scope preview before the confirm', () => {
    expect(flat(GUIDE)).toMatch(/general scope[^.]*`overridden`[^.]*say[^.]*this project keeps its own[^.]*before you ask to confirm/i);
  });

  it('no longer says a missing fallback agent is added on apply', () => {
    expect(flat(GUIDE)).not.toMatch(/is added when you apply/);
    expect(flat(GUIDE)).not.toMatch(/`repairable`: say what will be repaired, for example a missing `fallback` agent/);
    expect(flat(GUIDE)).toMatch(/`repairable`:/);
  });
});
