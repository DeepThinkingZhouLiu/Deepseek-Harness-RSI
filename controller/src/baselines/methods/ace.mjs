import { emptyPlaybook, trainAceSample } from '../ace.mjs'

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
    for (const taskId of taskIds) {
      const learned = await trainAceSample({
        state: nextState,
        maximumReflectionRounds,
        generate: (options) => runtime.generate({ ...options, current, taskId, iteration }),
        reflect: (options) => runtime.reflect({ ...options, taskId, iteration }),
        curate: (options) => runtime.curate({ ...options, taskId, iteration }),
      })
      nextState = learned.state
      samples.push({ taskId, reflections: learned.reflections, delta: learned.delta })
    }
    return {
      candidate: await runtime.materializePlaybook({
        current,
        state: nextState,
        iteration,
      }),
      state: nextState,
      report: { taskIds, samples },
    }
  },

  async observe({ evidence }) {
    return evidence
  },
})
