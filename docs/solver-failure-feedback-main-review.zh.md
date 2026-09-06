**2026-09-06 主进程收尾验证**

工作目录：`002-Code/.WorkTrees/016-fix-solver-failure-feedback`；分支：`fix/solver-failure-feedback`。本次由主进程完成，没有再分派子代理。执行代码提交：`595b60f9f5`，前置实现为 `14ded35c2c` 与 `c0a3a65a42`。

**本次补齐的内容**

- MSA 调用 Docker 时先从宿主私有 CID 文件读取容器状态，再按该 CID 清理；不依赖候选自报，也不误删同名的其他容器。
- 容器确实启动并退出、没有启动错误或 OOM 且退出码一致时，零模型请求的候选崩溃可以进入失败反馈。缺少证据仍暂停。
- 不再仅凭 125/126/127/137 判定基础设施故障，避免 `sys.exit(137)` 被误认为 OOM。
- 流诊断兼容最终 `message` 回退且不重复计数，畸形事件、混合请求结果仍不能被后续好响应掩盖。
- 既有的候选持久化和恢复逻辑通过回归：暂停后保留同一提案，只补没完成的题，不再次调用 Updater 或重复扣预算。
- 真实运行结束后补齐反馈文件大小边界：按带缩进和末尾换行的实际落盘字节裁剪，不再只计算紧凑 JSON；空间不足时优先留下运行失败病例。26 题的长反馈已复现旧错误并建立回归。

**自动化与实际 Docker 验证**

| 验证项目                    | 结果                                                        |
| --------------------------- | ----------------------------------------------------------- |
| 实验前自动化测试            | 495 / 495 通过                                              |
| 最终完整自动化测试          | 496 / 496 通过（含 26 题长反馈实际字节数和优先级回归）        |
| 语法检查与差异检查          | `npm run check`、`git diff --check` 通过                     |
| 实际容器：Python 启动后报错 | `candidate / candidate-process-exit`                        |
| 实际容器：主动退出 137      | `candidate`，不会误判 OOM                                   |
| 实际容器：入口程序不存在    | `trusted-runtime`，不会冒充 Solver 做题失败                  |
| 五种 Mode 与恢复            | 离线集成通过；Provider、Updater 和部分执行环境含明确的替身   |

实验前自动化日志：`.rsi/failure-feedback-smoke/main-review-regression.log` 和 `main-review-check.log`；最终日志：`.rsi/failure-feedback-final/regression-final.log`（496/496，约 51 秒）与 `check-final.log`，定向回归 `size-regression.log`（16/16）。真实 Docker 检查只运行明确标注的故障样例，不代表 Benchmark 成绩；容器均按本次创建的 CID 清理。

**最终版本真实小实验**

Run ID：`solver-failure-final-20260906-1`；配置和日志：`.rsi/failure-feedback-final/`。使用真实 ZCloud、官方 Codex CLI 0.153.4 Updater、MSA Solver，二者均为 `gpt-5.6-terra / xhigh / 8192`。只做训练题 `officeval_003`，Single，预算 2，开放 L1+L2+L3。为检查链路而把 Solver 上限设为 3 步；这不是正式 12 步实验，不可拿来比较正式分数。Selection/Final 为空，Final 禁用。

独立网关镜像为 `harness-rsi/model-gateway:failure-feedback-final-v1`，不覆盖 014 的镜像标签。共享 H0 源码与 Seed 未修改；凭据只在运行时注入。真实进程退出码为 0，Population 为 `CLOSED`，预算结算 2/2，墙钟约 52.3 分钟；自有网关、Solver 容器和网络已清理。

| 版本    | 训练题 Reward | 结论     | 实际修改                       |
| ------- | ------------- | -------- | ------------------------------ |
| H0      | 0             | 公共起点 | 未修改                         |
| g001-l3 | 0             | 拒绝晋升 | `agent.py`、`profiles/cowork.md` |
| g002-l3 | 0.333333      | 晋升     | `agent.py`                     |

g002 实际修改了题目的 DOCX，原 Verifier 给出 **5/15** 分：表格无空白行的要求通过，横线样式和间距要求仍未通过。因此这是单题部分得分改善，不是完整解决，也不能宣称有泛化收益。两次 Updater 都正常 `turn.completed`，结构化输出中没有 `error` 事件。

