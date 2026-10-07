#!/bin/sh
# Reproduce the refusal with fx's own CLI + trace, mirroring e2e fixture config.
set -x
export HOME=/root
mkdir -p /root/.fx /root/workspace /work
cat > /root/.fx/settings.json <<'EOF'
{
  "provider": "mock",
  "auto_upgrade": false,
  "permission_mode": "ask",
  "providers": {
    "mock": {
      "protocol": "openai-chat-completions",
      "base_url": "BASEURL",
      "auth": { "type": "none" },
      "model_metadata": { "mini": { "context_window": 262144, "max_output_tokens": 8192, "supports_tool_use": true } }
    }
  },
  "models": { "mock": "mini" }
}
EOF
node /work/mock.mjs > /work/mock.log 2>&1 &
sleep 1
PORT=$(head -1 /work/mock.log)
sed -i "s|BASEURL|http://127.0.0.1:${PORT}/v1|" /root/.fx/settings.json
cat /root/.fx/settings.json
FX_TRACE=1 FX_TRACE_STDERR=1 AI_GATEWAY_API_KEY=unused /fx/zig-out/bin/fx ask --json "say hi" 2>/work/trace.log
echo "=== exit: $? ==="
echo "--- trace tail ---"
tail -40 /work/trace.log 2>/dev/null
echo "--- mock saw ---"
cat /work/mock.log
