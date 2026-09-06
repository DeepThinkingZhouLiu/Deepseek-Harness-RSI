**范围与隔离**

工作区为 `.WorkTrees/016-fix-solver-failure-feedback`，分支 `fix/solver-failure-feedback`，基点 `9678e3e4d2ae881890bbfbab9a5b3375db686e5e`。本任务没有修改 014、共享 H0、正式实验的进程、状态或结果；没有 push、merge、PR，也没有派生开发代理。真实实验使用本会话的前台命令，不是 detached 任务。

**基线与离线验证**

使用项目专用环境 `/mnt/bn/liuzhou-hl-training/liuzhou/conda_envs/deepseek-harness-rsi` 的 Node。Python fixture 只使用 stdlib；未安装系统 Python 依赖。安装命令为 `npm install --ignore-scripts --package-lock=false`；linked worktree 补齐固定 DSH 子模块后，基线为 456/456。

```bash
export CONDA_PREFIX=/mnt/bn/liuzhou-hl-training/liuzhou/conda_envs/deepseek-harness-rsi
export PATH="$CONDA_PREFIX/bin:$PATH"
node --test controller/test/solver-failure*.test.mjs
npm test
npm run check
git diff --check
```

提交 `14ded35c2c` 时回归为 479/479；随后扩展测试为 483/483。收尾补丁的最终回归为 **490/490**（约 46.6 秒），`npm run check` 和 `git diff --check` 均通过。最终日志为 `.rsi/failure-feedback-smoke/regression-final.log`、`check-final.log`；小范围加固测试为 `final-hardening-tests.log`（35/35），另有 `privacy-check.log`（6/6）验证上游把 Key 反射进 Request ID 时也不会被记录。

离线集成真正经过本地 Model Gateway、MSA Driver、实际 Python fixture、OmegaUse Trial/Partition、Cowork Controller 和 Population；只有 Docker 执行底座、Verifier rubric 和 Updater 行为替换为明确标记的 fixture。覆盖五 Mode、有效正文后的解析失败、部分交付物保留、并发不串题、429/502/401/SSE 中断、reasoning-only、未声明工具的 tool calls、Champion 失败进入反馈、拒绝候选证据进入下一轮、Selection 隔离、恢复不重复 Updater/预算和两 Branch 部分完成。

这些 fixture 的分数不能作为真实 benchmark 成绩。

最终加固另外验证：零请求退出不因 Candidate 自报而定责；同题混合请求结果不会被最后一个好响应覆盖；非 Batch 并发直调的逐题用量不串题；旧/null 诊断字段可解析；失败证据即使 JSON 转义后也严格有界；同版本 Node 二进制漂移、Provider Endpoint 漂移会拒绝恢复；只轮换凭据不改变执行身份。其中 single fixture 的真实 Final 授权入口也接受新内容指纹，然后在缺少 fixture 配置处停止，没有领取 Final。

**最小真实 smoke**

- Run ID：`solver-failure-smoke-20260906-1`。
- 实际执行版本：`14ded35c2c`；运行期间只补充测试和文档，没有修改执行源码。
- 任务：原 Feedback 的 `officeval_003`，单 Branch、单 Trial、Seed `20260827`，候选预算 2。
- Solver：MSA，`gpt-5.6-terra` / high / 8192；Updater：官方 Codex CLI 0.153.4，`gpt-5.6-terra` / xhigh / 8192。
- Final：明确禁用，Final 列表为空；没有读取 sealed Final 或领取 Final Attempt。
- 独立网关镜像：`harness-rsi/model-gateway:failure-feedback-smoke-v1`，不覆盖正式网关 Tag。
- 根目录：`.rsi/failure-feedback-smoke/runs/populations/solver-failure-smoke-20260906-1`。

运行时仅读取已授权的 014 凭据文件，把 `COWORK_EVO_VLM_API_KEY` 映射到 `RSI_PROVIDER_API_KEY`，没有把凭据复制进 git、报告或 Prompt。Provider Base URL 为 `https://api.zcloudapi.com/v1`；数据和评测代码使用原 OfficeVal 路径。

```bash
node controller/src/cli.mjs experiment validate --config .rsi/failure-feedback-smoke/configs/experiment.json
node controller/src/cli.mjs experiment run \
  --config .rsi/failure-feedback-smoke/configs/experiment.json \
  --run-id solver-failure-smoke-20260906-1
node .rsi/failure-feedback-smoke/summarize.mjs
```