第二轮 Controller Feedback 与 Codex 实际只读输入逐字节一致，SHA-256 为 `17dc8833a3c29425ec5c27f500d11b8ce7f3ece2215b1c730fe438b90559ae5a`。其中明确保留 g001 的 ID/Digest、评分、改动列表及 `agent.py`、Profile、`model.py`、`run.py`、`tools.py` 代码证据；第二轮可写底稿仍是 H0。g001 摘要为 `a8ca91f5e012e6453e54bc0968bda0392d15f100240e20ad0131ebe13c30add5`，g002 摘要为 `6f13db3c327ff5d695c323780da8e52620916cedf65c7162779daadd93d793b4`。

本次真实运行中没有出现最终归类为 Candidate 的运行崩溃；“容器启动后崩溃 -> 继续评分/反馈”的组合由实际 Docker 故障样例与离线 Controller 集成分别覆盖，不能冒充本次自然出现的真实故障。第二轮 H0 曾收到一次 HTTP 200、`finish_reason=stop`、正文 0 字节的完整响应，后续同题请求重试成功，最终完成 3 个工具步骤；没有整题重跑，诊断被保留。此次没有自动修改 `model.py`。

Solver 共 16 次请求，151,051 个已报告 Token；Updater 共 44 次请求，其中 42 次没有可用 Usage，仅 2 次可计量，因此 Updater 总 Token 和总费用仍为 unknown/null，不能报成 0。可审计汇总为 `.rsi/failure-feedback-final/metrics-final.json`，原始终态、逐题结果和候选保留在该 Run 目录中。

版本边界：真实运行全程固定在 `595b60f9f5`，执行摘要为 `885946011097453d50393a638da8b168fd0db0f7b814ce8f153473af243f0a2a`。之后的补丁只修反馈文件限长与裁剪顺序，未再启动一整轮计费实验；使用该真实 g001 的冻结记录和代码重建反馈，得到与原文件逐字节相同的 21,994 字节文件，其摘要为 `2d100343a027e26b0f717f4f562d78b8b7ef927ed4888c4fe7b532f47eedcf15`。长反馈的变更由专门的 26 题合成回归验证，原真实记录未被覆盖。

**旧实验：选择保留产物、重新开 Run，不强行迁移**

014 的旧五 Mode 套件为 `cowork-main16-insample26-codex-terra-xhigh-seed20260827-v1`。只读检查确认 9 个 Branch 均缺少新版执行内容摘要和 `inFlight.proposal` 绑定；Single 已结算 1 个预算，其他 Mode 尚未结算候选预算。不能只改 Git hash 就宣称可安全续跑：还需要重建中断时的候选绑定、核验旧逐题记录与候选对应关系，并处理新旧错误协议差异。

| Mode        | Branch 1 记录数 | Branch 2 记录数 |
| ----------- | --------------- | --------------- |
| Single      | 51              | —               |
| Independent | 25              | 26              |
| Mutualism   | 26              | 24              |
| Competition | 24              | 24              |
| Combined    | 25              | 26              |

共 251 份 `committed-result.json`，包含不同 Candidate 的记录，不是 251 道不同题，也不包含复制的公共 BaselinePack 记录。旧目录、轨迹、候选和结果均原样保留，没有改写旧状态、迁移结果或重启旧套件。

用户允许重跑，因此不新增旧存档迁移器。正式重启路线：在稳定新版创建新 Run ID -> 按正式 26 道训练题、12 步配置只评测一次公共 H0 -> 用现有 `experiment baseline-pack-export` 导出新的公共包 -> 五种 Mode 通过现有 Suite 的 `RSI_BASELINE_PACK_PATH` / `RSI_BASELINE_PACK_SHA256` 共用它，预算与 Branch 数保持原配置。这套入口已经存在，不需要重写 Controller。旧包不能通过篡改摘要强行套入新评分/失败协议。

本次只启动上述单题小实验，没有启动 B16 五 Mode 长实验。今后由新版创建的实验仍支持逐题 Resume；选择重跑只针对这批旧存档。

**仍然需要区分的错误**

HTTP 200 但只有 reasoning、没有正文，或未声明工具却返回 tool calls，仍不足以证明一定是 Solver 代码错误，保持暂停，不伪造零分。此次修复保证可确认的候选错误能进入 Updater 反馈，不代表已经修好 Provider 的所有空响应或已让 MSA 支持原生工具调用。
