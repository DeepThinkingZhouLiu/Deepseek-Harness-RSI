#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 <ace-run-id> <grhs-run-id> <evo-bench-run-id> [interval-seconds]" >&2
  exit 2
fi

ace_run_id="$1"
grhs_run_id="$2"
evo_run_id="$3"
interval_seconds="${4:-3600}"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

if [[ ! "$interval_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid interval: $interval_seconds" >&2
  exit 2
fi

monitor_root=".rsi/monitor/${ace_run_id}-queue"
mkdir -p "$monitor_root"
status_log="$monitor_root/status.log"

baseline_status() {
  local method="$1"
  local run_id="$2"
  local run_root=".rsi/baselines/$run_id"
  local committed=0
  local phase="queued"
  if [[ -d "$run_root" ]]; then
    committed="$(find "$run_root" -type f -name committed-result.json 2>/dev/null | wc -l)"
    phase="run"
    [[ -f "$run_root/frozen.json" ]] && phase="frozen"
    [[ -f "$run_root/final-report.json" ]] && phase="final"
    if find "$run_root/cross-final" -type f -name cross-final-report.json -print -quit \
        2>/dev/null | grep -q .; then
      phase="completed"
    fi
  fi
  printf '%s phase=%s committed=%s' "$method" "$phase" "$committed"
}

grhs_status() {
  local run_root=".rsi/runs/populations/$grhs_run_id"
  if [[ ! -f "$run_root/public/state.json" ]]; then
    printf 'grhs phase=queued'
    return
  fi
  node -e '
    const state = require(`./${process.argv[1]}/public/state.json`)
    process.stdout.write(`grhs phase=${state.status} final=${state.final?.evaluated === true}`)
  ' "$run_root"
}

while true; do
  {
    printf '%s ' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    baseline_status ace "$ace_run_id"
    printf ' '
    grhs_status
    printf ' '
    baseline_status evo-bench "$evo_run_id"
    printf ' solver_leases=%s updater_leases=%s\n' \
      "$(find .rsi/global-concurrency/solver -type f -name owner.json 2>/dev/null | wc -l)" \
      "$(find .rsi/global-concurrency/updater -type f -name owner.json 2>/dev/null | wc -l)"
  } >>"$status_log"

  evo_root=".rsi/baselines/$evo_run_id"
  if [[ -f "$evo_root/final-report.json" ]] \
      && find "$evo_root/cross-final" -type f -name cross-final-report.json -print -quit \
        2>/dev/null | grep -q .; then
    exit 0
  fi
  sleep "$interval_seconds"
done
