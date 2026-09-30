# Draft: libfx SDK + custom configured provider → `stopReason: "refused"` after successful stream

> Ready to file at github.com/vercel-labs/fx/issues. Repro verified on libfx@0.0.11
> (Node 24, Debian bookworm container, offline mock). Same environment works via
> `fx ask` CLI and native `fx acp`. Checked for duplicates: none found (nearest:
> #160 host-configured providers for libfx — feature request; #514 gateway finish-reason).

## Summary
`createFxAgent()` from `libfx` streams assistant content normally, then ends the turn
with `stopReason: "refused"` and empty `usage` — but only when the model is served by a
**custom configured provider** (`openai-chat-completions` in `~/.fx/settings.json`).
The identical settings work end-to-end on the `fx ask` CLI and the native `fx acp`
server (`end_turn`, usage settled).

## Repro
1. `~/.fx/settings.json`:
   ```json
   { "provider": "mock", "models": { "mock": "mini" },
     "providers": { "mock": { "protocol": "openai-chat-completions",
       "base_url": "http://127.0.0.1:PORT/v1", "auth": { "type": "none" },
       "model_metadata": { "mini": { "context_window": 262144,
         "max_output_tokens": 8192, "supports_tool_use": true } } } } }
   ```
2. Mock serves standard OpenAI chat-completions SSE (delta → finish stop → usage chunk
   with `choices: []` → `[DONE]`).
3. `createFxAgent({ apiKey: "unused" })` (model omitted; FX_MODEL variants tested too).
4. `agent.prompt("say hi")` → events include `text_delta` (content arrives!), then
   `turn.result` = `{ stopReason: "refused", usage: {} }`.

## Tried, did not matter
Model arg present/absent (`mock/mini`, `mock-mini`, `mini`), `permission_mode`
yolo/auto/ask, `onPermission` auto-accept, usage-chunk placement/shape,
settings-only model selection (no `FX_MODEL`).

## Controls (same settings, same mock)
- `fx ask --json "hi"` → `{"output":"hello from mock","exit_code":0}` ✓
- `fx acp` + `session/new` + `session/prompt` → `{"stopReason":"end_turn","usage":{...}}` ✓
- libfx → gateway-only path (no custom provider): works (separately verified).

## Expectation
libfx turns against configured providers should complete `end_turn` with settled
usage, matching CLI/ACP behavior — or return a diagnostic instead of the generic
`refused`.

Notes: observed on the N-API native backend (`getBackendInfo()` → native);
`fxSdkApiVersion` 2. Happy to share the full repro scripts (mock server + driver).
