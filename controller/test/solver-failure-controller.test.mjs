import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { capturePopulationBundle, createCoworkBranchEvolutionDriver, finalizeEvolution } from '../src/cowork-orchestrator.mjs'
import { captureExecutionIdentity, evolutionFingerprint } from '../src/execution-identity.mjs'
import { normalizeEvolutionRecipe } from '../src/evolution-recipe.mjs'
import { PopulationOrchestrator } from '../src/population-orchestrator.mjs'
import { stageUpdaterContext } from '../src/runtimes/dsh.mjs'
import { runProcess } from '../src/process.mjs'
import { runtimeFixture, failingRun, hash, repositoryRoot, startFixtureGateway } from './fixtures/solver-failure-runtime.mjs'

function recipe(mode) {
  const competition = ['competition', 'combined'].includes(mode)
  return normalizeEvolutionRecipe({ apiVersion: 'harness-rsi/v1alpha1', kind: 'EvolutionRecipe', spec: {
    moduleSearch: { authority: 'updater-directed', riskCeiling: 'l3', strategy: null },
    population: {
      mode, concurrency: { n_branches: mode === 'single' ? 1 : 2 },
      budget: { total_budget: mode === 'single' ? 2 : 4, beta: competition ? 0.5 : 0 },
      peer_sharing: { enabled: ['mutualism', 'combined'].includes(mode) },
      competition: { enabled: competition, bonus_grant_unit: 1 },
    },
  } })
}

function zeroUsage(requests) {
  return { complete: true, requests, usageResponses: requests, unknownUsageResponses: 0,
    inputTokens: requests, outputTokens: requests, totalTokens: requests * 2,
    observedInputTokens: requests, observedOutputTokens: requests, cacheReadTokens: 0, reasoningTokens: 0 }
}

