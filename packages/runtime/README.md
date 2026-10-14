# @subzero/runtime

The local MCP stdio server for Subzero. It assembles the core, SQLite metadata store, local result artifacts, credential-reference resolver, and Pi SDK worker. This package is part of the private workspace and is not published to npm.

Build from the repository root with `npm ci` and `npm run build`. Start the compiled server with Node 24.15 or newer:

```sh
node packages/runtime/dist/cli.js \
  --workspace /absolute/path/to/project \
  --data-dir /absolute/path/to/userdata \
  --config /absolute/path/to/userdata/config.json
```

The server speaks MCP over stdio. Omit `--config` to use `<data-dir>/config.json`; omit `--data-dir` to use the platform user data location. Options are `--workspace`, `--data-dir`, and `--config`. `node packages/runtime/dist/cli.js --help` prints the same defaults.

Configure only credential references in the JSON config; set the corresponding key environment variable in the server's environment. See [local usage](../../docs/USAGE.md) for credential setup, tool examples, host configuration, and capability limits.

The server registers nine MCP tools, including `subzero_run` and run-specific `subzero_get`. Their default wait windows are 30 seconds for `run` and zero for `get`; each response remains bounded. Runtime config accepts optional `mcpRequestBudgetMs`, a positive integer no greater than `2147483647` (default `30000`). Set it below the host's request timeout with margin for the response. It limits server request work and does not time out worker execution. A request timeout or abort detaches observation; explicit `subzero_stop` is the cancellation operation.
