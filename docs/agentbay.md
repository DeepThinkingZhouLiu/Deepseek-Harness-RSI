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
