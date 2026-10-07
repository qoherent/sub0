# Pi SDK and SQLite qualification

This folder contains the current source and receipts for the Pi SDK 1.0.4 worker probe and Node SQLite smoke. The probe qualifies the selected worker seam and storage API; it does not by itself qualify Subzero packages, a host adapter, or a published release. Current end-to-end and local gate evidence is in [testing evidence](../../docs/TESTING.md).

- `qualification.mjs` is the behavior probe source; `probe-result.json` is its recorded result.
- `sqlite-smoke.mjs` is the file-backed WAL and close/reopen smoke source; `sqlite-result.json` is its recorded result.
- `package.json` and `package-lock.json` pin the experiment dependencies.

The probe uses a synthetic local model endpoint and does not make an actual LLM call. Reproduce from this directory with `npm ci` followed by `node qualification.mjs` and `node sqlite-smoke.mjs`. Installed dependencies are generated locally and are ignored by the repository.
