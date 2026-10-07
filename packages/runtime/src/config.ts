import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { McpGrant, SkillSnapshot, TemplateDefinition, ToolGrant } from '@subzero/core';
import { CredentialResolver, type CredentialMap } from './credentials.ts';

export type RuntimeConfig = {
  workspaceRoot: string;
  dataRoot: string;
  templates: TemplateDefinition[];
  configuredModelRefs: string[];
  credentials: CredentialResolver;
};
export type LoadRuntimeConfigOptions = { dataRoot: string; workspaceRoot: string; credentialRefs?: CredentialMap; templatesFile?: string };
type RawTemplate = {
  id: string; description: string; instructions: string; tools?: ToolGrant[]; skills?: Array<string | SkillSnapshot>;
  mcpServers?: McpGrant[]; writeCapable?: boolean; workerAdapter?: string; workerVersion?: string;
};

const readerTools: ToolGrant[] = ['read', 'grep', 'find', 'ls'].map(name => ({ name, writable: false }));
const writerTools: ToolGrant[] = [...readerTools, ...['edit', 'write', 'bash'].map(name => ({ name, writable: true }))];

/** Loads only files rooted under the explicitly supplied trusted data root. */
export async function loadRuntimeConfig(options: LoadRuntimeConfigOptions): Promise<RuntimeConfig> {
  const dataRoot = await realpath(resolve(options.dataRoot));
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const templatesFile = options.templatesFile ?? 'templates.json';
  if (isAbsolute(templatesFile) || templatesFile.split(/[\\/]/).includes('..')) throw new Error('templatesFile must stay inside dataRoot.');
  const path = resolve(dataRoot, templatesFile);
  if (!isWithin(dataRoot, path)) throw new Error('templatesFile must stay inside dataRoot.');
  let raw: RawTemplate[] = [];
  try {
    const realFile = await realpath(path);
    if (!isWithin(dataRoot, realFile)) throw new Error('templatesFile must stay inside dataRoot.');
    const content = await readFile(realFile, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error('templates.json must contain an array.');
    raw = parsed as RawTemplate[];
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const templates: TemplateDefinition[] = [
    { id: 'researcher', description: 'Research assistant with read access.', instructions: 'Research the request and report evidence clearly.', tools: structuredClone(readerTools), skills: [], mcpServers: [], writeCapable: false },
    { id: 'coder', description: 'Coding assistant with workspace tools.', instructions: 'Inspect the request, make the requested changes, and report them.', tools: structuredClone(writerTools), skills: [], mcpServers: [], writeCapable: true },
  ];
  const seen = new Set(templates.map(template => template.id));
  for (const entry of raw) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.description !== 'string' || !entry.description || typeof entry.instructions !== 'string' || seen.has(entry.id)) throw new Error(`Invalid or duplicate template id: ${entry?.id}`);
    if ((entry.tools !== undefined && (!Array.isArray(entry.tools) || entry.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name || typeof tool.writable !== 'boolean'))) ||
      (entry.skills !== undefined && !Array.isArray(entry.skills)) || (entry.mcpServers !== undefined && !Array.isArray(entry.mcpServers)) ||
      (entry.writeCapable !== undefined && typeof entry.writeCapable !== 'boolean') ||
      (entry.workerAdapter !== undefined && typeof entry.workerAdapter !== 'string') || (entry.workerVersion !== undefined && typeof entry.workerVersion !== 'string')) {
      throw new Error(`Invalid template definition: ${entry.id}`);
    }
    const skills = await resolveSkills(entry.skills ?? [], dataRoot);
    const mcpServers = (entry.mcpServers ?? []).map(server => validateMcp(server));
    const tools = entry.tools ? entry.tools.map(tool => ({ name: tool.name, writable: tool.writable })) : [];
    const hasWriter = tools.some(tool => tool.writable) || mcpServers.some(server => server.writeCapable);
    if (hasWriter && entry.writeCapable === false) throw new Error(`Template ${entry.id} has writable grants but is not writeCapable.`);
    templates.push({
      id: entry.id, description: entry.description, instructions: entry.instructions, tools, skills, mcpServers,
      writeCapable: entry.writeCapable ?? hasWriter,
      ...(entry.workerAdapter ? { workerAdapter: entry.workerAdapter } : {}), ...(entry.workerVersion ? { workerVersion: entry.workerVersion } : {}),
    });
    seen.add(entry.id);
  }
  const credentials = new CredentialResolver(options.credentialRefs ?? {});
  return { workspaceRoot, dataRoot, templates, configuredModelRefs: credentials.configuredRefs(), credentials };
}

async function resolveSkills(entries: Array<string | SkillSnapshot>, dataRoot: string): Promise<SkillSnapshot[]> {
  const output: SkillSnapshot[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      if (!entry || typeof entry.name !== 'string' || typeof entry.content !== 'string') throw new Error('Skill snapshots require name and content.');
      output.push({ name: entry.name, content: entry.content });
      continue;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(entry) || entry === '.' || entry === '..') throw new Error(`Invalid skill name: ${entry}`);
    const candidate = resolve(dataRoot, 'skills', `${entry}.md`);
    const real = await realpath(candidate);
    if (!isWithin(dataRoot, real)) throw new Error(`Skill path escapes dataRoot: ${entry}`);
    output.push({ name: entry, content: await readFile(real, 'utf8') });
  }
  return output;
}

function validateMcp(server: McpGrant): McpGrant {
  if (!server || typeof server.name !== 'string' || !server.name || typeof server.command !== 'string' || !server.command || !Array.isArray(server.tools) || typeof server.writeCapable !== 'boolean') throw new Error('MCP grants require name, command, tools and writeCapable.');
  if (server.args?.some(arg => typeof arg !== 'string') || server.tools.some(tool => typeof tool !== 'string' || !tool) || server.envRefs?.some(ref => !/^(env|secret):[A-Za-z_][A-Za-z0-9_.-]*$/.test(ref))) throw new Error(`Invalid MCP grant: ${server.name}`);
  return { name: server.name, command: server.command, ...(server.args ? { args: [...server.args] } : {}), ...(server.envRefs ? { envRefs: [...server.envRefs] } : {}), tools: [...server.tools], writeCapable: server.writeCapable };
}
function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}
