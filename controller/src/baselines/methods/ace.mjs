import {
  applyCuratorOperations,
  emptyPlaybook,
  trainAceSample,
  validatePlaybook,
} from '../ace.mjs'
import { ProtocolError } from '../../protocol.mjs'

function mergeBatch(baseState, learnedSamples) {
  const base = validatePlaybook(structuredClone(baseState))
  let merged = structuredClone(base)
  const mergedById = new Map(merged.bullets.map((bullet) => [bullet.id, bullet]))
  for (const learned of learnedSamples) {
    const localById = new Map(learned.state.bullets.map((bullet) => [bullet.id, bullet]))
    for (const bullet of base.bullets) {
      const local = localById.get(bullet.id)
      if (!local || local.helpful < bullet.helpful || local.harmful < bullet.harmful) {
        throw new ProtocolError('ACE parallel batch produced an incompatible playbook state')
      }
      const target = mergedById.get(bullet.id)
      target.helpful += local.helpful - bullet.helpful
      target.harmful += local.harmful - bullet.harmful
    }
    merged = applyCuratorOperations(merged, learned.delta.operations)
    for (const bullet of merged.bullets) mergedById.set(bullet.id, bullet)
  }
  return validatePlaybook(merged)
}

export const aceMethod = Object.freeze({
  id: 'ace',
  variant: 'ACE (Cowork artifact adaptation)',

  async initialize() {
    return { state: emptyPlaybook(), evidence: null }
  },

  async propose({
    runtime,
    current,
    feedbackIds,
    iteration,
    budget,
    state,
    maximumReflectionRounds,
    feedbackTraversal,
    feedbackConcurrency,
  }) {
    const start = feedbackTraversal === 'full-pass'
      ? Math.floor(((iteration - 1) * feedbackIds.length) / budget)
      : (iteration - 1) % feedbackIds.length
    const end = feedbackTraversal === 'full-pass'
      ? Math.floor((iteration * feedbackIds.length) / budget)
      : start + 1
    const taskIds = feedbackIds.slice(start, end)
    let nextState = state
    const samples = []
    for (let offset = 0; offset < taskIds.length; offset += feedbackConcurrency) {
      const batchTaskIds = taskIds.slice(offset, offset + feedbackConcurrency)
      const batchState = structuredClone(nextState)
      const settled = await Promise.allSettled(batchTaskIds.map(async (taskId) => ({
        taskId,
        learned: await trainAceSample({
          state: batchState,
          maximumReflectionRounds,
          generate: (options) => runtime.generate({ ...options, current, taskId, iteration }),
          reflect: (options) => runtime.reflect({ ...options, taskId, iteration }),
          curate: (options) => runtime.curate({ ...options, taskId, iteration }),
        }),
      })))
      const failed = settled.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
      const completed = settled.map((result) => result.value)
      nextState = mergeBatch(batchState, completed.map(({ learned }) => learned))
      samples.push(...completed.map(({ taskId, learned }) => ({
        taskId,
        reflections: learned.reflections,
        delta: learned.delta,
      })))
    }
    return {
      candidate: await runtime.materializePlaybook({
        current,
        state: nextState,
        iteration,
      }),
      state: nextState,
      report: {
        taskIds,
        samples,
        feedbackConcurrency,
        batchCount: Math.ceil(taskIds.length / feedbackConcurrency),
      },
    }
  },

  async observe({ evidence }) {
    return evidence
  },
})
