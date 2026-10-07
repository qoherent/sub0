# @subzero/pi

Pi extension package that starts the local `@subzero/runtime` MCP server for the active workspace. It exposes the runtime's `subzero_info`, `subzero_spawn`, `subzero_get`, `subzero_list`, `subzero_send`, `subzero_stop`, `subzero_resume`, and `subzero_output` tools directly to Pi.

Build the workspace, then load the built extension directly:

```sh
npm ci
npm run build
pi --extension /absolute/path/to/subzero/packages/pi/dist/index.js
```

The local package can also be registered with `pi install /absolute/path/to/subzero/packages/pi` after the workspace dependencies are installed. This package is not published to npm.

The extension uses the Node executable running Pi. Set `SUBZERO_NODE` to a Node 24.15+ executable when Pi itself runs on an older Node version. `SUBZERO_DATA_DIR` and `SUBZERO_CONFIG` optionally select the runtime data directory and JSON config file; otherwise the runtime uses its platform default and `<data-dir>/config.json`.

Runtime config stores credential references, not keys. For example:

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

Set `SUBZERO_LONGCAT_KEY` in Pi's environment. The runtime resolves that reference in memory when a child is spawned. The Pi extension passes only the workspace and optional config paths to the runtime process.

Pi exposes the MCP calls under names such as `mcp__subzero__subzero_spawn` and `mcp__subzero__subzero_get`.
