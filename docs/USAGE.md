# Local usage

Subzero is a private npm workspace. It is not published to npm. The runtime is one local MCP stdio process; the Pi package registers that same server from a Pi extension.

## Build the workspace

Use Node.js 24.15 or newer. From the repository root:

```sh
npm ci
npm run verify
```

To start Pi with the built extension, use an absolute path:

```sh
pi -e /absolute/path/to/subzero/packages/pi/dist/index.js
```

To run the optional real Pi-to-child LongCat check, put `OPENCODE_API_KEY` in the repository-root `.env` file and run `npm run test:live`. Node loads the ignored file for this command; the ordinary `npm test` and `npm run verify` commands remain offline. The live check defaults the child credential to the parent key and accepts `SUBZERO_TEST_KEY` as an optional override. See [TESTING.md](TESTING.md#live-longcat-check) for the complete reproducible setup and platform limits.

Pi uses its own Node executable by default. Set `SUBZERO_NODE` to a Node 24.15+ executable if Pi runs under an older Node version. `SUBZERO_DATA_DIR` selects the runtime data directory and `SUBZERO_CONFIG` selects the JSON config file. Without overrides, the runtime uses its platform data directory and `<data-dir>/config.json`.

The runtime can also be registered directly with another MCP host. Run `node packages/runtime/dist/cli.js --help` for the CLI defaults. The supported options are `--workspace PATH`, `--data-dir PATH`, and `--config PATH`; workspace defaults to the current directory.

## Configure a credential reference

Create the runtime config file, for example `/absolute/userdata/config.json`:

```json
{
  "credentialRefs": {
    "longcat": {
      "env": "SUBZERO_LONGCAT_KEY",
      "origins": ["https://opencode.ai"]
    }
  }
}
```

Set `SUBZERO_LONGCAT_KEY` in the environment inherited by the MCP server. The config contains the environment-variable name, never the key. The runtime resolves the value in memory only for URLs whose origin is listed. Use an origin such as `https://opencode.ai`, without a path. Config accepts `credentialRefs` and an optional `templatesFile`; a raw `key` field is rejected.

Model URLs are stored as metadata and must not contain secrets. The runtime rejects the configured credential in a URL, including URL-encoded forms, while retaining ordinary query parameters. This guard applies to runtime credential references; native core callers supply their own non-secret metadata.

The model object passed to Subzero contains `url`, `model`, and `credentialRef`; `api` is optional. For example, the tested LongCat endpoint was `https://opencode.ai/zen/go/v1` with model `longcat-2.5-preview-free` and API `openai-completions`. Keep provider values and model names appropriate to your account.

## Call the tools

The MCP server exposes `subzero_info`, `subzero_spawn`, `subzero_get`, `subzero_list`, `subzero_send`, `subzero_stop`, `subzero_resume`, and `subzero_output`. Pi displays names such as `mcp__subzero__subzero_spawn`. The JSON values below are arguments to the named tool.

First inspect the service and its available templates:

Call `subzero_info` with `{}`.

Start a child with an explicit template and credential reference. The host supplies the configured workspace to the server; callers do not pass a `workspaceRoot` to spawn.

```json
{
  "prompt": "Inspect the project and report its main entry points.",
  "templateId": "researcher",
  "model": {
    "url": "https://opencode.ai/zen/go/v1",
    "model": "longcat-2.5-preview-free",
    "api": "openai-completions",
    "credentialRef": "longcat"
  }
}
```

The result includes `childId` and `runId`. Poll by cursor; a response includes bounded events, the next cursor, current state, and an optional result with an `artifactId`:

```json
{"childId":"<childId>","waitMs":10000,"cursor":0}
```

`ready` means the child is idle. A failed or stopped run can also leave it ready, so establish success from the run's `completed` event and result artifact, not the child state alone.

Read the full result in bounded chunks with the artifact ID returned by `get`:

```json
{"artifactId":"<artifactId>","offset":0,"length":4096}
```

Use `subzero_stop` with the active `runId` as `expectedRunId`. A stale run ID is rejected without stopping newer work. A stop can be requested before the worker confirms exit, so inspect the returned status or poll `get` for confirmation:

```json
{"childId":"<childId>","expectedRunId":"<activeRunId>"}
```

After a broker restart, call `subzero_resume` with the child ID and a configured credential reference. Without a message this validates the checkpoint and returns the child ready without starting a run. Then use `subzero_send` with mode `followup` to begin new work. Resume with a message starts a fresh run from the last completed checkpoint; interrupted prompts and tool effects are not replayed automatically.

```json
{"childId":"<childId>","model":{"url":"https://opencode.ai/zen/go/v1","model":"longcat-2.5-preview-free","api":"openai-completions","credentialRef":"longcat"}}
```

To start a new run after a no-message resume, call `subzero_send`:

```json
{"childId":"<childId>","mode":"followup","message":"Continue by checking the test scripts."}
```

## Custom templates

The runtime reads `templates.json` under the data directory by default; set `templatesFile` in config to use another relative path within that directory. The file contains an array of templates. Each template specifies an ID, description, instructions, exact tool grants, skills, and explicit MCP servers/tool names. See the [runtime configuration loader](../packages/runtime/src/config.ts) for input behavior and the [template snapshot schema](../packages/core/schemas/templates.schema.json) for the resolved immutable shape. Config may name skill files under `<data-dir>/skills/`; those files are resolved into the snapshot content.

Example read-only template:

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

Skill entries can name files under `<data-dir>/skills/`; their contents are snapshotted when the child is created. MCP grants identify a command, arguments, environment references, exact allowed tool names, and whether the server is write-capable. Subzero stores an immutable resolved grant snapshot for each child; changing a template does not silently add capabilities to an existing child. Use only worker-supported tool grants; unsupported grants fail before model execution.

## Configure other hosts

These snippets show current configuration syntax from the linked official host documentation. They are setup examples, not Subzero compatibility test results. Replace all absolute paths and inherit `SUBZERO_LONGCAT_KEY` in the host process environment.

### Codex CLI

```toml
[mcp_servers.subzero]
command = "/absolute/path/to/node24"
args = [
  "/absolute/path/to/subzero/packages/runtime/dist/cli.js",
  "--workspace", "/absolute/path/to/project",
  "--data-dir", "/absolute/path/to/userdata"
]
env_vars = ["SUBZERO_LONGCAT_KEY"]
```

[Codex MCP server configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### Claude Code

```json
{
  "mcpServers": {
    "subzero": {
      "type": "stdio",
      "command": "/absolute/path/to/node24",
      "args": [
        "/absolute/path/to/subzero/packages/runtime/dist/cli.js",
        "--workspace", "/absolute/path/to/project",
        "--data-dir", "/absolute/path/to/userdata"
      ],
      "env": {"SUBZERO_LONGCAT_KEY":"${SUBZERO_LONGCAT_KEY}"}
    }
  }
}
```

[Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)

### OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "subzero": {
      "type": "local",
      "command": [
        "/absolute/path/to/node24",
        "/absolute/path/to/subzero/packages/runtime/dist/cli.js",
        "--workspace", "/absolute/path/to/project",
        "--data-dir", "/absolute/path/to/userdata"
      ],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

OpenCode inherits environment variables by default; its documented `{env:NAME}` syntax can be used where explicit environment mapping is needed. This uses the stable `mcp` configuration shape, not the preview `mcp.servers` shape. [OpenCode MCP servers](https://docs.opencode.ai/docs/mcp-servers/)

## Scope and caveats

Children share the configured workspace, and tools run with the operating system authority of the runtime process. Workspace write admission serializes Subzero workers only when brokers use the same data directory/database. It does not constrain host or external writes and does not provide an OS sandbox. Match completion events and artifacts to the requested `runId`; an idle child can still expose the result of an earlier completed run after a later failure or stop. Process-tree exit behavior was verified on Linux for ordinary descendants in the worker process group. Deliberately detached descendants and non-Linux operating systems are unverified.
