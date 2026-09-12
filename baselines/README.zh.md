# ACE 与 Evo-Bench Evolver Baseline

[English](README.md) | 中文

这里包含面向仓库内 Cowork-Bench v0.4 的 ACE、Evo-Bench 可选 Single/N1 baseline 变体。
它们不会注册到主 Controller CLI，也不修改现有 recipes、benchmark manifest 或实验配置；
只有显式调用专用运行脚本时才会启用。

## 组件结构

- `controller/src/baselines/methods/ace.mjs`：ACE 方法生命周期。
- `controller/src/baselines/methods/evo-bench.mjs`：原有 Cowork 适配版生命周期。
- `controller/src/baselines/methods/evo-bench-paper.mjs`：固定 H0 Feedback、在 Selection 上 validation 的 EvoBench 适配版。
- `controller/src/baselines/methods/index.mjs`：方法注册表。增删 baseline 只需调整对应
  方法文件和一条注册项。
- `runtime.mjs`：复用现有 MSA Solver、Codex Updater、模型网关、变异策略和 Evaluator。
- `benchmark.mjs`：读取正式 benchmark manifest，并复用主实验的 Cowork-Bench Environment。
- `baselines/prompts.json`、`baselines/sources.json`：上游 prompt、来源和适配说明。
- `UPSTREAM_COMPARISON.zh.md`：源代码对照、可声明范围和公平比较要求。

ACE 按 Generator → Reflector → 失败重试 → Curator → post-curation Generator
运行；唯一演化状态是追加到 `profiles/cowork.md` 的 playbook。串行 Curator 只执行
ADD，bullet 计数由 Controller 维护。
`feedbackConcurrency` 可以启用确定顺序的并行 minibatch，默认值为 1；独立的
`ace-batched` 变体则在多次 playbook 更新中复用 H0 Feedback。

原有 Evo-Bench Evolver 读取最新一轮完整 Feedback 和累积的结构化历史，每个 Candidate 调用一次
Codex session 修改可执行 harness；它继续保留为 `evo-bench`，以兼容已经开始的 run。

`evo-bench-paper` 只收集或复用一次 H0 的 90 条 Feedback 详细证据，随后顺序更新四轮 harness。
H0 与每个更新后的 candidate 都在同一组 30 条 Selection 上 validation。Updater 读取固定 H0
证据和累积 validation 历史。即使分数回退也从当前版本继续，独立保留 validation 最优版本，
最后在 60 条 Final 上评测。

示例配置允许 1000 次 updater 请求、48 小时运行时间。H0 和首个 candidate 的 validation
最多并发 4 题，后续 candidate 最多并发 30 题，同时受基础设施并发上限约束。
MSA Solver、Cowork evaluator、每个 candidate 独立的 Codex session 是本仓库的角色适配；
尚未实现上游持久 evolver 会话和异步工具接口。

## 使用

在仓库根目录执行：

```bash
node scripts/run-cowork-baseline.mjs check \
  --experiment experiments/cowork-benchmark-ace-single.json

node scripts/run-cowork-baseline.mjs run \
  --experiment experiments/cowork-benchmark-ace-single.json \
  --run-id ace-single-001
```

付费运行前先执行 `preflight`；完成并冻结 Champion 后再单独执行 `final`。固定 Feedback 的 EvoBench 适配版使用
`experiments/cowork-bench-native-90-30-60-evo-bench-paper-agentbay.json`。

如果已有 run 的 benchmark、source、seed、模型和 H0 完全一致，可以复用已经落盘的 H0 Feedback：

```bash
node scripts/run-cowork-baseline.mjs run \
  --experiment experiments/cowork-bench-native-90-30-60-evo-bench-paper-agentbay.json \
  --run-id evobench-paper-reuse-001 \
  --reuse-h0-feedback .rsi/baselines/<source-run>/partition-results/h0-feedback.jsonl
```

`evo-bench-paper` 在 Selection 上评测 evolved candidate，不重复运行初始 Feedback。
原有 `evo-bench` 方法仍会刷新完整 Feedback。

如果要让 GRHS 复用旧 baseline run 的 H0 Feedback 和 Selection，可显式指定来源及输出路径，
生成 baseline pack：

```bash
node scripts/import-legacy-baseline-pack.mjs \
  --experiment experiments/<grhs-config>.json \
  --state .rsi/runs/populations/<grhs-run>/branches/branch-001/run/state.json \
  --source-run .rsi/baselines/<source-run> \
  --output .rsi/baseline-packs/<pack-id>.json
```

将 GRHS 实验的 `baselinePack` 设置为生成的路径。导入器读取
`partition-results/h0-feedback.jsonl` 和 `h0-selection.jsonl`；输出必须是新文件。
具体 run 的路径与结果不写入受版本管理的通用配置。

本地测试不会调用模型或正式实验：

```bash
node --test controller/test/cowork-baselines.test.mjs
```

运行依赖与主实验相同的 `RSI_COWORK_BENCH_DATASET_ROOT` 和
`RSI_COWORK_BENCH_EVALUATOR_ROOT`。`scripts/smoke-cowork-benchmark.mjs` 可用空 submission 检查一道原生
verifier 的连通性，不调用模型。
