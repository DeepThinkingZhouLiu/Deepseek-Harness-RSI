**Solver 失败反馈与恢复协议**

本补丁只改变 Controller 的记录、分类、反馈和恢复行为，不替 Updater 修改共享 H0、已评测 Candidate 或任何正式运行。MSA 仍是可变 Solver，Codex 是冻结 Updater；Target × Environment × Recipe 与五种 Mode 不变。

**可信失败链路**

Controller 为每个 Trial 申请独立网关令牌 -> 网关用令牌绑定 Candidate/Partition/Instance/Seed -> MSA Driver 联合容器退出观测进行分类 -> Environment 保留安全产物并按冻结策略评分或暂停。

- `candidate`：所有相关可信模型流完整且有正常终止的最终正文，候选随后退出；或进程成功退出却违背 Controller 检查的 Answer/Trace 契约；以及网关确认且没有其他未知请求结果的非法 JSON 请求。零请求退出仅在 Docker 证明容器已成功启动并结束、无启动错误或 OOM、退出码与进程一致时归为 Candidate。Candidate 自报异常名称、正文、`kind` 不能决定分类。
- `provider`：可关联的 429/5xx、网络或 SSE 中断。
- `trusted-runtime`：认证/权限、容器资源或可信 Verifier 故障。
- `unknown`：HTTP 200 空正文、reasoning-only、未声明工具却返回原生 tool calls、缺少正常终止、同题混合请求结果，以及没有网关请求也没有可信容器状态的非零退出。上游 400 不按状态码一刀切归为 Candidate。

MSA 通过宿主私有 CID 文件关联 `docker inspect .State`，在清理容器前仅保存启动/结束、启动错误是否存在、OOM 和退出码，不保留可能含凭据的原始错误正文。退出码 125/126/127/137 本身不能证明基础设施坏了，因为 Candidate 也能主动返回这些值。该采集只在 MSA Driver 启用，其他 Docker 调用保持原行为。流诊断同时识别 `delta` 和最终 `message` 回退，畸形事件不能被后来的正常回答掩盖。

网关只记录请求 ID、HTTP 状态、重试次数、终止原因、正文长度、reasoning/tool-calls 是否出现及流是否完整等元信息；不记录 API Key、请求正文或 reasoning 正文。诊断端点仅 Controller Token 可访问。成功 Trial 的诊断也会落盘；并发归因和逐题用量不使用角色级全局差值，即使直接调用 Driver、不启用 Partition Batch 也是如此。

`maximumUpstreamRetries` 仍表示首次之外的额外网络重试，范围 0..5；同 Trial 完全相同请求再共享最多 6 次实际上游尝试，避免 Candidate 空响应重试与网关重试相乘。向 Solver 发出部分流后不重播，也不新增自动整题重试。

**评分与失败经验**

- OmegaUse `spec.solverFailurePolicy` 默认 `verified-candidate-terminal-v1`，可显式设为 `pause` 保持全失败暂停策略；规范化配置会被冻结。
- 可确认的 Candidate 失败仍提交安全产物给原 Verifier。没有产物时仍由原 Verifier 判断缺交付物，不给整批题伪造 0 分，也不从分母移除失败题。
- `solver_failures` 保存独立失败记录；任务状态和 reward 仍描述 rubric 结果。旧记录无此字段或为 null 时按空数组处理，非终态错误不能写成已评分记录。
- Policy 的 `gates.safety.maximumSolverFailures` 默认 0，即运行失败默认禁止晋升；显式设置 null 可关闭此 Gate。已有 rubric、质量 Gate 和安全 Gate 不改。
- 下一轮 Feedback 包含当前 mutation parent 的训练反馈，加同 Branch 最近被拒绝 Candidate 的独立证据。证据保留原 ID/digest/parent、逐题失败、受控代码片段和文件摘要；非法 Mutation Report 也会保存候选与拒绝证据。
- 单个被拒绝 Candidate 的输入证据上限 128 KiB；代码最多 8 个文件、合计约 48 KiB，每个失败病例最多保留最近 8 个请求元信息。完整可信诊断留在该 Trial 的 Controller 产物中。
- Selection 不向 Updater 提供逐题请求、Instance ID 或路径，只提供既有聚合计数及原候选代码。Final 逐题数据不参与失败反馈；其他 Branch 的共享历史不携带这些独立病例。

