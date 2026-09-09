#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --config <ppt-baseline.json> --run-id <id> --cross-target <baseline.json> [--cross-target ...]"
}

source_config=""
run_id=""
cross_targets=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) source_config="$2"; shift 2 ;;
    --run-id) run_id="$2"; shift 2 ;;
    --cross-target) cross_targets+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$source_config" || -z "$run_id" || ${#cross_targets[@]} -eq 0 ]]; then
  usage >&2
  exit 2
fi

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"
runner=(node scripts/run-cowork-baseline.mjs)
run_root=".rsi/baselines/$run_id"

if [[ ! -f "$run_root/frozen.json" ]]; then
  if [[ -e "$run_root" ]]; then
    echo "incomplete baseline run exists and automatic evolution resume is unavailable: $run_root" >&2
    exit 1
  fi
  "${runner[@]}" run --experiment "$source_config" --run-id "$run_id"
fi

if [[ ! -f "$run_root/final-report.json" ]]; then
  "${runner[@]}" final --experiment "$source_config" --run-id "$run_id"
fi

# Each target gets a separate AgentBay session and checkpointed partition runner.
unset HARNESS_RSI_AGENTBAY_EXISTING_SESSION_ID
cross_pids=()
for target_config in "${cross_targets[@]}"; do
  target_name="$(basename "$target_config" .json | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
  cross_run_id="${run_id}-to-${target_name}"
  if [[ -f "$run_root/cross-final/$cross_run_id/cross-final-report.json" ]]; then
    continue
  fi
  "${runner[@]}" cross-final \
    --experiment "$target_config" \
    --source-run-id "$run_id" \
    --run-id "$cross_run_id" &
  cross_pids+=("$!")
done

cross_status=0
for cross_pid in "${cross_pids[@]}"; do
  wait "$cross_pid" || cross_status=1
done
exit "$cross_status"
