#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$DIR/.env" ]; then
  export OPENCODE_API_KEY="$(grep -m1 '^OPENCODE_API_KEY=' "$DIR/.env" | cut -d= -f2-)"
fi

exec pi -e "$DIR/packages/pi/dist/index.js" --provider opencode-go --model longcat-2.5-preview-free "$@"
