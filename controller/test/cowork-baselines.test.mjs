import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyCuratorOperations,
  emptyPlaybook,
  renderPlaybook,
  trainAceSample,
  updateBulletCounts,
  usedBulletIds,
} from '../src/baselines/ace.mjs'
import { BaselineCoworkEnvironment, loadCoworkBenchmark } from '../src/baselines/benchmark.mjs'
import { BaselineBudgetExhausted } from '../src/baselines/budget.mjs'
import { anytimeValidation, runBaseline } from '../src/baselines/loop.mjs'
import { baselineMethodIds, getBaselineMethod } from '../src/baselines/methods/index.mjs'
import { pairedReport, winnerReport } from '../src/baselines/report.mjs'
import { formatPython, loadBaselineConfiguration } from '../src/baselines/runtime.mjs'
import { REPOSITORY_ROOT } from '../src/config.mjs'

const additions = [{
  type: 'ADD',
  section: 'FORMULAS & CALCULATIONS',
  content: 'Recompute totals.',
}]

test('baseline methods are explicit, independently registered components', () => {
  assert.deepEqual(baselineMethodIds, ['ace-batched', 'ace', 'evo-bench', 'evo-bench-paper'])
  assert.equal(getBaselineMethod('ace-batched').id, 'ace-batched')
  assert.equal(getBaselineMethod('ace').id, 'ace')
  assert.equal(getBaselineMethod('evo-bench').id, 'evo-bench')
  assert.equal(getBaselineMethod('evo-bench-paper').id, 'evo-bench-paper')
  assert.throws(() => getBaselineMethod('unknown'), /Unknown baseline method/u)
})

test('ACE appends playbook bullets and updates counters without mutating prior state', () => {
  const original = emptyPlaybook()
  const first = applyCuratorOperations(original, additions)
  const id = first.bullets[0].id
  const updated = updateBulletCounts(first, [{ id, tag: 'helpful' }], [id])
  assert.deepEqual(original, emptyPlaybook())
  assert.equal(id, 'calc-00001')
  assert.equal(updated.bullets[0].helpful, 1)
  assert.equal(first.bullets[0].helpful, 0)
  assert.match(renderPlaybook(updated), /Recompute totals/u)
})

test('ACE supports the serial Curator ADD operation only', () => {
  const state = applyCuratorOperations(emptyPlaybook(), additions)
  for (const type of ['UPDATE', 'MERGE', 'DELETE']) {
    assert.throws(
      () => applyCuratorOperations(state, [{ type, content: 'rewrite' }]),
      /ADD only/u,
    )
  }
})

test('ACE bullet use is extracted from model responses', () => {
  const state = applyCuratorOperations(emptyPlaybook(), additions)
  const trace = [
    { type: 'tool', content: '[calc-00001]' },
    { type: 'model', content: 'Use [calc-00001].' },
  ].map(JSON.stringify).join('\n')
  assert.deepEqual(usedBulletIds(trace, state), ['calc-00001'])
})

test('ACE reflects successful output and runs post-curation generation', async () => {
  const calls = []
  let curatedInstruction = null
  const result = await trainAceSample({
    state: emptyPlaybook(),
    generate: async ({ phase, reflection }) => {
      calls.push([phase, reflection])
      return { correct: true, bulletIds: [], instruction: 'fixture task' }
    },
    reflect: async () => {
      calls.push('reflect')
      return { bullet_tags: [], key_insight: 'check totals' }
    },
    curate: async ({ generated }) => {
      calls.push('curate')
      curatedInstruction = generated.instruction
      return { operations: additions }
    },
  })
  assert.deepEqual(calls, [
    ['initial', null],
    'reflect',
    'curate',
    ['post-curate', null],
  ])
  assert.equal(curatedInstruction, 'fixture task')
  assert.equal(result.state.bullets.length, 1)
})

function fakeRuntime(scores) {
  const seen = {
    parents: [],
    reservations: [],
    feedback: [],
    freezes: [],
  }
  const runtime = {
    initialize: async () => ({ id: 'h0' }),
    checkBudget: async () => {},
    reserveCandidate: async (iteration) => seen.reservations.push(iteration),
    selection: async (candidate) => ({
      meanReward: scores[Number(candidate.id.slice(1)) || 0],
      count: 30,
    }),
    promotion: async () => true,
    assertCandidate: async () => {},
    feedback: async (candidate, ids) => {
      seen.feedback.push([candidate.id, ids])
      return [{ candidateId: candidate.id, trace: 'feedback' }]
    },
    evolve: async ({ current, iteration }) => {
      seen.parents.push(current.id)
      return {
        candidate: { id: `c${iteration}` },
        report: { hypothesis: `h${iteration}` },
      }
    },
    checkpoint: async () => {},
    freeze: async (state) => {
      seen.freezes.push(state)
      return { championId: state.champion.id }
    },
  }
  return { runtime, seen }
}

