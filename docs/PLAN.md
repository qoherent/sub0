# Subzero v0.1 implementation record

Status: v0.1 TypeScript implementation, local M1–M3 milestones, and audit hardening are complete with all 128 tests passing. The [2026-10-08 audit](AUDIT-2026-10-08.md) records regression fixes, package/CLI/MCP checks, and handoff details. See [reference design](DESIGN.md) for the architecture and [testing evidence](TESTING.md) for test breakdown.

## Completed milestones

- **M1: Core Orchestration & Contract**
  - Language-neutral JSON Schemas and conformance fixtures (`packages/core/schemas/`, `packages/core/conformance/`).
  - `@subzero/core` reference implementation: session/run state machine, followup queues, monotonic event cursors, immutable template snapshots.
  - Zero external dependencies.

- **M2: Runtime, Persistence & Worker Engine**
  - `@subzero/runtime` MCP stdio server CLI.
  - SQLite metadata storage (`node:sqlite`) with atomic transactions and generation guarding.
  - Pi SDK 1.0.4 worker process lifecycle, POSIX process-group containment, control-pipe EOF handling.
  - Stateful secret stream redaction and bounded local result artifacts.

- **M3: Host Integration & Verification**
  - `@subzero/pi` registration extension.
  - Setup configurations for Codex, Claude Code, and OpenCode.
  - Complete 128-test verification gate and opt-in live LongCat integration tests.