实际运行的日志是 `.rsi/failure-feedback-smoke/run.log`；只输出脱敏元信息的汇总工具为 `summarize.mjs`。配置与产物都在忽略的专用 `.rsi` 下。

已观察到 H0 基线为 0；g001 自行修改 `agent.py`、`profiles/cowork.md`、`run.py`，其 Digest 为 `35eb3c5c5f90b35a151d6d18d011b10a292c688d36b4b13b49557600750bd06d`。g001 把运行目录错误地设成不存在的 `/submission`，真实进程在调用模型之前退出；原 Verifier 给出 0，固定 Gate 拒绝，消耗 1 个候选预算。H0 Digest 保持 `c9303c1b83a05eb41f8f65dd9d4c58bda5f315ff2e361141bed4360ed8998e5c`。

第 2 轮的 Controller Feedback 与 Updater 只读输入摘要同为 `cee169e63f11f5b75598d3f245dd04acf16fa6302aab9441f3a110eb8890c050`。它保留原 g001 ID/Digest/Parent/训练失败记录和受控代码；当前可写 Candidate 的 Parent 仍为 H0。

重要边界：14ded 版本将“零网关请求 + 非零退出”也判为 Candidate。虽然本次 `/submission` 代码错误可只读核实，这不足以证明一般的启动前失败都应定责。本次真实结果不能直接冒充收紧该边界后的最终分类器 E2E；最终版验证和真实版本必须分开报告。

真实 smoke 已正常退出（exit 0），Population 为 `CLOSED`，预算消耗 **2/2**。g002 的 Digest 为 `61f0c7e5721c03a5ccc10d993a54efff6ff7f2de01719de5cf7d6b118233a621`；它从 H0 出发修改 Profile 和文档技能，没有沿用 g001 的 `/submission` 假设，正常完成 Solver 协议，但原 rubric 得分仍为 0。最终 Champion 仍为 H0：**闭环有观察证据，没有分数提升，也没有正式 benchmark 结论。**

- Solver：30 个请求，340,926 input tokens、62,711 output tokens，共 403,637 tokens，含失败尝试计量。
- Updater：39 个请求，全部缺少可用 Usage；Token 和美元成本保持 unknown/null，不报 0。
- Controller 账本墙钟：3,913,286 ms，约 65.2 分钟。
- 状态与脱敏指标：`.rsi/failure-feedback-smoke/metrics-final.json`；父 Population 已 CLOSED，而子 Branch 保留 `running` 是现有父层关闭语义，不代表仍有存活进程。
- 自有网关、Solver 容器及其网络已清理；保留独立构建镜像和实验产物供审阅，未触碰正式实验资源。

收尾只对 g001 的可信元信息做了离线重分类，结果从旧版 `candidate` 变为最终规则的 `unknown`。审计在 `.rsi/failure-feedback-smoke/reclassification-audit.json`：原执行摘要 `8e06a332180fd5576a243863f05386125376b3da388c456764ad7e3f62489006`，最终审阅执行摘要 `f74f3f7587c920199391df7fd069d1ba65fdf7cebdf5c5a5f809223c166999ab`。没有重放模型、改写原 Trial、评分或状态。最终保守版没有再追加真实计费实验；它的完整分类闭环由上述离线真实组件 fixture 验证。

**Resume 限制**

只读复核确认 `1d800e432fdac6d3d16873797511e45c1ec3340f` 到基点 `9678e3e` 只涉及 Codex Adapter、五个配置和两个测试，Controller/Docker/依赖声明执行路径没有变化。但旧状态没有原执行依赖及新错误协议的内容证据，不能仅据此改写旧 hash。未自动迁移、恢复或重启旧正式实验。

真实 Updater 的部分请求没有可用 Usage，账本明确保留请求数并标记不完整，不能据此声称 Token 或费用为 0。

仍未解决的边界：无法证明来源的启动前错误保持暂停，不自动进入训练终态；旧正式状态需要补齐原依赖/Runtime 证据并单独审阅迁移；HTTP 200 空正文仍不能据此判断是模型能力问题还是 NewAPI 转换问题。没有修改共享 `model.py` 来伪装成已经修好了这些来源不明的故障。
