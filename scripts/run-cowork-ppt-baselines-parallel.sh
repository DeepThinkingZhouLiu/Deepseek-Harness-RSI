#!/usr/bin/env bash
set -euo pipefail

run_prefix="${1:-cowork-ppt60-baseline-$(date -u +%Y%m%d-%H%M%S)}"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

unset HARNESS_RSI_AGENTBAY_EXISTING_SESSION_ID

scripts/run-cowork-baseline-through-cross-final.sh \
  --config experiments/cowork-bench-ppt60-ace-single-b4-agentbay.json \
  --run-id "${run_prefix}-ace" \
  --cross-target experiments/cowork-bench-docx60-ace-single-b4-agentbay.json \
  --cross-target experiments/cowork-bench-xlsx60-ace-single-b4-agentbay.json &
ace_pid="$!"

scripts/run-cowork-baseline-through-cross-final.sh \
  --config experiments/cowork-bench-ppt60-evo-bench-single-b4-agentbay.json \
  --run-id "${run_prefix}-evo-bench" \
  --cross-target experiments/cowork-bench-docx60-evo-bench-single-b4-agentbay.json \
  --cross-target experiments/cowork-bench-xlsx60-evo-bench-single-b4-agentbay.json &
evo_pid="$!"

status=0
wait "$ace_pid" || status=1
wait "$evo_pid" || status=1
exit "$status"
