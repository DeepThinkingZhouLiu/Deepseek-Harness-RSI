# ACE and Evo-Bench Evolver baselines

English | [中文](README.zh.md)

This optional component contains ACE and Evo-Bench Single/N1 baseline variants for the
checked-in Cowork-Bench v0.4 contract. It does not alter the main
Controller CLI, recipes, benchmark manifests, or existing experiment configs.

## Layout

- `controller/src/baselines/methods/ace.mjs` implements the ACE lifecycle.
- `controller/src/baselines/methods/evo-bench.mjs` implements the original Cowork adaptation.
- `controller/src/baselines/methods/evo-bench-paper.mjs` implements the EvoBench
  adaptation with fixed H0 Feedback and Selection validation.
- `controller/src/baselines/methods/index.mjs` is the method registry. Adding or
  removing a baseline is localized to this directory and one registry entry.
- `runtime.mjs` reuses the existing MSA Solver, Codex Updater, model gateway,
  mutation policy, and evaluator without registering global side effects.
- `benchmark.mjs` loads the formal manifest and reuses the main Cowork-Bench environment.
- `baselines/prompts.json` and `baselines/sources.json` document the method
  prompts, source projects, and Cowork-specific adaptations.
- `UPSTREAM_COMPARISON.zh.md` records the source audit and fair-comparison limits.

ACE follows Generator → Reflector → retry on failure → Curator → post-curation
Generator. Its appended playbook is the only evolving Solver state. The serial
Curator supports ADD operations and the Controller maintains bullet counters.
`feedbackConcurrency` can enable deterministic parallel minibatches; its default
is 1. The separate `ace-batched` variant reuses H0 Feedback across playbook updates.

The original Cowork adaptation receives the latest complete Feedback pass plus
cumulative structured history, proposes one executable harness revision per
candidate, and retains the best Selection checkpoint. It remains available as
`evo-bench` for continuity with existing runs.

`evo-bench-paper` collects or reuses the 90-task H0 Feedback evidence once, then
performs four sequential harness updates. H0 and each updated candidate are
validated on the same 30 Selection tasks. Each updater receives the fixed H0
evidence and cumulative validation history. The current revision continues after
regressions while the best validation checkpoint is retained for the 60-task Final.

The checked-in experiment allows 1000 updater requests and 48 hours. Validation
uses up to 4 concurrent tasks for H0 and the first candidate, then up to 30 for
later candidates, subject to the configured infrastructure limit. The MSA Solver,
Cowork evaluator, and per-candidate Codex sessions adapt the upstream roles; the
upstream persistent evolver session and asynchronous tool interface are not implemented.

## Commands

From the repository root:

```bash
node scripts/run-cowork-baseline.mjs check \
  --experiment experiments/cowork-benchmark-ace-single.json

node scripts/run-cowork-baseline.mjs run \
  --experiment experiments/cowork-benchmark-ace-single.json \
  --run-id ace-single-001
```

Use `preflight` before a paid run and `final` only after the run has frozen its
champion. For the fixed-feedback EvoBench adaptation use
`experiments/cowork-bench-native-90-30-60-evo-bench-paper-agentbay.json`.

An H0 Feedback pass from a completed baseline run can be reused when its
benchmark, source, seed, model, and H0 are identical:

```bash
node scripts/run-cowork-baseline.mjs run \
  --experiment experiments/cowork-bench-native-90-30-60-evo-bench-paper-agentbay.json \
  --run-id evobench-paper-reuse-001 \
  --reuse-h0-feedback .rsi/baselines/<source-run>/partition-results/h0-feedback.jsonl
```

With `evo-bench-paper`, evolved candidates run on Selection; the initial Feedback
is not repeated. The legacy `evo-bench` method still refreshes the full Feedback pass.

To make a legacy baseline run's H0 Feedback and Selection available to GRHS,
create a baseline pack with explicit source and destination paths:

```bash
node scripts/import-legacy-baseline-pack.mjs \
  --experiment experiments/<grhs-config>.json \
  --state .rsi/runs/populations/<grhs-run>/branches/branch-001/run/state.json \
  --source-run .rsi/baselines/<source-run> \
  --output .rsi/baseline-packs/<pack-id>.json
```

Set `baselinePack` in the GRHS experiment to the resulting path. The importer
reads `partition-results/h0-feedback.jsonl` and `h0-selection.jsonl`; its destination
must be a new file. Run-specific paths and results stay outside tracked configuration.

Tests do not call a model or run a paid experiment:

```bash
node --test controller/test/cowork-baselines.test.mjs
```

Runs use the same `RSI_COWORK_BENCH_DATASET_ROOT` and
`RSI_COWORK_BENCH_EVALUATOR_ROOT` settings as the main experiments.
`scripts/smoke-cowork-benchmark.mjs` checks one native verifier with an empty
submission and does not call a model.
