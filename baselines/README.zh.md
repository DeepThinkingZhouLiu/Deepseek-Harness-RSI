# ACE 与 Evo-Bench Evolver Baseline

[English](README.md) | 中文

这里包含两个面向仓库内 Cowork-Bench v0.2 的可选 Single/N1 baseline。
它们不会注册到主 Controller CLI，也不修改现有 recipes、benchmark manifest 或实验配置；
只有显式调用专用运行脚本时才会启用。

## 组件结构

- `controller/src/baselines/methods/ace.mjs`：ACE 方法生命周期。
- `controller/src/baselines/methods/evo-bench.mjs`：Evo-Bench Evolver 方法生命周期。
- `controller/src/baselines/methods/index.mjs`：方法注册表。增删 baseline 只需调整对应
  方法文件和一条注册项。
- `runtime.mjs`：复用现有 MSA Solver、Codex Updater、模型网关、变异策略和 Evaluator。
- `benchmark.mjs`：读取正式 benchmark manifest，并复用主实验的 Cowork-Bench Environment。
- `baselines/prompts.json`、`baselines/sources.json`：上游 prompt、来源和适配说明。
- `UPSTREAM_COMPARISON.zh.md`：源代码对照、可声明范围和公平比较要求。

ACE 按 Generator → Reflector → 失败重试 → Curator → post-curation Generator
运行；唯一演化状态是追加到 `profiles/cowork.md` 的 playbook。串行 Curator 只执行
ADD，bullet 计数由 Controller 维护。

Evo-Bench Evolver 读取最新一轮完整 Feedback 和累积的结构化历史，每个 Candidate 调用一次 Codex session 修改可执行
harness。分数下降后仍从最新有效版本继续研究，同时由 Controller 独立保留 Selection
最优 checkpoint 用于 Final。该方法的正式名称是 **Evo-Bench Evolver
(Cowork/Codex adaptation)**；它不是上游持久会话运行器的逐行复刻。

两种方法均使用详细 Feedback、仅聚合的 Selection 和 sealed Final，并共享 B16 配置。

## 使用

在仓库根目录执行：

```bash
node scripts/run-cowork-baseline.mjs check \
  --experiment experiments/cowork-benchmark-ace-single.json

node scripts/run-cowork-baseline.mjs run \
  --experiment experiments/cowork-benchmark-ace-single.json \
  --run-id ace-single-001
```

付费运行前先执行 `preflight`；完成并冻结 Champion 后再单独执行 `final`。运行
Evo-Bench 时替换 experiment 路径和 run-id。

本地测试不会调用模型或正式实验：

```bash
node --test controller/test/cowork-baselines.test.mjs
```

运行依赖与主实验相同的 `RSI_COWORK_BENCH_DATASET_ROOT` 和
`RSI_COWORK_BENCH_EVALUATOR_ROOT`。`scripts/smoke-cowork-benchmark.mjs` 可用空 submission 检查一道原生
verifier 的连通性，不调用模型。
