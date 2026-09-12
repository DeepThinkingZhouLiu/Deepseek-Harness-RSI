# Baseline 上游实现对照

本说明用于界定仓库实现与上游源代码的等价部分、Cowork 适配部分，以及实验报告中
可以使用的名称。对照对象是 ACE 的 `ace/ace.py`、`ace/playbook_utils.py`，
以及 Evo-Bench 的 `evobench/evolution/harness.py`、`prompts.py`。

| 项目 | 上游实现 | 本仓库实现 | 结论 |
| --- | --- | --- | --- |
| ACE 单样本顺序 | Generator；失败时 Reflector 后重试；Curator；再运行 Generator | 顺序一致，成功样本也执行 Reflector，最多三轮反思 | 保留 |
| ACE 状态 | playbook bullet、helpful/harmful 计数、Curator operation | 状态与计数一致；串行模式只执行上游已实现的 ADD | 保留 |
| ACE 上下文 | Reflector 接收题目、轨迹、答案、评分和用过的 bullet；Curator 接收当前题目上下文 | 接收相同类别的信息，Curator 使用当前 Cowork 任务 instruction | 保留 |
| ACE 执行对象 | 文本 Generator 与任务 evaluator | MSA artifact Solver 与 Cowork 原生 Judge | 必要适配 |
| ACE checkpoint | 按 `eval_steps` 评估并保留最佳 playbook | 每个 candidate 在固定 Selection 上评估，由统一 promotion policy 保留 champion | 共享协议适配 |
| Evo-Bench 外循环 | 一个持久会话研究、编辑、发起 validation，直到完成 | 两个变体都按 candidate 启动新 Codex session，由 Controller 顺序安排更新和评测 | 会话与调度方式适配 |
| Evo-Bench 能力 | shell、文件、搜索、技能、子代理、实验账本、上下文压缩 | 文件编辑与反馈读取；没有完整上游工具/子代理/异步评估控制面 | 非等价适配 |
| Evo-Bench validation | Evolver 主动发起异步 validation；调用计入 iteration | `evo-bench-paper` 固定读取 H0 的 90 条 Feedback；每个 proposal 后在同一组 30 条 Selection 上 validation | 题目划分与执行方式适配 |
| 冻结版本 | Evolver 完成前把所选 revision 放到当前 harness | Controller 从当前版本继续，同时独立冻结 validation 最优 champion | 控制语义一致 |
| Benchmark | 官方 validation/evaluation suite 是 160/448 两个 disjoint split | Cowork-Bench native-90-30-60；Feedback 提供初始详细证据，Selection 用于在线决策，Final 独立评测 | 任务域和规模适配 |

## 可用于结果表的名称

- `ACE (Cowork artifact adaptation)`
- `Evo-Bench Evolver (Cowork/Codex adaptation)`
- `Evo-Bench (Cowork fixed-feedback/selection-validation adaptation)`（配置名为 `evo-bench-paper`）

这些名称都不代表官方 Evo-Bench Evolver 的完整复现。应注明 Cowork 的 MSA Solver、Evaluator、
Codex Updater 和固定 H0 Feedback 是适配；上游持久会话、异步工具面和官方任务集尚未移植。

## 公平对比前必须固定

三个入口已与主实验共享 benchmark manifest、Environment、Solver 模型设置和 sealed Final；
`evo-bench-paper` 使用独立 validation policy，在 Selection 上评测。正式比较时还应让各方法使用相同 candidate budget、
随机种子、Solver/Updater 模型与 token 上限，并同时报告：

- Final mean reward 与配对增益；
- anytime Selection；
- Solver rollout 数、Updater 请求数和 wall time。

ACE 的一个 candidate 可能包含多次 Generator rollout 和多个只读 Reflector/Curator
请求；因此只比较 candidate 数并不代表推理成本相同。当前 `evo-bench-paper` 示例配置为
4 轮更新、1000 次 updater 请求和 48 小时；H0 Feedback 90 题只运行或复用一次，H0 与四个
candidate 各评测 30 条 Selection。复用次数与实际新增 rollout 数应分别报告。
