# Usage

Subzero is a private npm workspace and is not published to npm. The runtime is one local MCP stdio process; the Pi package registers that same server from a Pi extension. Only the latest Pi release is supported, currently 1.2.0.

## Build and load

Use Node.js 24.15 or newer. From the repository root:

```sh
npm ci
npm run verify
```

Start Pi with the built extension, using an absolute path:

```sh
pi -e /absolute/path/to/subzero/packages/pi/dist/index.js
```

Pi uses its own Node executable by default. Set `SUBZERO_NODE` to a Node 24.15+ executable if Pi runs under an older Node. `SUBZERO_DATA_DIR` selects the runtime data directory and `SUBZERO_CONFIG` the JSON config file; otherwise the runtime uses its platform data directory and `<data-dir>/config.json`.

The runtime can also be launched directly: `node packages/runtime/dist/cli.js --help` prints the defaults. Options are `--workspace PATH` (default: current directory), `--data-dir PATH` and `--config PATH`.

## Configure a credential reference

Create the runtime config file, for example `/absolute/userdata/config.json`:

```json
{
  "mcpRequestBudgetMs": 25000,
  "credentialRefs": {
    "longcat": {
      "env": "SUBZERO_LONGCAT_KEY",
      "origins": ["https://opencode.ai"]
    }
  }
}
```

Set `SUBZERO_LONGCAT_KEY` in the environment inherited by the MCP server. The config holds the variable name, never the key, and a raw `key` field is rejected. The runtime resolves the value in memory only for model URLs whose origin is listed (an origin without a path). It rejects the configured credential inside a URL, including URL-encoded forms.

Config also accepts optional `templatesFile` and `mcpRequestBudgetMs` (default 30000, a positive integer up to 2147483647). Keep the budget below the host's request timeout with margin for the response. It bounds request work, not worker execution.

The model object passed to a tool has `url`, `model` and `credentialRef`, plus optional `api` (default `openai-completions`). The values below are documented configured examples; use values appropriate to your account.

## Tool workflow

The nine tools are `subzero_info`, `subzero_spawn`, `subzero_run`, `subzero_get`, `subzero_list`, `subzero_send`, `subzero_stop`, `subzero_resume` and `subzero_output`. Pi shows them as `mcp__subzero__subzero_run` and so on. The workspace comes from the server configuration; callers pass no `workspaceRoot`.

1. Discover with `subzero_info` and `{}`: it returns protocol and core versions, worker name, version and capabilities, templates, configured credential references and limits.
2. Dispatch with `subzero_run`; it waits up to `waitMs` (default 30000) and returns a compact snapshot of that exact run.

```json
{
  "prompt": "Inspect the project and report its main entry points.",
  "templateId": "researcher",
  "model": {
    "url": "https://opencode.ai/zen/go/v1",
    "model": "longcat-2.5-preview-free",
    "api": "openai-completions",
    "credentialRef": "longcat"
  },
  "waitMs": 30000
}
```

The snapshot has `childId`, `runId`, `status`, `waitExpired`, and a result or `errorCode` when available. A completed status with an artifact shows execution finished. Accept the delegated task only after inspecting the requested effect against your acceptance checks.

3. If the run is unsettled, observe only that run with the same IDs. Run-specific `subzero_get` waits zero by default, so pass a bounded `waitMs`. Never redispatch because a wait expired.

```json
{"childId":"<childId>","runId":"<runId>","waitMs":10000}
```

4. Read more of a result only in bounded chunks with `subzero_output`:

```json
{"artifactId":"<artifactId>","offset":0,"length":4096}
```

5. Stop with `subzero_stop` and the active run as `expectedRunId`. A stale ID is rejected without effect; `confirmed` becomes true only after cleanup is proven. A request timeout or abort only detaches observation and does not stop the run.

```json
{"childId":"<childId>","expectedRunId":"<activeRunId>"}
```

6. After a broker restart, call `subzero_resume` with the child ID and a configured credential reference. Without a message it validates the checkpoint and returns the child ready; start new work with `subzero_send` using mode `followup`. Interrupted prompts and effects are not replayed.

```json
{"childId":"<childId>","model":{"url":"https://opencode.ai/zen/go/v1","model":"longcat-2.5-preview-free","api":"openai-completions","credentialRef":"longcat"}}
```

Child-only `subzero_get` (no `runId`) shows child state and a bounded event batch with a `cursor`; its latest child result can belong to an earlier run, so match results to the `runId` you asked for. Worker text is not stored as per-token event rows.

In Pi `codemode`, MCP calls resolve to result objects even on handled errors: check `isError` before reading `structuredContent`. Nothing here promises a background wakeup of the parent.

## Custom templates

The runtime reads `templates.json` under the data directory by default; `templatesFile` selects another relative path inside it. The file is an array of templates with an ID, description, instructions, exact tool grants, skills and explicit MCP servers with their allowed tool names. Skill files come from `<data-dir>/skills/` and their contents are snapshotted when the child is created. See the [config loader](../packages/runtime/src/config.ts) and the [template schema](../packages/core/schemas/templates.schema.json). Example read-only template:

```json
[
  {
    "id": "reviewer",
    "description": "Review a change using read-only workspace tools.",
    "instructions": "Review the requested change and report evidence.",
    "tools": [
      {"name":"read","writable":false},
      {"name":"grep","writable":false},
      {"name":"find","writable":false},
      {"name":"ls","writable":false}
    ],
    "skills": [],
    "mcpServers": [],
    "writeCapable": false
  }
]
```

Each child stores an immutable resolved grant snapshot; changing a template never adds capabilities to an existing child. Unsupported grants fail before model execution.

## Other hosts (untested)

Codex CLI, Claude Code and OpenCode can launch the same executable: `node /absolute/path/to/subzero/packages/runtime/dist/cli.js --workspace /absolute/path/to/project --data-dir /absolute/path/to/userdata`, with `SUBZERO_LONGCAT_KEY` in the host's environment. Their configuration syntax is in the official docs: [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code](https://code.claude.com/docs/en/mcp), [OpenCode](https://docs.opencode.ai/docs/mcp-servers/). These integrations have not been tested here.

## Scope

Children share the configured workspace and run with the operating system authority of the runtime process. Write admission serializes Subzero workers only among brokers using the same data directory; it does not constrain the host or other writers and is not an OS sandbox. Process-tree exit was verified on Linux for ordinary descendants; deliberately detached descendants and other operating systems are unverified.
