import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import {
  validateEnvironmentAdapter,
  validateModelProviderAdapter,
  validateTargetAdapter,
  validateUpdaterAdapter,
} from '../adapters.mjs'
import { materializeCandidate } from '../candidate-materializers.mjs'
import { validateCandidate } from '../candidate-validators.mjs'
import {
  copyRegularTree,
  diffSnapshots,
  enforceMutationPolicy,
  mutationPolicyFor,
  snapshotTree,
  treeDigest,
} from '../candidate.mjs'
import { readConfigFile, resolveInside } from '../config.mjs'
import { ModelGateway } from '../cowork-model-gateway.mjs'
import { DockerClient } from '../docker.mjs'
import { AgentBayDockerClient } from '../agentbay-docker.mjs'
import { evaluateBenchmark } from '../evaluator.mjs'
import { createSolverDriver, createUpdaterDriver } from '../factories.mjs'
import { runProcess } from '../process.mjs'
import {
  ProtocolError,
  validateEvaluationPolicy,
  validateResultRecords,
  writeJsonFile,
} from '../protocol.mjs'
import { resolveTargetSource } from '../target-sources.mjs'
import { UPDATER_SANDBOX_PATHS } from '../updater-runner.mjs'
import { renderPlaybook, usedBulletIds } from './ace.mjs'
import { BaselineCoworkEnvironment, selectionAggregate } from './benchmark.mjs'
import { BaselineBudgetExhausted } from './budget.mjs'
import { baselineMethodIds, getBaselineMethod } from './methods/index.mjs'

export async function loadBaselineConfiguration(path, repositoryRoot) {
  const config = await readConfigFile(path)
  if (config.apiVersion !== 'harness-rsi/v1alpha1'
      || config.kind !== 'BaselineExperiment'
      || !baselineMethodIds.includes(config.method)
      || typeof config.benchmark !== 'string' || !config.benchmark.trim()) {
    throw new ProtocolError('Invalid BaselineExperiment')
  }
  for (const key of [
    'candidateBudget',
    'seed',
    'maximumUpdaterRequests',
    'maximumSolverRequests',
    'maximumWallSeconds',
    'maximumReflectionRounds',
  ]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new ProtocolError(`Invalid baseline ${key}`)
    }
  }
  if (config.maximumConcurrentTrials !== undefined
      && (!Number.isSafeInteger(config.maximumConcurrentTrials)
        || config.maximumConcurrentTrials < 1)) {
    throw new ProtocolError('Invalid baseline maximumConcurrentTrials')
  }
  const readAdapter = (name) => readConfigFile(resolveInside(
    repositoryRoot,
    config.adapters[name],
    `${name} adapter`,
  ))
  const [targetInput, updaterInput, providerInput, infrastructureInput] = await Promise.all([
    readAdapter('target'),
    readAdapter('updater'),
    readAdapter('provider'),
    readAdapter('infrastructure'),
  ])
  const target = validateTargetAdapter(targetInput)
  const updater = validateUpdaterAdapter(updaterInput)
  const provider = validateModelProviderAdapter(providerInput)
  const infrastructure = validateEnvironmentAdapter(infrastructureInput)
  if (target.solver.protocol !== 'msa-minimal-docker-v1'
      || updater.protocol !== 'codex-exec-v1') {
    throw new ProtocolError('Cowork baselines require the MSA solver and Codex updater')
  }
  for (const role of ['solver', 'updater']) {
    const model = config.models?.[role]
    if (!model || model.provider !== provider.id || typeof model.model !== 'string'
        || !model.model.trim() || !Number.isSafeInteger(model.maxTokens)
        || model.maxTokens < 1) {
      throw new ProtocolError(`Invalid baseline ${role} model`)
    }
  }
  const promptsResult = await runProcess(
    process.env.RSI_BASELINE_PYTHON ?? 'python3',
    [
      '-B',
      join(repositoryRoot, 'scripts/cowork-baseline-bridge.py'),
      'prompts',
      repositoryRoot,
    ],
    { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
  )
  const prompts = JSON.parse(promptsResult.stdout)
  const sources = await readConfigFile(join(repositoryRoot, 'baselines/sources.json'))
  const policy = validateEvaluationPolicy(await readConfigFile(resolveInside(
    repositoryRoot,
    config.policy,
    'policy',
  )))
  if (policy.decisionPartition !== 'selection' || policy.primaryMetric !== 'mean-reward') {
    throw new ProtocolError('Cowork baselines require the selection mean-reward policy')
  }
  return {
    config,
    target,
    updater,
    provider,
    infrastructure,
    prompts,
    sources,
    policy,
  }
}

