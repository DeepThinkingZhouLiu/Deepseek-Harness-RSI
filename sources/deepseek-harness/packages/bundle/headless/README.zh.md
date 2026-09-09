# `@deepseek-ai/dsh-headless`

[English](README.md) | 中文

dsh 一次性任务组合包。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.zh.md) 之上：提供编码 persona 和工具模式、禁用 HMR（热模块替换）、将 Code Mode 的 worker 作为核心执行能力挂载、插入 agent preset 名单，并插入本包的 `headless-runner` 插件（配置为 `{task, preset?}`，从注入的 `headlessStartup` 提供方解析）。该叠加层禁用 base 层中面向模型的条目，因此所选 preset 负责 Agent（智能体）的工具、提示词分节、skill（技能）、压缩策略与委派工具。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

Loader 结算后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.zh.md)，并解析请求的 [`ctx.agentPresets`](../../preset/agent-presets/README.zh.md) 条目。它通过 `ctx.agents` 创建一个全新的持久化 Agent，将解析出的 preset id 记录到 Session header，在工厂的 `setup` 窗口中安装模型选择并挂载 preset，完成后才发布 Agent。随后，它将任务作为普通用户消息提交，并等待完全停稳。它对 Session 执行 flush 后再汇总自身持有的持久化事件区间，将最后一条非空 assistant 文本写入 stdout，再经启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)）请求退出（最终 `turn/end` 完成 → 0，否则为 1）。最终结束原因为 `error` 时，还会将 code 与 message 写入 stderr；成功运行时 stderr 保持为空。进程不会打开监听端口。

任务与可选 preset 由这个应用自己的命令行提供。普通 `headless-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)），读取 `dsh --profile headless [--preset <id>] "task"`、打印应用自己的 `--help`，并提供 `headlessStartup`；runner 注入该服务，再读取其惰性配置。省略 `--preset` 时使用名单中配置的默认值；随附 profile 的默认值为 `standard`，用户设置可以覆盖它。未知或损坏的 preset 会在创建 Agent 之前失败。缺失或只有空白的任务会在 runner 激活前被拒绝。

## 模型体验

runner 自身不添加任何面向模型的文本。所选 preset 负责提示词、工具、skill、压缩策略与委派工具；因此改选 preset 会按照其组装方式改变模型体验。随附默认值为 `standard`。

#### KV Cache 影响

runner 不向请求前缀添加任何内容。选择其他 preset 可能改变前缀与工具 schema；一次运行会固定使用已经解析出的 preset。

## 已知限制与暂缓事项

- **只提交一个任务**：runner 没有用于交互式后续输入的 surface；它会等待 Agent 在返回 idle 前完成的所有工作，并打印该区间内最后一条非空 assistant 消息。
- **没有人类提问提供方**：所选 preset 可能暴露 `ask_user_question`，但 headless 没有 UI 提供方；调用它会以用户提问服务的 `NO_PROVIDER` 错误失败，而不是等待输入。
- **`ctx.appExit` 由启动器持有**：在 `dsh` 启动器之外启动 headless profile 会在激活时明确报错，直到宿主提供该退出请求。
