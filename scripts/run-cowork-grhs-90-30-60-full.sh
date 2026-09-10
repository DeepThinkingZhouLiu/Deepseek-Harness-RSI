#!/usr/bin/env bash
set -euo pipefail

run_id="${1:-cowork-grhs-90-30-60-$(date -u +%Y%m%d-%H%M%S)}"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

scripts/run-cowork-evolution-through-cross-final.sh \
  --config experiments/cowork-bench-native-90-30-60-grhs-claude-single-b4-agentbay.json \
  --run-id "$run_id" \
  --cross-target experiments/cowork-bench-cross-office-90-30-60-grhs-claude-single-b4-agentbay.json
