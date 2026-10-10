#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
  exit 0
fi
pkill -f "python server.py" 2>/dev/null || true
nohup python server.py --host 0.0.0.0 --port 8000 >/tmp/pixel-word-farm.log 2>&1 &
sleep 1
curl -fsS http://127.0.0.1:8000/api/health >/dev/null
