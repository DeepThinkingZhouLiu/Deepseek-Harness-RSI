# Cowork 90-task H0 Feedback snapshot

This snapshot was produced by run
`cowork-90-30-60-v04-20260910-09-grhs-qwen`, branch `branch-001`, with
Qwen3.8-Max and seed `20260910`.

- `h0-feedback.jsonl` contains the 90 task-level Feedback records in benchmark
  order, including reward, task instruction, solver answer, verifier feedback,
  latency, and artifact metadata.
- `h0-selection.jsonl` contains the 30 task-level H0 Selection records in
  benchmark order. GRHS experiments with the same frozen evaluation identity
  can reuse these records instead of reevaluating H0 on Selection.
- `feedback-packet.json` is the packet consumed by the first GRHS updater wave.
- `.rsi/baseline-packs/cowork-90-feedback-grhs-qwen.json` is the canonical
  portable BaselinePack. Experiments with an identical H0, benchmark, solver,
  environment, evaluation policy, and seed can reference it to reuse the H0
  Selection and all 90 H0 Feedback records without rerunning Solver tasks.

## Scores

- Feedback cases: 90
- Reward sum: 16.421490333333335
- Mean Feedback reward: 0.18246100370370372
- Positive rewards: 34
- Zero rewards: 56
- Perfect rewards: 7
- Minimum / median / maximum: 0 / 0 / 1
- H0 Selection mean reward: 0.36054733333333344 over 30 cases
- H0 Selection reward sum: 10.816420000000003
- H0 Selection positive / zero / perfect rewards: 14 / 16 / 4

The task-level scores are the `reward` field of each JSONL row. For direct
Controller reuse, reference the BaselinePack; the two JSONL files are the
portable task-level records used to inspect and reproduce that pack.
