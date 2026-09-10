#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <grhs-handoff-pid> <grhs-run-id> <evo-bench-run-id>" >&2
  exit 2
fi

watched_pid="$1"
grhs_run_id="$2"
evo_run_id="$3"
repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

if [[ ! "$watched_pid" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid GRHS handoff pid: $watched_pid" >&2
  exit 2
fi
if [[ ! "$grhs_run_id" =~ ^[a-z0-9][a-z0-9-]{2,120}$ ]] \
    || [[ ! "$evo_run_id" =~ ^[a-z0-9][a-z0-9-]{2,80}$ ]]; then
  echo "invalid run id" >&2
  exit 2
fi

while kill -0 "$watched_pid" 2>/dev/null; do
  sleep 60
done

grhs_root=".rsi/runs/populations/$grhs_run_id"
node -e '
  const state = require(`./${process.argv[1]}/public/state.json`)
  if (!["CLOSED", "REPORTED"].includes(state.status) || state.final?.evaluated !== true) {
    throw new Error("GRHS did not complete in-domain final")
  }
' "$grhs_root"

mapfile -t cross_states < <(find "$grhs_root/cross-final" -mindepth 2 -maxdepth 2 \
  -type f -name state.json 2>/dev/null | sort)
if [[ ${#cross_states[@]} -eq 0 ]]; then
  echo "GRHS did not produce a cross-final state" >&2
  exit 1
fi
node -e '
  const states = process.argv.slice(1).map((path) => require(`./${path}`))
  if (!states.some((state) => state.status === "completed")) {
    throw new Error("GRHS did not complete cross-office final")
  }
' "${cross_states[@]}"

exec scripts/run-cowork-baseline-through-cross-final.sh \
  --config experiments/cowork-bench-native-90-30-60-evo-bench-qwen-b4-agentbay.json \
  --run-id "$evo_run_id" \
  --cross-target experiments/cowork-bench-cross-office-90-30-60-evo-bench-qwen-b4-agentbay.json