test('Evo-Bench continues from regressions while retaining a separate champion', async () => {
  const { runtime, seen } = fakeRuntime([0.5, 0.7, 0.4, 0.6])
  const result = await runBaseline({
    method: 'evo-bench',
    budget: 3,
    feedbackIds: ['train'],
    runtime,
  })
  assert.deepEqual(seen.parents, ['h0', 'c1', 'c2'])
  assert.deepEqual(seen.reservations, [1, 2, 3])
  assert.equal(result.frozen.championId, 'c1')
  assert.equal(seen.freezes[0].current.id, 'c3')
})

test('EvoBench reuses fixed H0 evidence across four rounds on the same Selection suite', async () => {
  const { runtime, seen } = fakeRuntime([0.5, 0.7, 0.4, 0.6, 0.8])
  const feedbackIds = Array.from({ length: 90 }, (_, index) => `feedback-${index}`)
  const validationIds = Array.from({ length: 30 }, (_, index) => `selection-${index}`)
  const validations = []
  const evolve = runtime.evolve
  runtime.validationPartition = 'selection'
  runtime.validation = async (candidate, ids) => {
    validations.push([candidate.id, ids])
    const score = await runtime.selection(candidate)
    return ids.map((instanceId) => ({ instanceId, reward: score.meanReward }))
  }
  runtime.evolve = async (options) => {
    assert.equal(options.evidence[0].candidateId, 'h0')
    assert.equal(options.history.length, options.iteration - 1)
    return evolve(options)
  }
  const result = await runBaseline({
    method: 'evo-bench-paper', budget: 4, feedbackIds, validationIds, runtime,
  })
  assert.deepEqual(seen.feedback, [['h0', feedbackIds]])
  assert.deepEqual(validations, ['h0', 'c1', 'c2', 'c3', 'c4'].map((id) => [id, validationIds]))
  assert.deepEqual(seen.parents, ['h0', 'c1', 'c2', 'c3'])
  assert.equal(result.scorePartition, 'selection')
  assert.equal(result.frozen.championId, 'c4')
  assert.ok(Math.abs(result.championSelection.meanReward - 0.8) < 1e-12)
  assert.equal(result.championSelection.count, 30)
})

test('baseline retries failed proposals three times and continues from the last evaluated parent', async () => {
  const { runtime, seen } = fakeRuntime([0.5, 0.6, 0.7, 0.8])
  const attempts = [0, 0, 0, 0]
  const evolve = runtime.evolve
  runtime.evolve = async (options) => {
    attempts[options.iteration] += 1
    if (options.iteration === 1 && attempts[1] < 3) throw new Error('temporary updater failure')
    if (options.iteration === 2) throw new Error('updater unavailable')
    return evolve(options)
  }
  await runBaseline({ method: 'evo-bench', budget: 3, feedbackIds: ['train'], runtime })
  assert.deepEqual(attempts.slice(1), [3, 3, 1])
  assert.deepEqual(seen.parents, ['h0', 'c1'])
  const history = seen.freezes[0].history
  assert.equal(history.length, 3)
  assert.equal(history[1].status, 'error')
  assert.equal(history[2].parentId, 'c1')
})

test('baseline does not retry an exhausted updater budget', async () => {
  const { runtime } = fakeRuntime([0.5])
  let attempts = 0
  runtime.evolve = async () => {
    attempts += 1
    throw new BaselineBudgetExhausted('updater budget')
  }
  const result = await runBaseline({ method: 'evo-bench', budget: 4, feedbackIds: ['train'], runtime })
  assert.equal(attempts, 1)
  assert.equal(result.frozen.championId, 'h0')
  assert.equal(result.stopReason, 'updater budget')
})

test('baseline preserves the previous parent when candidate evaluation fails', async () => {
  const { runtime, seen } = fakeRuntime([0.5, 0.7, 0.8])
  const selection = runtime.selection
  const evidenceParents = []
  const evolve = runtime.evolve
  runtime.selection = async (candidate) => {
    if (candidate.id === 'c1') throw new Error('evaluation interrupted')
    return selection(candidate)
  }
  runtime.evolve = async (options) => {
    evidenceParents.push(options.evidence[0].candidateId)
    return evolve(options)
  }
  await runBaseline({ method: 'evo-bench', budget: 2, feedbackIds: ['train'], runtime })
  assert.deepEqual(seen.parents, ['h0', 'h0'])
  assert.deepEqual(evidenceParents, ['h0', 'h0'])
  assert.equal(seen.freezes[0].history[0].status, 'error')
})

