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
| Evo-Bench 外循环 | 一个持久会话研究、编辑、发起 validation，直到完成 | 每个 candidate 一个新 Codex session，历史与反馈通过 packet 累积 | 非等价适配 |
| Evo-Bench 能力 | shell、文件、搜索、技能、子代理、实验账本、上下文压缩 | 文件编辑与反馈读取；没有完整上游工具/子代理/异步评估控制面 | 非等价适配 |
| Evo-Bench validation | Evolver 主动发起异步 validation；调用计入 iteration | Controller 在每次 proposal 后同步运行 Selection | 共享协议适配 |
| 冻结版本 | Evolver 完成前把所选 revision 放到当前 harness | Controller 冻结 Selection 最优 champion | 共享协议适配 |
| Benchmark | Evo-Bench 官方 validation/evaluation suite | Cowork-Bench v0.2 的 90/30/120 Feedback/Selection/Final | 任务域适配 |

## 可用于结果表的名称

- `ACE (Cowork artifact adaptation)`
- `Evo-Bench Evolver (Cowork/Codex adaptation)`

不能把第二项写成“官方 Evo-Bench Evolver 的完全复现”。若论文需要这个更强声明，
还需移植上游持久会话、主动且异步的 validation 工具、实验账本、上下文管理和完成条件。

## 公平对比前必须固定

两种 baseline 已与主实验共享 benchmark manifest、Environment、Selection policy、
Solver 模型设置和 sealed Final。正式比较时还应让各方法使用相同 candidate budget、
随机种子、Solver/Updater 模型与 token 上限，并同时报告：

- Final mean reward 与配对增益；
- anytime Selection；
- Solver rollout 数、Updater 请求数和 wall time。

ACE 的一个 candidate 可能包含多次 Generator rollout 和多个只读 Reflector/Curator
请求；因此只比较 candidate 数并不代表推理成本相同。Evo-Bench 上游论文常用的
20 次 validation iteration 与当前 B16 配置也不是同一个预算，若采用 B16，结果中应明确写出。
