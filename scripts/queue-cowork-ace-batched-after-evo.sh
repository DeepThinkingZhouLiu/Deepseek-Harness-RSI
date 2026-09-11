#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <evo-pipeline-pid> <ace-batched-run-id>" >&2
  exit 2
fi

watched_pid="$1"
run_id="$2"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

if [[ ! "$watched_pid" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid Evo pipeline pid: $watched_pid" >&2
  exit 2
fi

while kill -0 "$watched_pid" 2>/dev/null; do
  sleep 60
done

exec scripts/run-cowork-baseline-through-cross-final.sh \
  --config experiments/cowork-bench-native-90-30-60-ace-batched-qwen-b4-agentbay.json \
  --run-id "$run_id" \
  --cross-target experiments/cowork-bench-cross-office-90-30-60-ace-batched-qwen-b4-agentbay.json
