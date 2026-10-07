# Subzero

Subzero is a local MCP service that lets coding agents spawn and control persistent subagents. Children run in Pi SDK workers; the parent agent keeps its own conversation. `@subzero/pi` is a thin plugin that connects Pi to the service. Other MCP-capable coding agents configure the same server executable.

## Status

The v0.1 TypeScript implementation is in this checkout; its npm packages remain private and unpublished. Build, typecheck, and all 90 tests pass on Node 24.21.0/Linux. Real LongCat delegation through Pi and MCP passed, as did package installation, the installed CLI, and MCP discovery. Pi 1.0.4 is the only host integration exercised; Codex, Claude Code, and OpenCode setup syntax is documented but not host-tested. See [testing evidence](docs/TESTING.md) for scope and [usage](docs/USAGE.md) for setup and tool examples.

## Try it locally

Requirements: Node.js 24.15 or newer and a compatible Pi installation for the extension. From this checkout:

```sh
npm ci
npm run verify
pi -e /absolute/path/to/subzero/packages/pi/dist/index.js
```

`npm run verify` builds all packages, typechecks the workspace, and runs the local test suite. The final command starts Pi with the Subzero extension; configure a model credential reference before spawning a child. The packages are not yet published to npm. See [docs/USAGE.md](docs/USAGE.md).

## What it does

- Provides `subzero_info`, `subzero_spawn`, `subzero_get`, `subzero_list`, `subzero_send`, `subzero_stop`, `subzero_resume`, and `subzero_output` over one local MCP stdio server.
- Keeps child identity, run state, queues, events, and checkpoint references in SQLite. A worker process runs only while a child has active or queued work.
- Requires explicit template grants and configured credential references. A child does not inherit tools, skills, MCP servers, or provider credentials from its host.
- Stores full results as local artifacts and returns bounded previews and event batches.

## Boundaries

Children share the selected checkout. Write admission serializes Subzero workers; it does not control the host or other processes and is not an OS sandbox. Linux process-group cleanup was exercised for ordinary POSIX descendants. A process that deliberately detaches into a new session is outside that guarantee, and other operating systems remain untested.

The selected design and public contract are in [docs/DESIGN.md](docs/DESIGN.md); the implementation status is in [docs/PLAN.md](docs/PLAN.md). The JSON Schemas and conformance fixtures are under [packages/core/schemas](packages/core/schemas) and [packages/core/conformance](packages/core/conformance).

## Repository layout

- `packages/` contains the core contract, runtime MCP server, worker, and Pi extension.
- `experiments/pi-sdk/` contains the current Pi SDK and SQLite qualification sources and receipts.
- `docs/` contains usage, test evidence, the reference design, implementation record, and research decisions. [Documentation index](docs/README.md).
- `docs/archive/` contains historical experiments and reproducible source inputs; they are not part of `npm run verify`.

Reference clones, local agent skills, and the Pi technical manual are kept outside this checkout in the sibling `subzero-reference-material/` directory.