**结算与 Resume**

可正常评分的失败提案是一次正式候选尝试，拒绝后消耗 1 个 Candidate budget，计入搜索与竞争。Provider/Verifier/未知来源故障只暂停，不假装已结算；实际请求和耗时仍记账。

完成 Updater 后，Branch 持久化 `inFlight.proposal`，绑定 Step/Generation/Parent/MutationPlan/ID/Digest/Report。恢复会校验并复用同一候选，只让 Environment 补未完成 Trial；成功 checkpoint、已完成 Branch 和已结算 Step 不重跑、不重复扣 budget。尚未产出完整不可变 proposal 的 Updater 中断仍属于未完成尝试，恢复时会归档其半成品。

新 Run 使用 `execution-identity-v2`：Git Commit 仅作为审计信息；执行源码、脚本、Docker 定义、已加载 yaml 依赖、Node 二进制与版本、错误处理协议按内容冻结。Experiment/模型参数/Target/Seed/Benchmark/Policy/Prompt/Environment Assets 使用冻结 Bundle，并摘要实际 Provider Endpoint 与 Updater 的 Node/bwrap/setpriv 二进制；Office Runtime 还校验实际镜像 ID。README/tests 或提交相同实际配置不会改变执行身份，真正的内容漂移会拒绝恢复。正常 Final 入口使用同一内容指纹，旧版显式 Final Recovery 的独立授权流程不变。

旧 Run 只记录 Git HEAD，缺少当时依赖及错误处理协议的内容证据，而且旧的中途提案没有新版 `inFlight.proposal` 绑定，不能安全推断其与新协议兼容。本补丁明确拒绝自动迁移，不改旧状态 hash、不运行旧正式实验。`inspectLegacyCodeCompatibility()` 可只读列出旧提交与当前执行路径的差异，但这不足以替代缺失的依赖证据。2026-09-06 用户允许重跑后，采用保留旧产物、使用新 Run ID 重跑的方案，不为旧存档扩写高风险迁移器；以后由新版创建的 Run 仍支持逐题恢复。

确定性的恢复不兼容返回 CLI 退出码 3；正式五 Mode Launcher 会停在 `BLOCKED_INCOMPATIBLE`，不会每分钟无限重试。原有临时基础设施暂停机制不变。

**验证与最小真实实验**

离线测试包含真实本地网关、MSA Driver、实际 Python fixture、OmegaUse Trial/Partition、Cowork Controller 与 Population 五 Mode。只有 Docker 执行底座、Verifier rubric 和 Updater 行为使用明确标注的 fixture；这些结果不能当作真实 benchmark 成绩。

真实 smoke 配置及日志位于本 worktree `.rsi/failure-feedback-smoke/`，训练仅使用原 Feedback 的 `officeval_003`，总候选预算 2，单 Branch/单 Trial；Solver 为 Terra/high，官方 Codex 0.153.4 Updater 为 Terra/xhigh。Benchmark 显式设置 `finalEvaluation: disabled`，Final 为空且 Finalizer 会拒绝领取 Final Attempt。独立网关镜像为 `harness-rsi/model-gateway:failure-feedback-smoke-v1`，没有修改正式网关 Tag。

真实闭环是否遇到可修复失败、Updater 是否实际修改 L3、以及分数是否提升，必须分别报告；离线注入修复不能冒充真实进化结果。最终结果和版本边界见 [验证记录](solver-failure-feedback-validation.zh.md)。