async function branchFixture(t, {
  mode = 'single', providerFailure = false, failureBranch = null, invalidProposal = false,
  allowRuntimeFailurePromotion = false,
} = {}) {
  const fixture = await runtimeFixture(t)
  const bundle = fixture.bundle
  bundle.recipe = recipe(mode)
  bundle.benchmark = fixture.benchmark
  bundle.experiment.baselinePack = null
  bundle.experimentPath = 'fixture-experiment.json'
  bundle.target.materialization = { ...bundle.target.materialization,
    protocol: 'controller-owned-overlay-v1', baselinePath: 'fixture-candidate' }
  bundle.environment.task.environmentAssets = 'fixture-assets'
  bundle.policy.bootstrap.samples = 100
  if (allowRuntimeFailurePromotion) {
    bundle.policy.gates.safety.maximumSolverFailures = null
    bundle.policy.gates.quality.minimumRewardImproved = 0
  }
  const prompt = join(fixture.root, bundle.updater.promptPath)
  await mkdir(dirname(prompt), { recursive: true })
  await writeFile(prompt, await readFile(join(repositoryRoot, bundle.updater.promptPath)))
  for (const key of ['RSI_PROVIDER_API_KEY', 'RSI_PROVIDER_BASE_URL']) {
    const old = process.env[key]
    process.env[key] = key.endsWith('KEY') ? 'fixture-key-never-real' : fixture.gateway.url
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  const packets = new Map()
  const updateCounts = new Map()
  let revision = 'a'.repeat(40)
  const frozen = await capturePopulationBundle(bundle, fixture.root)
  const contextFactory = async ({ experimentPath, gatewayScope }) => {
    const gatewayModes = new Map(fixture.modes)
    const gateway = await startFixtureGateway(t, { modes: gatewayModes })
    let updaterCalls = 0
    const updater = {
      async ensureRuntime() { return {} },
      async stageContext(options) {
        const list = packets.get(gatewayScope) ?? []
        list.push(structuredClone(options.feedbackPacket))
        packets.set(gatewayScope, list)
        assert.ok(options.mutationPolicy.spec.writable.includes('model.py'))
        assert.ok(options.mutationPolicy.spec.writable.includes('run.py'))
        return stageUpdaterContext(options)
      },
      async run(options) {
        updaterCalls += 1
        const total = (updateCounts.get(gatewayScope) ?? 0) + 1
        updateCounts.set(gatewayScope, total)
        const original = await readFile(join(options.candidateWorkspace, 'run.py'), 'utf8')
        const content = total >= 2 ? original.replace('answer = json.loads(text)', 'answer = text') : original
        await writeFile(join(options.candidateWorkspace, 'run.py'), `${content}\n# fixture candidate ${total}\n`)
        if (providerFailure && total === 1 && (!failureBranch || gatewayScope.endsWith(failureBranch))) {
          gatewayModes.set('valid', 'http502')
        }
        return { stdout: 'fixture updater', stderr: '', report: {
          diagnosis: '读取真实 Driver 产生的训练错误与失败 Candidate 证据',
          hypothesis: 'fixture 验证回退代码后保留失败经验', changedFiles: invalidProposal && total === 1 ? [] : ['run.py'],
          expectedImpact: '修正候选自己的解析契约', remainingRisks: 'fixture 不代表真实 benchmark 提分',
        } }
      },
      usage() { return zeroUsage(updaterCalls) },
    }
    return {
      bundle, sourceRoot: fixture.candidate, targetSourceRoot: fixture.candidate,
      sourceRevision: bundle.target.source.revision, targetSourceRevision: bundle.target.source.revision,
      updaterSourceRevision: bundle.updater.runtime.distributionDigest,
      absoluteExperimentPath: experimentPath, docker: fixture.docker,
      solverDriver: fixture.createDriver(gateway), updaterDriver: updater, modelGateway: gateway,
      searchStrategy: { id: 'fixture', async preflight() {}, descriptor() { return { id: 'fixture' } } },
    }
  }
  const createBranch = (branchId, runRoot) => createCoworkBranchEvolutionDriver({
    repositoryRoot: fixture.root, experimentPath: join(fixture.root, 'fixture-experiment.json'),
    runId: `fixture-${mode}-${branchId}`, branchId, runRootOverride: runRoot, expectedBundleDigest: frozen.digest,
  }, { contextFactory, environmentFactory: fixture.environmentFactory, controllerRevisionReader: async () => revision })
  return { ...fixture, bundle, frozen, createBranch, packets, updateCounts,
    changeAuditRevision() { revision = 'b'.repeat(40) } }
}

test('完整 Controller 闭环：Champion 训练失败进入 Updater，Rejected 详细病例进入下一轮且允许 L3', async (t) => {
  const fixture = await branchFixture(t)
  const runRoot = join(fixture.root, 'branch-run')
  const branch = fixture.createBranch('branch-001', runRoot)
  const initial = await branch.initialize()
  assert.equal(initial.incumbent.evaluation.primary.value, 0.5)
  await branch.advanceOne({ stepId: 'fixture-step-1', coordination: {} })
  const once = JSON.parse(await readFile(join(runRoot, 'state.json')))
  assert.equal(once.spec.generationsCompleted, 1)
  assert.equal(once.spec.championId, 'h0')
  assert.equal(once.spec.candidates[1].status, 'rejected')
  assert.ok(once.spec.candidates[1].decision.gates.some((gate) => gate.id === 'maximum-solver-failures' && !gate.passed))
  fixture.changeAuditRevision()
  const restore = fixture.createBranch('branch-001', runRoot)
  await restore.restore()
  assert.equal(JSON.parse(await readFile(join(runRoot, 'state.json'))).spec.resumeAudit[0].currentRevision, 'b'.repeat(40))
  const second = await restore.advanceOne({ stepId: 'fixture-step-2', coordination: {} })
  assert.equal(second.budgetConsumed, 1)
  const packets = [...fixture.packets.values()][0]
  assert.equal(packets.length, 2)
  assert.equal(packets[0].spec.cases[0].solverFailures[0].category, 'candidate')
  assert.equal(packets[1].spec.rejectedCandidateEvidence.source.candidateId, 'g001-l3')
  assert.equal(packets[1].spec.rejectedCandidateEvidence.source.digest, once.spec.candidates[1].digest)
  assert.equal(packets[1].spec.rejectedCandidateEvidence.cases[0].solverFailures[0].category, 'candidate')
  assert.equal(packets[1].metadata.candidateId, 'h0')
  const state = JSON.parse(await readFile(join(runRoot, 'state.json')))
  assert.equal(state.spec.controllerRevision, 'a'.repeat(40))
  assert.equal(state.spec.resumeAudit[0].currentRevision, 'b'.repeat(40))
  assert.equal(state.spec.resumeAudit[0].reason, 'identical-executed-content')
  assert.equal(state.spec.generationsCompleted, 2)
  assert.equal(state.spec.candidates[2].decision.gates.find((gate) => gate.id === 'maximum-solver-failures').passed, true)
  assert.equal(state.spec.ledger.candidatesEvaluated, 2)
  const record = JSON.parse(await readFile(join(runRoot, 'results/generation-2/g002-l3-feedback.jsonl')))
  const diagnostics = JSON.parse(await readFile(join(runRoot, record.artifacts[0].root, 'solver-diagnostics.json')))
  assert.equal(diagnostics.context.candidateId, 'g002-l3')
  assert.equal(diagnostics.complete, true)
  assert.ok(diagnostics.requests[0].requestId)
  assert.equal(await readFile(join(runRoot, 'candidates/h0/workspace/run.py'), 'utf8'), failingRun)
  await restore.advanceOne({ stepId: 'fixture-step-2', coordination: {} })
  assert.equal([...fixture.updateCounts.values()][0], 2)
})

test('Provider 暂停后跨实例恢复同一 proposal，不重复调用 Updater 或扣 Candidate budget', async (t) => {
  const fixture = await branchFixture(t, { providerFailure: true })
  const runRoot = join(fixture.root, 'branch-run')
  const first = fixture.createBranch('branch-001', runRoot)
  await first.initialize()
  await assert.rejects(first.advanceOne({ stepId: 'fixture-step-1', coordination: {} }))
  const paused = JSON.parse(await readFile(join(runRoot, 'state.json')))
  assert.equal(paused.spec.generationsCompleted, 0)
  assert.equal(paused.spec.inFlight.proposal.id, 'g001-l3')
  assert.equal(paused.spec.ledger.updaterUsage.requests, 1)
  fixture.modes.set('valid', 'valid')
  const restored = fixture.createBranch('branch-001', runRoot)
  await restored.restore()
  const result = await restored.advanceOne({ stepId: 'fixture-step-1', coordination: {} })
  assert.equal(result.budgetConsumed, 1)
  assert.equal([...fixture.updateCounts.values()][0], 1)
  const done = JSON.parse(await readFile(join(runRoot, 'state.json')))
  assert.equal(done.spec.candidates[1].digest, paused.spec.inFlight.proposal.digest)
  assert.equal(done.spec.generationsCompleted, 1)
  assert.equal(done.spec.ledger.updaterUsage.requests, 1)
})

test('非法 Mutation Report 同样保存 Candidate Digest/差异证据，拒绝后消耗一轮预算并可恢复修复', async (t) => {
  const fixture = await branchFixture(t, { invalidProposal: true })
  const runRoot = join(fixture.root, 'branch-run')
  const branch = fixture.createBranch('branch-001', runRoot)
  await branch.initialize()
  const first = await branch.advanceOne({ stepId: 'fixture-step-1', coordination: {} })
  assert.equal(first.budgetConsumed, 1)
  const state = JSON.parse(await readFile(join(runRoot, 'state.json')))
  assert.equal(state.spec.candidates[1].status, 'invalid-proposal')
  assert.match(state.spec.candidates[1].digest, /^[0-9a-f]{64}$/u)
  const restored = fixture.createBranch('branch-001', runRoot)
  await restored.restore()
  await restored.advanceOne({ stepId: 'fixture-step-2', coordination: {} })
  const evidence = [...fixture.packets.values()][0][1].spec.rejectedCandidateEvidence
  assert.equal(evidence.source.candidateId, 'g001-l3')
  assert.equal(evidence.mutationFailure.stage, 'update-and-diff')
  assert.ok(evidence.code.some((entry) => entry.path === 'run.py'))
})

test('显式关闭运行失败晋升 Gate 时只遵守冻结 rubric/质量策略，不隐式修改分数', async (t) => {
  const fixture = await branchFixture(t, { allowRuntimeFailurePromotion: true })
  const runRoot = join(fixture.root, 'branch-run')
  const branch = fixture.createBranch('branch-001', runRoot)
  await branch.initialize()
  await branch.advanceOne({ stepId: 'fixture-step-1', coordination: {} })
  const state = JSON.parse(await readFile(join(runRoot, 'state.json')))
  assert.equal(state.spec.championId, 'g001-l3')
  assert.equal(state.spec.candidates[1].evaluation.primary.value, 0.5)
  assert.equal(state.spec.candidates[1].decision.gates.some((gate) => gate.id === 'maximum-solver-failures'), false)
})

test('双 Branch 一支已结算另一支 Provider 暂停，Population 恢复不重跑已完成支或重复扣预算', async (t) => {
  const fixture = await branchFixture(t, { mode: 'independent', providerFailure: true, failureBranch: 'branch-002' })
  const campaignsRoot = join(fixture.root, 'campaigns')
  await mkdir(campaignsRoot)
  const options = {
    loadedCampaign: { config: fixture.frozen.snapshot, recipe: fixture.bundle.recipe,
      configDigest: fixture.frozen.digest, fingerprint: hash('fixture-partial-branch') },
    campaignsRoot, campaignId: 'fixture-partial-branch', frozenConfig: fixture.frozen.snapshot,
    createBranch({ branchId, branchesRoot }) {
      return fixture.createBranch(branchId, join(branchesRoot, branchId, 'run'))
    },
  }
  const first = new PopulationOrchestrator(options)
  await first.initialize()
  const paused = await first.run()
  assert.equal(paused.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(fixture.updateCounts.get('fixture-independent-branch-001'), 1)
  assert.equal(fixture.updateCounts.get('fixture-independent-branch-002'), 1)
  const restored = new PopulationOrchestrator(options)
  const done = await restored.resume()
  assert.notEqual(done.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(done.budget.consumed, 4)
  assert.equal(fixture.updateCounts.get('fixture-independent-branch-001'), 2)
  assert.equal(fixture.updateCounts.get('fixture-independent-branch-002'), 2)
})

test('五种 Mode 均将可确认 Solver 失败正常结算并消耗预算，不进入基础设施暂停', async (t) => {
  for (const mode of ['single', 'independent', 'mutualism', 'competition', 'combined']) {
    await t.test(mode, async (child) => {
      const fixture = await branchFixture(child, { mode })
      const campaignsRoot = join(fixture.root, '.rsi/runs/populations')
      await mkdir(campaignsRoot, { recursive: true })
      const executionIdentity = await captureExecutionIdentity(fixture.root)
      const orchestrator = new PopulationOrchestrator({
        loadedCampaign: { config: fixture.frozen.snapshot, recipe: fixture.bundle.recipe,
          configDigest: fixture.frozen.digest,
          fingerprint: evolutionFingerprint({ executionIdentity, configDigest: fixture.frozen.digest }) },
        campaignsRoot, campaignId: `fixture-${mode}`, frozenConfig: fixture.frozen.snapshot,
        createBranch({ branchId, branchesRoot }) {
          return fixture.createBranch(branchId, join(branchesRoot, branchId, 'run'))
        },
      })
      await orchestrator.initialize()
      const result = await orchestrator.run()
      assert.notEqual(result.status, 'PAUSED_INFRASTRUCTURE', JSON.stringify(result.lastError))
      assert.equal(result.budget.consumed, fixture.bundle.recipe.spec.population.budget.total_budget)
      for (const packets of fixture.packets.values()) {
        assert.ok(packets[0].spec.cases[0].solverFailures.length > 0)
        if (packets.length > 1) assert.ok(packets[1].spec.rejectedCandidateEvidence)
      }
      if (mode === 'single') {
        await runProcess('git', ['-C', fixture.root, 'init', '-q'])
        await runProcess('git', ['-C', fixture.root, '-c', 'user.name=Fixture',
          '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
          'commit', '--allow-empty', '-q', '-m', 'fixture final authorization'])
        // 使用真实 Final 授权入口验证新指纹；在不存在的 fixture 配置处停止，不领取 Final。
        await assert.rejects(finalizeEvolution({
          repositoryRoot: fixture.root, runDirectory: join(campaignsRoot, 'fixture-single'),
        }), (error) => error.message === `配置文件 不存在：${join(fixture.root, 'fixture-experiment.json')}`)
      }
    })
  }
})
