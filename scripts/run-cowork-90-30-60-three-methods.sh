#!/usr/bin/env bash
set -euo pipefail

run_prefix="${1:-cowork-90-30-60-$(date -u +%Y%m%d-%H%M%S)}"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"
mkdir -p .rsi/launch-logs

# One shared limiter lets GRHS use spare capacity while preventing the three
# controllers from oversubscribing the provider or AgentBay control plane.
export RSI_GLOBAL_CONCURRENCY_ROOT="${RSI_GLOBAL_CONCURRENCY_ROOT:-$repository_root/.rsi/global-concurrency}"
export RSI_GLOBAL_SOLVER_CONCURRENCY="${RSI_GLOBAL_SOLVER_CONCURRENCY:-16}"
export RSI_GLOBAL_UPDATER_CONCURRENCY="${RSI_GLOBAL_UPDATER_CONCURRENCY:-6}"

start_baseline() {
  local method="$1"
  scripts/run-cowork-baseline-through-cross-final.sh \
    --config "experiments/cowork-bench-native-90-30-60-${method}-b4-agentbay.json" \
    --run-id "${run_prefix}-${method}" \
    --cross-target "experiments/cowork-bench-cross-office-90-30-60-${method}-b4-agentbay.json"
}

# Stagger provisioning so the first baseline proves the shared runtime before
# GRHS and the second baseline add load. All three then continue concurrently.
start_baseline ace >".rsi/launch-logs/${run_prefix}-ace.log" 2>&1 &
ace_pid=$!
sleep 20
scripts/run-cowork-grhs-90-30-60-full.sh "${run_prefix}-grhs" \
  >".rsi/launch-logs/${run_prefix}-grhs.log" 2>&1 &
grhs_pid=$!
sleep 20
start_baseline evo-bench >".rsi/launch-logs/${run_prefix}-evo-bench.log" 2>&1 &
evo_pid=$!

status=0
for pid in "$ace_pid" "$grhs_pid" "$evo_pid"; do
  wait "$pid" || status=1
done
exit "$status"
