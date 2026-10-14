# Subzero

Subzero is a local MCP service that lets a coding agent delegate work to persistent child sessions. Each child runs in its own Pi SDK worker process, and its full transcript stays private. The parent observes bounded run snapshots and reads results explicitly, in bounded chunks. Protocol 0.2, package version 0.2.0.

`@subzero/pi` is a thin Pi extension that registers the service for a Pi session. Other MCP-capable agents can launch the same local stdio executable; those host configurations are untested syntax examples.

## Prerequisites

- Node.js 24.15 or newer and npm.
- The latest Pi release only, currently 1.2.0, pinned exactly for the host extension and the runtime worker. No older Pi version is supported.

## Quickstart

```sh
# Clone and build
npm ci
npm run verify

# Run Pi with the Subzero extension
pi -e /absolute/path/to/subzero/packages/pi/dist/index.js
```

Configure credential references and model values as described in [docs/USAGE.md](docs/USAGE.md). The opt-in real-provider check and its dotenv handling are in [docs/TESTING.md](docs/TESTING.md).

## Packages

- `packages/core`: language-neutral JSON Schemas, conformance fixtures and the dependency-free TypeScript orchestration core. See [its README](packages/core/README.md).
- `packages/runtime`: local MCP stdio server, SQLite metadata store, credential-reference resolver, artifact storage and the Pi SDK worker adapter. See [its README](packages/runtime/README.md).
- `packages/pi`: the Pi extension that registers the runtime and adds bounded parent guidance. See [its README](packages/pi/README.md).

## Documentation

- [Design](docs/DESIGN.md): architecture and behavior contract.
- [Usage](docs/USAGE.md): setup, configuration and the tool workflow.
- [Testing](docs/TESTING.md): current verification commands and limits.
- [Handoff](docs/HANDOFF.md): continuity notes for the next session.
- [Vision](vision.md): product intent.
- [Documentation index](docs/README.md), including retained historical evidence.

Children share the workspace and run with the launching user's operating system authority. Subzero is not a sandbox.