test('baseline propagates checkpoint failures without duplicating history', async () => {
  const { runtime, seen } = fakeRuntime([0.5, 0.7])
  let checkpoints = 0
  runtime.checkpoint = async ({ history }) => {
    checkpoints += 1
    assert.equal(history.length, 1)
    throw new Error('checkpoint write failed')
  }
  await assert.rejects(
    runBaseline({ method: 'evo-bench', budget: 2, feedbackIds: ['train'], runtime }),
    /checkpoint write failed/u,
  )
  assert.equal(checkpoints, 1)
  assert.equal(seen.freezes.length, 0)
})

test('ACE full-pass traversal consumes every feedback task across bounded checkpoints', async () => {
  const taskIds = Array.from({ length: 9 }, (_, index) => `task-${index + 1}`)
  const visited = []
  const runtime = {
    initialize: async () => ({ id: 'h0' }),
    checkBudget: async () => {},
    reserveCandidate: async () => {},
    selection: async () => ({ meanReward: 0.5, count: 30 }),
    promotion: async () => true,
    assertCandidate: async () => {},
    generate: async ({ taskId }) => {
      visited.push(taskId)
      return { correct: true, bulletIds: [], instruction: taskId }
    },
    reflect: async () => ({ bullet_tags: [] }),
    curate: async () => ({ operations: [] }),
    materializePlaybook: async ({ iteration }) => ({ id: `c${iteration}` }),
    checkpoint: async () => {},
    freeze: async ({ champion }) => ({ championId: champion.id }),
  }
  await runBaseline({
    method: 'ace',
    budget: 4,
    feedbackIds: taskIds,
    feedbackTraversal: 'full-pass',
    runtime,
  })
  assert.deepEqual([...new Set(visited)], taskIds)
  assert.equal(visited.length, taskIds.length * 2)
})

test('Batched ACE reuses one H0 Feedback pass across deterministic playbook updates', async () => {
  const taskIds = Array.from({ length: 9 }, (_, index) => `task-${index + 1}`)
  const batches = []
  let feedbackRuns = 0
  const runtime = {
    initialize: async () => ({ id: 'h0' }),
    checkBudget: async () => {},
    reserveCandidate: async () => {},
    selection: async () => ({ meanReward: 0.5, count: 30 }),
    promotion: async () => true,
    assertCandidate: async () => {},
    feedback: async (_candidate, ids) => {
      feedbackRuns += 1
      return ids.map((instanceId) => ({ instanceId }))
    },
    curateBatch: async ({ cases }) => {
      batches.push(cases.map((record) => record.instanceId))
      return {
        operations: cases.map((record) => ({
          type: 'ADD', section: 'OTHERS', content: record.instanceId,
        })),
      }
    },
    materializePlaybook: async ({ iteration }) => ({ id: `c${iteration}` }),
    checkpoint: async () => {},
    freeze: async ({ champion }) => ({ championId: champion.id }),
  }
  await runBaseline({
    method: 'ace-batched',
    budget: 4,
    feedbackIds: taskIds,
    feedbackTraversal: 'full-pass',
    runtime,
  })
  assert.equal(feedbackRuns, 1)
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2, 2, 3])
  assert.deepEqual(batches.flat(), taskIds)
})

test('ACE parallel feedback runs a frozen minibatch and merges updates deterministically', async () => {
  const taskIds = Array.from({ length: 6 }, (_, index) => `task-${index + 1}`)
  let active = 0
  let maximumActive = 0
  let materializedState
  const runtime = {
    initialize: async () => ({ id: 'h0' }),
    checkBudget: async () => {},
    reserveCandidate: async () => {},
    selection: async () => ({ meanReward: 0.5, count: 30 }),
    promotion: async () => true,
    assertCandidate: async () => {},
    generate: async ({ taskId, state }) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return {
        correct: true,
        bulletIds: state.bullets.length === 0 ? [] : [state.bullets[0].id],
        instruction: taskId,
      }
    },
    reflect: async ({ generated }) => ({
      bullet_tags: generated.bulletIds.map((id) => ({ id, tag: 'helpful' })),
    }),
    curate: async ({ generated }) => ({
      operations: [{ type: 'ADD', section: 'OTHERS', content: generated.instruction }],
    }),
    materializePlaybook: async ({ state }) => {
      materializedState = state
      return { id: 'c1' }
    },
    checkpoint: async () => {},
    freeze: async ({ champion }) => ({ championId: champion.id }),
  }
  const result = await runBaseline({
    method: 'ace',
    budget: 1,
    feedbackIds: taskIds,
    feedbackTraversal: 'full-pass',
    feedbackConcurrency: 3,
    runtime,
  })
  assert.equal(maximumActive, 3)
  assert.deepEqual(materializedState.bullets.map((bullet) => bullet.content), taskIds)
  assert.equal(new Set(materializedState.bullets.map((bullet) => bullet.id)).size, taskIds.length)
  assert.equal(materializedState.bullets[0].helpful, 3)
  assert.match(result.methodVariant, /minibatch feedback concurrency=3/u)
})

