#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <ace-pipeline-pid> <ace-run-id> <grhs-run-id>" >&2
  exit 2
fi

watched_pid="$1"
ace_run_id="$2"
grhs_run_id="$3"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

if [[ ! "$watched_pid" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid ACE pipeline pid: $watched_pid" >&2
  exit 2
fi

while kill -0 "$watched_pid" 2>/dev/null; do
  sleep 60
done

ace_root=".rsi/baselines/$ace_run_id"
if [[ ! -f "$ace_root/final-report.json" ]] \
    || ! find "$ace_root/cross-final" -type f -name cross-final-report.json -print -quit \
      2>/dev/null | grep -q .; then
  echo "ACE did not complete native and cross-office final; GRHS handoff cancelled" >&2
  exit 1
fi

exec scripts/run-cowork-evolution-through-cross-final.sh \
  --config experiments/cowork-bench-native-90-30-60-grhs-qwen-single-b4-agentbay.json \
  --run-id "$grhs_run_id" \
  --cross-target experiments/cowork-bench-cross-office-90-30-60-grhs-qwen-single-b4-agentbay.json
