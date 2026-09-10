# CoworkEvoBench 90/30/60 本地 Docker 运行指南

本文说明如何在一台 Linux 主机上用本地 Docker 运行 ACE、GRHS 和 Evo-Bench
Evolver。这里的“本地 Docker”指 Controller 在宿主机运行，Solver、评分器和模型网关
在隔离容器中运行；不需要 AgentBay，也不需要 Docker Compose。

正式流程统一使用 90 道 feedback、30 道 selection、60 道 native final，并在 Harness
冻结后额外评测 60 道 cross-office final。ACE 配置为单轮全量 feedback；GRHS 和
Evo-Bench 使用各自仓库适配后的更新流程。

## 1. 主机要求

- Linux x86-64；Controller 必须由普通用户启动，不能使用 root。
- Node.js 20 或更高版本及 npm。
- Docker Engine，当前用户能够直接执行 `docker`。
- `bubblewrap`、`setpriv` 和仓库指定版本的 Codex CLI，用于隔离 Updater。
- 默认同时运行 2 道题。每道题的容器额度最高为 4 CPU、8 GiB 内存，建议主机至少
  24 GiB 可用内存和 40 GiB 可用磁盘。

先检查基础环境：

```bash
node --version
npm --version
docker version
docker run --rm hello-world
command -v bwrap
command -v setpriv
```

如果 `docker` 只能通过 `sudo` 使用，应先把当前用户加入 Docker 用户组并重新登录。
不要用 `sudo npm run ...` 启动实验。

当前 Updater adapter 固定使用以下宿主路径：

```text
/usr/local/bin/node
/usr/local/lib/node_modules/@openai/codex/bin/codex.js
/usr/bin/bwrap
/usr/bin/setpriv
```

若本机安装位置不同，应先修改
`adapters/updaters/codex-cli.yml` 的 `nodeBinary`、`executable`、
`distributionRoot`、`bwrapPath` 和 `setprivPath`，再执行配置校验。

## 2. 拉取 Harness 和 Benchmark

建议把两个仓库放在同一父目录下：

```bash
mkdir -p "$HOME/cowork-evolution"
cd "$HOME/cowork-evolution"

git clone --branch pnx-dev \
  git@github.com:DeepThinkingZhouLiu/HarnessEvoGym.git

git clone --branch main \
  git@github.com:DeepThinkingZhouLiu/cowork-evolution-benchmark.git
```

如果不能使用 SSH，可将两个地址换成对应的 HTTPS 地址。已有 checkout 使用：

```bash
git -C "$HOME/cowork-evolution/HarnessEvoGym" pull --ff-only
git -C "$HOME/cowork-evolution/cowork-evolution-benchmark" pull --ff-only
```

Harness 会检查 Benchmark 是否与当前配置匹配。如果 Benchmark 的 `main` 已更新、而
Harness 尚未同步适配，应更新两个仓库到彼此匹配的版本，不要绕过 preflight。

安装 Controller 依赖：

```bash
cd "$HOME/cowork-evolution/HarnessEvoGym"
npm install
```

## 3. 设置路径和模型凭据

Dataset 与 Evaluator 都位于 Benchmark 仓库，因此两个变量指向同一个绝对路径：

```bash
cd "$HOME/cowork-evolution/HarnessEvoGym"

export RSI_COWORK_BENCH_DATASET_ROOT="$HOME/cowork-evolution/cowork-evolution-benchmark"
export RSI_COWORK_BENCH_EVALUATOR_ROOT="$HOME/cowork-evolution/cowork-evolution-benchmark"
export RSI_PROVIDER_BASE_URL="https://your-openai-compatible-provider.example/v1"
read -rsp 'Provider API key: ' RSI_PROVIDER_API_KEY
printf '\n'
export RSI_PROVIDER_API_KEY
```

也可以复制 `.env.example` 为被 Git 忽略的 `.env.local`，填好后加载：

```bash
set -a
source .env.local
set +a
```

不要把真实密钥写入 Experiment JSON、Adapter YAML、README 或提交记录。Solver 和
Updater 只通过本地模型网关获得临时内部凭据。

## 4. 本地 Docker 配置

本地环境入口是 `environments/cowork-bench-full.yml`。它没有 AgentBay backend，使用
宿主机的 `docker` 命令，并默认：

- 同时运行 2 道题；
- 单题最多 4 CPU、8 GiB 内存；
- 模型网关最多同时处理 8 个请求；
- Solver 容器只能访问实验创建的内部网络，只有模型网关可以访问上游 API。

本地实验配置如下：

| 方法 | Native 配置 | Cross-office 配置 |
|---|---|---|
| ACE | `experiments/cowork-bench-native-90-30-60-ace-paper1-qwen-local-docker.json` | `experiments/cowork-bench-cross-office-90-30-60-ace-paper1-qwen-local-docker.json` |
| GRHS | `experiments/cowork-bench-native-90-30-60-grhs-qwen-single-b4-local-docker.json` | `experiments/cowork-bench-cross-office-90-30-60-grhs-qwen-single-b4-local-docker.json` |
| Evo-Bench | `experiments/cowork-bench-native-90-30-60-evo-bench-qwen-local-docker.json` | `experiments/cowork-bench-cross-office-90-30-60-evo-bench-qwen-local-docker.json` |

