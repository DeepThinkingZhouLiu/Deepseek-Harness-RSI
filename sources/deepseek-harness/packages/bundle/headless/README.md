# `@deepseek-ai/dsh-headless`

English | [中文](README.zh.md)

The dsh one-shot bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, inserts the agent-preset roster, and inserts this package's `headless-runner` plugin (config `{task, preset?}`, resolved from the injected `headlessStartup` provider). The overlay disables the base layer's model-facing rows, so the selected preset owns the Agent's tools, prompt sections, skills, compaction policy, and delegation tools. It mounts no Host, HTTP server, Web runtime, or browser plugin.

After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md) and resolves the requested [`ctx.agentPresets`](../../preset/agent-presets/README.md) entry. It creates one fresh persisted Agent through `ctx.agents`, records the resolved preset id in the Session header, installs the model selection, and mounts the preset inside the factory's `setup` window before publication. It then submits the task as an ordinary user message and waits for quiescence. It flushes the Session before folding the owned durable event interval, writes the last non-empty assistant text to stdout, and requests exit through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) (final `turn/end` completed → 0, otherwise 1). A terminal `error` reason also writes its code and message to stderr; successful runs keep stderr empty. The process opens no listening port.

The task and optional preset are this app's command line. The ordinary `headless-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), reads `dsh --profile headless [--preset <id>] "task"`, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its lazy config. Omitting `--preset` uses the roster's configured default, which is `standard` in the shipped profile and may be overridden by user settings. An unknown or broken preset fails before Agent creation. A missing or whitespace-only task is rejected before the runner activates.

## Model Experience

The runner adds no model-facing text of its own. The selected preset owns the prompts, tools, skills, compaction policy, and delegation tools; choosing a different preset therefore changes the model experience according to that preset's composition. The shipped default is `standard`.

#### KV Cache effect

The runner adds nothing to the request prefix. Selecting a different preset may change the prefix and tool schemas; one run keeps its resolved preset fixed.

## Known Limitations and Deferred Work

- **One submitted task only** — the runner has no interactive follow-up surface; it waits through any work the Agent completes before returning to idle and prints the last non-empty assistant message in that interval.
- **No human-question provider** — a selected preset may expose `ask_user_question`, but headless has no UI provider; calling it fails with the user-questions service's `NO_PROVIDER` error rather than waiting for input.
- **`ctx.appExit` is launcher-owned** — booting the headless profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
