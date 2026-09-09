# ACE and Evo-Bench Evolver baselines

English | [中文](README.zh.md)

This optional component contains two Single/N1 baseline methods for the
checked-in Cowork-Bench v0.2 contract. It does not alter the main
Controller CLI, recipes, benchmark manifests, or existing experiment configs.

## Layout

- `controller/src/baselines/methods/ace.mjs` implements the ACE lifecycle.
- `controller/src/baselines/methods/evo-bench.mjs` implements the Evolver lifecycle.
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

Evo-Bench Evolver receives the latest complete Feedback pass plus cumulative structured history, proposes one executable
harness revision per candidate, and continues from the latest valid revision
after regressions. The Controller separately retains the best Selection
checkpoint for Final evaluation.
Its precise name is **Evo-Bench Evolver (Cowork/Codex adaptation)**; it is not
a line-for-line reproduction of the upstream persistent-session runner.

Both methods use detailed Feedback, aggregate-only Selection, and sealed Final.
They share the checked-in B16 budget and model settings, but are launched only
through their dedicated script.

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
champion. Replace the experiment path for Evo-Bench Evolver.

Tests do not call a model or run a paid experiment:

```bash
node --test controller/test/cowork-baselines.test.mjs
```

Runs use the same `RSI_COWORK_BENCH_DATASET_ROOT` and
`RSI_COWORK_BENCH_EVALUATOR_ROOT` settings as the main experiments.
`scripts/smoke-cowork-benchmark.mjs` checks one native verifier with an empty
submission and does not call a model.
