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
