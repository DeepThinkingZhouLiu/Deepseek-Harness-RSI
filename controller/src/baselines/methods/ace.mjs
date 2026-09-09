import { emptyPlaybook, trainAceSample } from '../ace.mjs'

export const aceMethod = Object.freeze({
  id: 'ace',
  variant: 'ACE (Cowork artifact adaptation)',

  async initialize() {
    return { state: emptyPlaybook(), evidence: null }
  },

  async propose({ runtime, current, feedbackIds, iteration, state, maximumReflectionRounds }) {
    const taskId = feedbackIds[(iteration - 1) % feedbackIds.length]
    const learned = await trainAceSample({
      state,
      maximumReflectionRounds,
      generate: (options) => runtime.generate({ ...options, current, taskId, iteration }),
      reflect: (options) => runtime.reflect({ ...options, taskId, iteration }),
      curate: (options) => runtime.curate({ ...options, taskId, iteration }),
    })
    return {
      candidate: await runtime.materializePlaybook({
        current,
        state: learned.state,
        iteration,
      }),
      state: learned.state,
      report: { taskId, reflections: learned.reflections, delta: learned.delta },
    }
  },

  async observe({ evidence }) {
    return evidence
  },
})
