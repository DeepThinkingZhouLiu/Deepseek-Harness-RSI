# GRHS 两题真实闭环验收

使用 `experiments/cowork-bench-grhs-v02-two-task-claude-b4.json`，从固定的 CoworkEvoBench v0.2 分区取子集，不复制或修改外部题目与 Judge。

- Benchmark / Judge 固定 revision：`aac0f28d4596eefbc50041b54ba3bbadf59d6f1b`。
- Feedback：RZD 行程文档、授权委托风险报告两道训练题。
- Selection：concert-contact，仍来自原验证分区。
- Final：保留 sealed 分区；训练验收不运行 Final。
- 沿用正式配置的 N1-K4-B4、L3（含低层区域）、模型、65536 输出预算、seed 和晋升门槛。
- Solver：MSA + GPT-5.6 Terra；Updater：Claude Code CLI + Sonnet 5。凭据仅从运行时环境注入。
- 单题 Solver 最多尝试 5 次（含首次），每次失败持久化诊断；基础设施失败不能当零分。

验收顺序：H0 Selection → 两题 Feedback → Claude 修改 4 个 sibling → Candidate Selection → 组内 advantage → winner 或合法保留 Parent → 组检查点与 B4。

完整运行后应核对每个 Candidate 的修改报告、真实文件差异、评分和组结算。提分是观测结果，不是验收时修改评分或降低晋升门槛的理由。

本轮传输修复按正文识别 JSON/SSE，支持多行 SSE data，拒绝未完成的流；错误保留安全的错误码与上游请求编号，不回显错误正文或密钥。真正的空流、仅含零宽字符的回答均按空响应处理并重试，不占用 Agent 解题步数。Gateway 原始转发字节保持不变，JSON 回退响应也正常计量 Usage。

验收还应核对 Updater 实际读取的 FeedbackPacket：Cowork Judge 的 `criterion_id / score / evidence` 必须转换为 Office 反馈格式器使用的逐项字段，保留规则编号、说明和证据。负权重项的 `score=0` 表示触发扣分；逐项映射不重新计算总分，Judge 原始 `reward`（包括 hurdle cap）保持不变。只看到总分正确、逐项说明为空，不能算反馈链路验收通过。

修改 H0 种子或 Controller 后必须使用新的 run-id。旧运行产物保留，不能将不同摘要的 Candidate 混进同一个实验。
