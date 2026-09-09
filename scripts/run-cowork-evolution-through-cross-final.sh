#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --config <source-experiment.json> --run-id <population-id> --cross-target <target-experiment.json> [--cross-target ...]"
}

source_config=""
population_id=""
cross_targets=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) source_config="$2"; shift 2 ;;
    --run-id) population_id="$2"; shift 2 ;;
    --cross-target) cross_targets+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$source_config" || -z "$population_id" || ${#cross_targets[@]} -eq 0 ]]; then
  usage >&2
  exit 2
fi

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"
cli=(node controller/src/cli.mjs)
population_root=".rsi/runs/populations/$population_id"

read_state() {
  node -e "const s=require('./$population_root/public/state.json'); process.stdout.write(String($1))"
}

if [[ ! -f "$population_root/public/state.json" ]]; then
  "${cli[@]}" experiment run --config "$source_config" --run-id "$population_id"
else
  population_status="$(read_state 's.status')"
  if [[ "$population_status" != "CLOSED" && "$population_status" != "REPORTED" ]]; then
    "${cli[@]}" experiment resume --run "$population_root" --recover-interrupted
  fi
fi

final_evaluated="$(read_state 's.final?.evaluated === true')"
if [[ "$final_evaluated" != "true" ]]; then
  final_started="$(read_state 'Boolean(s.final?.startedAt)')"
  if [[ "$final_started" == "true" ]]; then
    "${cli[@]}" experiment finalize --run "$population_root" --resume-final
  else
    "${cli[@]}" experiment finalize --run "$population_root"
  fi
fi

# 每个目标格式独占一个新 AgentBay session；多个 cross-final 同时运行。
unset HARNESS_RSI_AGENTBAY_EXISTING_SESSION_ID
cross_pids=()
for target_config in "${cross_targets[@]}"; do
  target_name="$(basename "$target_config" .json | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
  cross_run_id="${population_id}-to-${target_name}"
  if (( ${#cross_run_id} > 120 )); then
    cross_run_id="cross-${population_id:0:72}-to-${target_name:0:38}"
  fi
  "${cli[@]}" experiment cross-final \
    --source-run "$population_root" \
    --target-config "$target_config" \
    --run-id "$cross_run_id" &
  cross_pids+=("$!")
done

cross_status=0
for cross_pid in "${cross_pids[@]}"; do
  wait "$cross_pid" || cross_status=1
done
exit "$cross_status"
