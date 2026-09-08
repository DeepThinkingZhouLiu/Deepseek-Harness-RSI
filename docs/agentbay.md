# AgentBay

The OfficeVal AgentBay backend uses one AgentBay VM per Controller context,
as in pnx-dev. Docker control-plane commands are submitted serially; long
workloads run concurrently in that VM. The AgentBay environment permits up
to 200 trials and 200 model requests concurrently. Actual parallelism is
limited by the partition size, VM resources and provider capacity.
Population branches each own a context; use the single-branch recipes below
to use one VM. GRHS sibling scheduling and candidate budgets are unchanged.

Install the AgentBay Python SDK in a separate Python environment. Set
AGENTBAY_API_KEY, HARNESS_RSI_AGENTBAY_PYTHON (absolute interpreter path),
HARNESS_RSI_AGENTBAY_IMAGE_ID and HARNESS_RSI_AGENTBAY_POLICY_ID at runtime.
The image needs sudo access and Docker or Debian package installation support.
The existing OfficeVal dataset/evaluator and model-provider variables still apply.

Optional HARNESS_RSI_AGENTBAY_EXISTING_SESSION_ID attaches a warm VM.
The bridge does not delete an attached session. Owned sessions are deleted
when the bridge exits normally; the configured lifecycle policy handles expiry.

The backend configures the registry mirror even on warm Docker daemons,
reuses matching images, allows four hours for builds, and passes Tencent
Debian/Python package mirrors as build arguments. Local Docker defaults stay
unchanged. Gateway Dockerfiles support the legacy Docker builder.

Validate the two-task GRHS experiment:

```sh
npm run rsi -- experiment validate --config experiments/cowork-msa-grhs-mvp-single-agentbay.json
```

Run it with the required environment variables configured:

```sh
npm run rsi -- experiment run --config experiments/cowork-msa-grhs-mvp-single-agentbay.json --run-id grhs-agentbay-mvp-001
```

The larger configuration is
experiments/cowork-msa-grhs-main16-codex-single-agentbay.json.
The untracked cowork-grhs-12-11-9-agentbay.json uses the old pnx-dev GRHS
configuration shape; use the recipe-based configurations above on this branch.

## CoworkBench PPT GRHS

`experiments/cowork-bench-ppt60-grhs-claude-single-b4-agentbay.json` selects all
60 PPT tasks from the fixed CoworkBench release: 30 feedback, 10 selection,
and 20 final tasks. One GRHS group contains four sibling candidates. Final
tasks remain sealed during evolution and require the separate final evaluation.

The Solver is MSA with `gpt-5.6-terra`; the Updater is Claude Code with
`claude-sonnet-5`. Both use high reasoning effort and a 65536 output-token cap.
The Controller stays local. The `claude-code-docker-v1` Updater installs Claude
Code 2.1.260 in an AgentBay Docker image and runs the CLI as a non-root user.
It does not require a local Claude installation or local user namespaces.
Existing local CLI adapters are unchanged.

The Claude image imports CA certificates from the Python base image before
installing dependencies, and uses the npm mirror for the CLI package. The
container gateway forwards requests, records usage, and returns candidate edits
and the mutation report to the Controller.

Provide credentials through environment variables, not experiment files:

```sh
export RSI_PROVIDER_BASE_URL=https://api.zcloudapi.com/v1
export RSI_CLAUDE_PROVIDER_BASE_URL=https://api.zcloudapi.com/v1
# Also set RSI_PROVIDER_API_KEY and RSI_CLAUDE_PROVIDER_API_KEY.
export RSI_COWORK_BENCH_DATASET_ROOT=/path/to/cowork-data
export RSI_COWORK_BENCH_EVALUATOR_ROOT=/path/to/cowork-evolution-benchmark
npm run rsi -- experiment preflight --config experiments/cowork-bench-ppt60-grhs-claude-single-b4-agentbay.json
npm run rsi -- runtime build --experiment experiments/cowork-bench-ppt60-grhs-claude-single-b4-agentbay.json
npm run rsi -- experiment run --config experiments/cowork-bench-ppt60-grhs-claude-single-b4-agentbay.json --run-id cowork-ppt60-grhs-001
```

The dataset root contains `tasks/ppt/`. The evaluator checkout must match the
revision specified by the environment adapter. Both provider URLs need `/v1`
because these gateways append the endpoint name; the Claude CLI itself points
to its container-local gateway, not directly to the provider URL.
