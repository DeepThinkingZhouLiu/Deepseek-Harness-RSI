#!/usr/bin/env bash
set -euo pipefail

run_prefix="${1:-cowork-baseline-full-$(date -u +%Y%m%d-%H%M%S)}"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

run_domain() {
  local source_domain="$1"
  local target_a="$2"
  local target_b="$3"
  local pids=()

  for method in ace evo-bench; do
    scripts/run-cowork-baseline-through-cross-final.sh \
      --config "experiments/cowork-bench-${source_domain}60-${method}-single-b4-agentbay.json" \
      --run-id "${run_prefix}-${source_domain}-${method}" \
      --cross-target "experiments/cowork-bench-${target_a}60-${method}-single-b4-agentbay.json" \
      --cross-target "experiments/cowork-bench-${target_b}60-${method}-single-b4-agentbay.json" &
    pids+=("$!")
  done

  local status=0
  for pid in "${pids[@]}"; do
    wait "$pid" || status=1
  done
  return "$status"
}

# Keep the two methods parallel while source domains advance in isolated stages.
run_domain ppt docx xlsx
run_domain docx ppt xlsx
run_domain xlsx ppt docx