三种方法均固定使用 Qwen3.8-max 作为 Solver 和 Updater。要换模型，应同时修改 native
与 cross-office 配置，并保持不同方法的模型、预算和并发一致。

## 5. 校验并构建 Docker 镜像

先运行代码和配置检查；这些命令不会请求模型：

```bash
npm run check

node scripts/run-cowork-baseline.mjs check \
  --experiment experiments/cowork-bench-native-90-30-60-ace-paper1-qwen-local-docker.json

node scripts/run-cowork-baseline.mjs check \
  --experiment experiments/cowork-bench-native-90-30-60-evo-bench-qwen-local-docker.json

npm run rsi -- experiment validate \
  --config experiments/cowork-bench-native-90-30-60-grhs-qwen-single-b4-local-docker.json
```

然后运行 preflight。它会检查 Benchmark 路径、Docker daemon 和 Provider 配置，并在
本地自动构建 Cowork runtime、MSA Solver runtime 和 model-gateway 镜像：

```bash
node scripts/run-cowork-baseline.mjs preflight \
  --experiment experiments/cowork-bench-native-90-30-60-ace-paper1-qwen-local-docker.json \
  --run-id ace-local-preflight

npm run rsi -- experiment preflight \
  --config experiments/cowork-bench-native-90-30-60-grhs-qwen-single-b4-local-docker.json
```

首次构建需要下载 Node、Python、LibreOffice 和字体基础层，之后会复用本地镜像。可以
用以下命令查看，而无需手工启动容器：

```bash
docker images | grep 'harness-rsi'
docker ps --filter 'label=io.harness-rsi.managed=true'
docker network ls --filter 'label=io.harness-rsi.managed=true'
```

## 6. 完整运行

每个 wrapper 都会依次完成 evolution、native final 和 cross-office final，并能根据
同一个 run ID 续跑中断阶段。建议三种方法串行运行，避免一台主机同时创建过多 Office
容器。

### ACE

```bash
scripts/run-cowork-baseline-through-cross-final.sh \
  --config experiments/cowork-bench-native-90-30-60-ace-paper1-qwen-local-docker.json \
  --run-id cowork-local-ace-001 \
  --cross-target experiments/cowork-bench-cross-office-90-30-60-ace-paper1-qwen-local-docker.json
```

### GRHS

```bash
scripts/run-cowork-evolution-through-cross-final.sh \
  --config experiments/cowork-bench-native-90-30-60-grhs-qwen-single-b4-local-docker.json \
  --run-id cowork-local-grhs-001 \
  --cross-target experiments/cowork-bench-cross-office-90-30-60-grhs-qwen-single-b4-local-docker.json
```

### Evo-Bench Evolver

```bash
scripts/run-cowork-baseline-through-cross-final.sh \
  --config experiments/cowork-bench-native-90-30-60-evo-bench-qwen-local-docker.json \
  --run-id cowork-local-evo-bench-001 \
  --cross-target experiments/cowork-bench-cross-office-90-30-60-evo-bench-qwen-local-docker.json
```

如果命令因主机重启、Docker 或 Provider 临时故障退出，修复后原样重跑同一个命令和
run ID。Wrapper 会读取已有 checkpoint，而不是从头覆盖结果。不要同时用两个进程续跑
同一个 run ID。

## 7. 并发与资源调整

默认并发 2 适合单机复现。提高并发时：

1. 修改 `environments/cowork-bench-full.yml` 中的
   `task.maximumConcurrentTrials`，本地上限为 8；
2. ACE 还需同步修改 native 配置中的 `maximumConcurrentTrials` 和
   `feedbackConcurrency`；
3. Evo-Bench 同步修改 `maximumConcurrentTrials`；
4. 保证 native 与 cross-office 配置保持一致。

粗略资源预算按“并发数 × 单题容器额度”计算，并额外为模型网关、Updater、Verifier
和 Docker page cache 留出空间。内存不足时应降低并发，不要通过删除 checkpoint 重跑。

## 8. 结果位置

- ACE、Evo-Bench：`.rsi/baselines/<run-id>/`
- GRHS：`.rsi/runs/populations/<run-id>/`
- Native final 和 cross-office final 位于各自 run 目录下。
- 单题 workspace、Solver trace、Verifier 日志与恢复记录都保留在 run 目录中。

常用检查：

```bash
find ".rsi/baselines/cowork-local-ace-001" -name committed-result.json | wc -l
cat ".rsi/baselines/cowork-local-ace-001/final-report.json"
cat ".rsi/runs/populations/cowork-local-grhs-001/public/state.json"
```

## 9. 常见问题

- `请用普通用户启动 Controller`：退出 root shell，用有 Docker 权限的普通用户运行。
- Benchmark revision 不匹配：分别更新 Harness `pnx-dev` 和 Benchmark `main`，重新执行
  preflight；不要关闭版本检查。
- 缺少 Codex CLI 或路径不匹配：按第 1 节调整 updater adapter 后重新 validate。
- Docker build 拉取慢：为 Docker daemon 配置可用镜像源；不要修改实验中的隔离网络。
- Provider 返回限流：降低本地并发，保留同一个 run ID 续跑。
- 磁盘占用持续增长：实验完成并确认不再需要逐题 workspace 后，再归档对应 run 目录；
  不要在运行中删除 `.rsi`。