test('candidate reservation is charged before a proposal and exhaustion freezes champion', async () => {
  const { runtime, seen } = fakeRuntime([0.5, 0.7])
  const evolve = runtime.evolve
  runtime.evolve = async (options) => {
    if (options.iteration === 2) throw new BaselineBudgetExhausted('updater budget')
    return await evolve(options)
  }
  const result = await runBaseline({
    method: 'evo-bench',
    budget: 4,
    feedbackIds: ['train'],
    runtime,
  })
  assert.deepEqual(seen.reservations, [1, 2])
  assert.equal(result.frozen.championId, 'c1')
  assert.equal(result.candidatesConsumed, 2)
  assert.equal(result.stopReason, 'updater budget')
})

test('release adapter uses the canonical 90/30/120 benchmark contract', async () => {
  const release = await loadCoworkBenchmark(
    REPOSITORY_ROOT,
    'benchmarks/cowork-bench-240/benchmark.json',
  )
  assert.deepEqual(Object.values(release.partitions).map((rows) => rows.length), [90, 30, 120])
  assert.equal(release.id, 'cowork-bench-240-v0.4')
})

test('sealed task cannot run before Final authorization', async () => {
  const environment = new BaselineCoworkEnvironment({
    release: { all: new Map([['secret', { partition: 'final' }]]) },
    checkBudget: async () => {},
  })
  await assert.rejects(
    environment.runTask({ id: 'h0', digest: 'candidate' }, 'secret'),
    /Sealed Final/u,
  )
})

test('paired report measures fixes and regressions on matched tasks', () => {
  const baseline = [{
    instanceId: 'a', reward: 0.4, correct: false, domain: 'docx',
  }]
  const candidate = [{
    instanceId: 'a', reward: 0.8, correct: true, domain: 'docx',
  }]
  const report = pairedReport(baseline, candidate)
  assert.equal(report.overall.fixRate, 1)
  assert.equal(report.overall.regressionRate, null)
})

test('winner-only report summarizes domains without rerunning H0', () => {
  const report = winnerReport([
    { instanceId: 'a', reward: 1, correct: true, domain: 'ppt' },
    { instanceId: 'b', reward: 0.5, correct: false, domain: 'docx' },
  ])
  assert.equal(report.overall.meanReward, 0.75)
  assert.equal(report.overall.resolved, 1)
  assert.equal(report.byDomain.ppt.count, 1)
})

test('prompt formatting and anytime validation retain reference behavior', () => {
  assert.equal(
    formatPython('Question: {} {{"x": "{field}"}}', ['{literal}'], { field: 'v' }),
    'Question: {literal} {"x": "v"}',
  )
  assert.ok(Math.abs(anytimeValidation([0.3, 0.7], 4, 0.5) - 0.65) < 1e-12)
})

test('checked-in ACE and Evo-Bench experiments share adapters and budgets', async () => {
  const [ace, evo] = await Promise.all([
    loadBaselineConfiguration(
      join(REPOSITORY_ROOT, 'experiments/cowork-benchmark-ace-single.json'),
      REPOSITORY_ROOT,
    ),
    loadBaselineConfiguration(
      join(REPOSITORY_ROOT, 'experiments/cowork-benchmark-evo-bench-single.json'),
      REPOSITORY_ROOT,
    ),
  ])
  assert.deepEqual(ace.target, evo.target)
  assert.deepEqual(ace.config.models, evo.config.models)
  assert.equal(ace.config.candidateBudget, 16)
  assert.equal(evo.config.candidateBudget, 16)
  assert.match(formatPython(ace.prompts.REFLECTOR_PROMPT_NO_GT, [
    'question', 'trace', 'answer', 'feedback', 'bullets',
  ]), /Environment Feedback:\*\*\nfeedback/u)
  assert.match(formatPython(ace.prompts.CURATOR_PROMPT_NO_GT, [], {
    token_budget: 100,
    current_step: 1,
    total_samples: 90,
    playbook_stats: '{}',
    recent_reflection: '{}',
    current_playbook: 'empty',
    question_context: 'cowork',
  }), /Sample 1 out of 90/u)
})