export function formatPython(template, positional = [], named = {}) {
  let index = 0
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}/gu, (match, key) => {
    if (match === '{{') return '{'
    if (match === '}}') return '}'
    if (key === '') return String(positional[index++])
    if (!Object.hasOwn(named, key)) {
      throw new ProtocolError(`Unknown upstream prompt field: ${key}`)
    }
    return String(named[key])
  })
}

export async function createBaselineRuntime({
  bundle,
  release,
  repositoryRoot,
  runRoot,
  onEvent = () => {},
}) {
  const { config, target, updater, provider, infrastructure, prompts } = bundle
  const source = await resolveTargetSource({
    repositoryRoot,
    source: target.source,
    label: 'Baseline H0',
  })
  const docker = infrastructure.docker.backend === 'agentbay'
    ? new AgentBayDockerClient({ ...infrastructure.docker, repositoryRoot })
    : new DockerClient(infrastructure.docker)
  const gateway = new ModelGateway({
    config: {
      ...infrastructure.modelGateway,
      maximumRequestsPerRun: config.maximumSolverRequests,
      upstreamApiKeyEnvironment: provider.credentials.apiKeyEnvironment,
      upstreamBaseUrlEnvironment: provider.credentials.baseUrlEnvironment,
    },
    docker,
    repositoryRoot,
    scopeId: `baseline-${process.pid}-${Date.now()}`,
  })
  const solver = createSolverDriver({
    target,
    provider,
    docker,
    repositoryRoot,
    sourceRevision: source.revision,
    sourcePath: target.source.path,
    modelGateway: gateway,
  })
  const updaterDriver = createUpdaterDriver({
    updater,
    provider,
    repositoryRoot,
    docker,
    modelGateway: gateway,
  })
  const started = Date.now()
  const deadline = started + config.maximumWallSeconds * 1000
  let session = 0
  let transient = 0
  let reserved = 0
  let h0
  let h0Prompt
  const selections = new Map()
  const benchmark = release.benchmark
  const selectedTasks = new Set()

  const remainingTime = () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new BaselineBudgetExhausted('Baseline wall-clock budget exhausted')
    }
    return remaining
  }
  const checkBudget = async () => remainingTime()
  const baselineEnvironment = structuredClone(infrastructure)
  baselineEnvironment.task.maximumConcurrentTrials = Math.min(
    infrastructure.task.maximumConcurrentTrials,
    config.maximumConcurrentTrials ?? infrastructure.task.maximumConcurrentTrials,
  )
  const environment = new BaselineCoworkEnvironment({
    release,
    environment: baselineEnvironment,
    repositoryRoot,
    runRoot,
    docker,
    solver,
    model: config.models.solver,
    seed: config.seed,
    checkBudget: async () => {
      if (solver.usage().requests + target.solver.runtime.maximumSteps
          > config.maximumSolverRequests) {
        throw new BaselineBudgetExhausted('Baseline solver request budget exhausted')
      }
      return await checkBudget()
    },
  })

  async function snapshot(id, workspace) {
    const tree = await snapshotTree(workspace, target.mutation.limits)
    return { id, workspace, digest: treeDigest(tree) }
  }

  async function assertCandidate(candidate) {
    if (treeDigest(await snapshotTree(candidate.workspace, target.mutation.limits))
        !== candidate.digest) {
      throw new ProtocolError(`Candidate integrity failure: ${candidate.id}`)
    }
    const result = await validateCandidate({ workspace: candidate.workspace, target })
    if (!result.valid) {
      throw new ProtocolError('Candidate semantic validation failed', result.violations)
    }
  }

  async function clone(parent, id) {
    await assertCandidate(parent)
    const root = join(runRoot, 'candidates', id)
    await mkdir(root, { recursive: true })
    const workspace = join(root, 'workspace')
    await copyRegularTree(parent.workspace, workspace)
    return { root, workspace }
  }

  async function withPlaybook(current, state, id) {
    const copy = await clone(current, id)
    const appendix = state.bullets.length === 0
      ? ''
      : `\n\nACE playbook:\n${renderPlaybook(state)}\n\n`
        + 'When using a playbook bullet, cite its [id].\n'
    await writeFile(join(copy.workspace, 'profiles/cowork.md'), h0Prompt + appendix)
    const changes = diffSnapshots(
      await snapshotTree(h0.workspace),
      await snapshotTree(copy.workspace),
    )
    if (changes.some((change) => change.path !== 'profiles/cowork.md')) {
      throw new ProtocolError('ACE may change only profiles/cowork.md')
    }
    const candidate = await snapshot(id, copy.workspace)
    await assertCandidate(candidate)
    return candidate
  }

  async function codingSession({ current, prompt, evidence, writable, id }) {
    await checkBudget()
    const available = config.maximumUpdaterRequests - updaterDriver.usage().requests
    if (available < 1) {
      throw new BaselineBudgetExhausted('Baseline updater request budget exhausted')
    }
    updater.runtime.maximumModelRequests = Math.min(64, available)
    const copy = await clone(current, id)
    const before = await snapshotTree(copy.workspace, target.mutation.limits)
    const input = join(copy.root, 'input')
    const output = join(copy.root, 'output')
    await mkdir(input)
    const stagedEvidence = structuredClone(evidence)
    if (Array.isArray(stagedEvidence.cases)) {
      await mkdir(join(input, 'artifacts'))
      for (const [index, record] of stagedEvidence.cases.entries()) {
        if (release.all.get(record.instanceId)?.partition !== 'feedback') {
          throw new ProtocolError('Only Feedback artifacts may enter Updater context')
        }
        const trial = resolveInside(
          runRoot,
          relative(runRoot, record.trialRoot),
          'Feedback trial',
        )
        const name = `case-${index + 1}`
        await copyRegularTree(
          join(trial, 'submission'),
          join(input, 'artifacts', name),
        )
        record.artifactRoot = `${UPDATER_SANDBOX_PATHS.feedback}/artifacts/${name}`
        delete record.trialRoot
      }
    }
    const policy = mutationPolicyFor(target, 'l3')
    if (!writable) policy.spec.writable = []
    await Promise.all([
      writeFile(join(input, 'updater.md'), prompt),
      writeJsonFile(join(input, 'feedback-packet.json'), stagedEvidence),
      writeJsonFile(join(input, 'mutation-policy.json'), policy),
    ])
    let result
    try {
      result = await updaterDriver.run({
        model: config.models.updater,
        candidateWorkspace: copy.workspace,
        upstreamSource: source.root,
        candidateReadOnly: !writable,
        contextDirectory: input,
        outputDirectory: output,
        dshHome: join(copy.root, 'session'),
        mutationLevel: 'l3',
        targetId: target.id,
        reportName: 'result.json',
        name: id,
        timeoutMs: Math.min(3_600_000, remainingTime()),
        sessionTask: `Read ${UPDATER_SANDBOX_PATHS.feedback}/updater.md and follow its output schema. `
          + `Evidence is in ${UPDATER_SANDBOX_PATHS.feedback}/feedback-packet.json. `
          + `Write one JSON report to ${UPDATER_SANDBOX_PATHS.output}/result.json. `
          + (writable
            ? 'Edit only the paths permitted by mutation-policy.json.'
            : 'The candidate is read-only; analyze it without editing.'),
      })
    } catch (error) {
      if (updaterDriver.usage().requests >= config.maximumUpdaterRequests) {
        throw new BaselineBudgetExhausted('Baseline updater request budget exhausted')
      }
      if (Date.now() >= deadline) {
        throw new BaselineBudgetExhausted('Baseline wall-clock budget exhausted')
      }
      throw error
    }
    await writeJsonFile(join(copy.root, 'session-audit.json'), {
      report: result.report,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    })
    const changes = diffSnapshots(
      before,
      await snapshotTree(copy.workspace, target.mutation.limits),
    )
    if (!writable && changes.length) {
      throw new ProtocolError('Analysis role modified the candidate')
    }
    if (writable && changes.length) {
      const check = enforceMutationPolicy(changes, policy)
      if (!check.valid) {
        return {
          candidate: null,
          report: { status: 'invalid-diff', violations: check.violations },
        }
      }
      const semantics = await validateCandidate({ workspace: copy.workspace, target })
      if (!semantics.valid) {
        return {
          candidate: null,
          report: { status: 'invalid-code', violations: semantics.violations },
        }
      }
    }
    return { candidate: await snapshot(id, copy.workspace), report: result.report }
  }

  const runtime = {
    async preflight() {
      await docker.info()
      const environmentStatus = await environment.preflight()
      await updaterDriver.ensureRuntime()
      return {
        sourceRevision: source.revision,
        benchmarkSourceRevision: environmentStatus.sourceRevision,
        release: release.id,
        method: config.method,
        methodVariant: getBaselineMethod(config.method).variant,
      }
    },

    async initialize() {
      await runtime.preflight()
      const workspace = join(runRoot, 'candidates/h0/workspace')
      await mkdir(join(runRoot, 'candidates/h0'), { recursive: true })
      await materializeCandidate({
        repositoryRoot,
        target,
        sourceRoot: source.root,
        destination: workspace,
      })
      h0 = await snapshot('h0', workspace)
      await assertCandidate(h0)
      h0Prompt = await readFile(join(workspace, 'profiles/cowork.md'), 'utf8')
      await writeJsonFile(join(runRoot, 'identity.json'), {
        experiment: config,
        release: release.id,
        sourceRevision: source.revision,
        h0,
      })
      return h0
    },

    checkBudget,

    async reserveCandidate(iteration) {
      if (iteration !== reserved + 1 || iteration > config.candidateBudget) {
        throw new ProtocolError('Candidate budget exceeded')
      }
      reserved = iteration
      await writeJsonFile(join(runRoot, 'budget.json'), {
        reserved,
        updaterUsage: updaterDriver.usage(),
      })
      onEvent(`candidate ${iteration}/${config.candidateBudget}`)
    },

    assertCandidate,

    async selection(candidate) {
      if (selections.has(candidate.id)) {
        throw new ProtocolError('Candidate selection already evaluated')
      }
      const records = await environment.runPartition(candidate, 'selection')
      const result = selectionAggregate(records)
      selections.set(candidate.id, records)
      return result
    },

    async promotion({ champion, candidate }) {
      const records = (id) => validateResultRecords(selections.get(id).map((record) => ({
        instance_id: record.instanceId,
        status: record.correct ? 'resolved' : 'unresolved',
        reward: record.reward,
        seed_controlled: false,
      })), benchmark, id)
      const evaluated = evaluateBenchmark({
        benchmark,
        policy: bundle.policy,
        run: {
          id: config.method,
          baselineRevision: champion.id,
          candidateRevision: candidate.id,
        },
        baselineRecords: records(champion.id),
        candidateRecords: records(candidate.id),
        partitions: ['selection'],
      })
      await writeJsonFile(
        join(runRoot, 'candidates', candidate.id, 'selection-evaluation.json'),
        evaluated,
      )
      return evaluated.decision.eligible
    },

    async feedback(candidate, ids) {
      for (const id of ids) {
        if (!release.partitions.feedback.some((row) => row.instance_id === id)) {
          throw new ProtocolError('Updater evidence must come from feedback partition')
        }
        selectedTasks.add(id)
      }
      const completeFeedback = ids.length === release.partitions.feedback.length
        && ids.every((id) => release.partitions.feedback.some((row) => row.instance_id === id))
      return completeFeedback
        ? await environment.runPartition(candidate, 'feedback')
        : await environment.runTasks(candidate, ids)
    },

    async generate({ state, reflection, current, taskId, iteration, phase }) {
      selectedTasks.add(taskId)
      const candidate = await withPlaybook(current, state, `ace-rollout-${++transient}`)
      const generated = await environment.runTask(candidate, taskId, { reflection })
      generated.bulletIds = usedBulletIds(generated.trace, state)
      await writeJsonFile(join(runRoot, 'candidates', candidate.id, 'phase.json'), {
        iteration,
        phase,
      })
      return generated
    },

    async reflect({ state, generated, iteration, round }) {
      const used = state.bullets.filter((bullet) => generated.bulletIds.includes(bullet.id))
        .map((bullet) => `[${bullet.id}] helpful=${bullet.helpful} harmful=${bullet.harmful} :: ${bullet.content}`)
        .join('\n')
      const prompt = formatPython(prompts.REFLECTOR_PROMPT_NO_GT, [
        generated.instruction,
        generated.trace,
        generated.answer,
        JSON.stringify(generated.verifier),
        used || '(No bullets used by generator)',
      ])
      const result = await codingSession({
        current: h0,
        prompt,
        evidence: { partition: 'feedback', iteration, round, cases: [generated] },
        writable: false,
        id: `ace-reflect-${++session}`,
      })
      if (!Array.isArray(result.report.bullet_tags)) {
        throw new ProtocolError('ACE Reflector omitted bullet_tags')
      }
      return result.report
    },

    async curate({ state, reflection, generated, taskId, iteration }) {
      const prompt = formatPython(prompts.CURATOR_PROMPT_NO_GT, [], {
        token_budget: 80_000,
        current_step: iteration,
        total_samples: release.partitions.feedback.length,
        playbook_stats: JSON.stringify({ total_bullets: state.bullets.length }),
        recent_reflection: JSON.stringify(reflection),
        current_playbook: renderPlaybook(state),
        question_context: generated.instruction,
      })
      const result = await codingSession({
        current: h0,
        prompt,
        evidence: { partition: 'feedback', taskId },
        writable: false,
        id: `ace-curate-${++session}`,
      })
      return result.report
    },

    materializePlaybook: ({ current, state, iteration }) => withPlaybook(
      current,
      state,
      `ace-${iteration}`,
    ),

    async evolve({ current, evidence, history, iteration }) {
      const prompt = `${prompts.EVO_IDENTITY}\n\n${prompts.EVO_WORKFLOW}\n\n`
        + 'Cowork adaptation: visible validation maps to Feedback; Selection exposes aggregate scores only. '
        + 'This session submits one candidate. The current revision continues after regressions while the '
        + 'Controller retains the best Selection checkpoint. Prior feedback and reports are in the feedback '
        + 'packet: cases are the latest validation pass and history preserves prior reports. '
        + 'Edit only mutation-policy paths and return JSON with diagnosis, hypothesis, changedFiles, '
        + 'expectedImpact, validation, and remainingRisks.'
      return await codingSession({
        current,
        prompt,
        evidence: {
          partition: 'feedback',
          iteration,
          maximumIterations: config.candidateBudget,
          cases: evidence,
          history,
        },
        writable: true,
        id: `evo-${iteration}`,
      })
    },

    async checkpoint(state) {
      await writeJsonFile(join(runRoot, `checkpoint-${state.iteration}.json`), state)
      await writeJsonFile(join(runRoot, 'usage.json'), runtime.usage())
    },

    async freeze({ champion, h0: baseline, current, history }) {
      await assertCandidate(champion)
      await assertCandidate(baseline)
      const frozen = {
        champion,
        h0: baseline,
        current,
        history,
        experiment: config,
        release: release.id,
        method: config.method,
        methodVariant: getBaselineMethod(config.method).variant,
      }
      await writeFile(
        join(runRoot, 'frozen.json'),
        `${JSON.stringify(frozen, null, 2)}\n`,
        { flag: 'wx', mode: 0o400 },
      )
      return {
        championId: champion.id,
        h0Id: baseline.id,
        path: join(runRoot, 'frozen.json'),
      }
    },

    usage() {
      return {
        candidatesConsumed: reserved,
        solverRollouts: environment.trials,
        feedbackTasksSeen: selectedTasks.size,
        solver: solver.usage(),
        updater: updaterDriver.usage(),
        wallTimeMs: Date.now() - started,
        costUsd: null,
      }
    },

    async final(frozen) {
      if (JSON.stringify(frozen.experiment) !== JSON.stringify(config)
          || frozen.release !== release.id) {
        throw new ProtocolError('Final configuration differs from the frozen run')
      }
      await environment.preflight()
      return await evaluateFrozenFinal(frozen)
    },

    async crossFinal(frozen) {
      if (frozen.method !== config.method) {
        throw new ProtocolError('Cross-final baseline method differs from the source run')
      }
      await environment.preflight()
      return await evaluateFrozenFinal(frozen)
    },

    async close() {
      await gateway.stop()
    },
  }

  async function evaluateFrozenFinal(frozen) {
      const candidates = frozen.h0.id === frozen.champion.id
        ? [frozen.h0]
        : [frozen.h0, frozen.champion]
      environment.authorizeFinal(candidates)
      const results = []
      for (const candidate of candidates) {
        await assertCandidate(candidate)
        const records = await environment.runPartition(candidate, 'final')
        results.push([candidate.id, records])
      }
      return Object.fromEntries(results)
  }
  return runtime
}
