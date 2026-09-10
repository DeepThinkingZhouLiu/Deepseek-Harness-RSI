export const evoBenchMethod = Object.freeze({
  id: 'evo-bench',
  variant: 'Evo-Bench Evolver (Cowork/Codex adaptation)',

  async initialize({ runtime, current, feedbackIds }) {
    return { state: null, evidence: await runtime.feedback(current, feedbackIds) }
  },

  async propose({ runtime, current, evidence, history, iteration, state }) {
    const proposed = await runtime.evolve({ current, evidence, history, iteration })
    return { ...proposed, state }
  },

  async observe({ runtime, candidate, feedbackIds }) {
    return await runtime.feedback(candidate, feedbackIds)
  },
})
