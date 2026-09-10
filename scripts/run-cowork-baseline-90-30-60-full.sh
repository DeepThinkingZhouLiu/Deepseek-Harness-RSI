#!/usr/bin/env bash
set -euo pipefail

run_prefix="${1:-cowork-baseline-90-30-60-$(date -u +%Y%m%d-%H%M%S)}"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

pids=()
for method in ace evo-bench; do
  scripts/run-cowork-baseline-through-cross-final.sh \
    --config "experiments/cowork-bench-native-90-30-60-${method}-b4-agentbay.json" \
    --run-id "${run_prefix}-${method}" \
    --cross-target "experiments/cowork-bench-cross-office-90-30-60-${method}-b4-agentbay.json" &
  pids+=("$!")
done

status=0
for pid in "${pids[@]}"; do
  wait "$pid" || status=1
done
exit "$status"
