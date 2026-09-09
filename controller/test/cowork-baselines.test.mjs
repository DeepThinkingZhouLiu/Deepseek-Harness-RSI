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
import { pairedReport } from '../src/baselines/report.mjs'
import { formatPython, loadBaselineConfiguration } from '../src/baselines/runtime.mjs'
import { REPOSITORY_ROOT } from '../src/config.mjs'

const additions = [{
  type: 'ADD',
  section: 'FORMULAS & CALCULATIONS',
  content: 'Recompute totals.',
}]

test('baseline methods are explicit, independently registered components', () => {
  assert.deepEqual(baselineMethodIds, ['ace', 'evo-bench'])
  assert.equal(getBaselineMethod('ace').id, 'ace')
  assert.equal(getBaselineMethod('evo-bench').id, 'evo-bench')
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
  assert.equal(release.id, 'cowork-bench-240-v0.2')
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
