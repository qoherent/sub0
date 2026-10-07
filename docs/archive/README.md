# Archived research and Docker repro sources

This directory preserves historical investigations from September 2026. It contains the old host and worker exploration notes and the source inputs used for Docker probes of fx, libfx, and Pi. The archived claims describe those dated probes; consult the current [design decisions](../research/design-decisions.md), [Pi SDK qualification](../../experiments/pi-sdk/README.md), and [verification evidence](../TESTING.md) for the current v0.1 choices and gates.

## Docker sources

- `docker/fx-src/` contains scripts and a Dockerfile for the fx ACP/source probe. Its Docker build context expects an fx source checkout at `fx/` inside that directory. The local reference clone is kept outside the repository; supply a compatible source checkout before building.
- `docker/libfx-play/` contains a Dockerfile that installs `libfx@0.0.11` and the smoke script. It downloads the dependency when built.
- `docker/pi-proof/` contains a Dockerfile that installs `@earendil-works/pi-coding-agent@0.99.1` and runs the lifecycle probe.

These Dockerfiles and scripts are historical reproduction inputs. They are not invoked by `npm run verify`, and their version-specific results do not qualify the current Pi SDK 1.0.4 worker.

Local reference clones, agent skills, the Pi technical manual, and generated experiment artifacts are preserved outside the checkout in the sibling `subzero-reference-material/` directory. They are not needed for the current package tests.
