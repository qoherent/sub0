# @subzero/pi

Pi extension package that starts the local `@subzero/runtime` MCP server for the active workspace. It exposes the runtime's nine tools: `subzero_info`, `subzero_spawn`, `subzero_run`, `subzero_get`, `subzero_list`, `subzero_send`, `subzero_stop`, `subzero_resume`, and `subzero_output`.

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

Prefer `subzero_run` for a bounded dispatch and wait. If it returns an unsettled snapshot, call run-specific `subzero_get` with the returned `childId` and `runId`; its default wait is zero. Neither operation promises a background Pi wakeup. Request output chunks explicitly with `subzero_output` when the compact artifact preview is insufficient.

## Parent guidance

While the Subzero MCP server is registered, the extension adds one static, bounded (at most 2048 bytes) `subzero_delegation` section to the parent's system prompt through Pi's `before_agent_start` event. It covers template and credential discovery, exact-run continuation, acceptance evidence, bounded output and explicit stop. It says to honor explicit `credentialRef` values and never pass raw keys, to continue an unsettled run with `subzero_get` using the same `childId` and `runId`, to inspect the requested effect and matching completed result before accepting success, and that explicit `subzero_stop` needs the active run as `expectedRunId`. It contains no keys, paths, run IDs or child text and is not sent to children. Before registration and after shutdown no guide is added.

The hook sets only its own named section, so it composes with other sections. An extension that forces an opaque system prompt can omit it. Pi 1.2.0 routes custom-triggered runs through the same before_agent_start hook; this handler does not assume a user prompt. Custom-triggered runtime runs are not yet part of this integration qualification.

When calling these tools from Pi's `codemode`, each call resolves to an MCP result object even when the tool reports a handled error. Check `isError` before reading `structuredContent`; a completed transport call is separate from the child run status. `codemode.mode` is the user's choice and is never changed by this package. With `on`, the direct MCP declarations remain; with `only`, codemode only hides callable direct tool declarations so scripts reach them through `codemode`; model-only tools can remain declared. Neither mode promises zero schema tokens or a background wakeup.

Only the latest Pi release is supported, currently 1.2.0, pinned exactly as the host dev and peer dependency and in the runtime worker; upgrades re-pin exactly rather than float, and no older-version lane or shim is kept. Stored sessions from prior SDKs are refused and preserved, not deleted or auto-migrated; start a new child on the latest runtime. This qualification covers Linux with Pi's controlled print/JSON mode and loopback providers. It does not cover the TUI, RPC, reload or new real-provider runs. The separate experimental [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/README.md) package (see its [spec](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/docs/spec.md)) is only a concept source for owned foreground and background tasks, requestId deduplication (which is not exactly-once effects) and safe versus unsafe replay. No pi-durable runtime or second scheduler is added.
