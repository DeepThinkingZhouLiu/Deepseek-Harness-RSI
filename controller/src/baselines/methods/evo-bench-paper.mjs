function validationAggregate(records) {
  if (!Array.isArray(records) || records.length === 0
      || records.some((record) => !Number.isFinite(record?.reward)
        || record.reward < 0 || record.reward > 1)) {
    throw new Error('EvoBench validation evidence is incomplete or invalid')
  }
  return {
    meanReward: records.reduce((sum, record) => sum + record.reward, 0) / records.length,
    count: records.length,
  }
}

/** Paper-shaped EvoBench control for the Cowork controller. */
export const evoBenchPaperMethod = Object.freeze({
  id: 'evo-bench-paper',
  variant: 'Evo-Bench paper protocol (validation-only online signal; held-out final)',
  validationOnly: true,
  scoreEvidence: validationAggregate,

  async initialize({ runtime, current, feedbackIds, validationIds }) {
    return {
      state: null,
      evidence: await runtime.feedback(current, feedbackIds),
      selection: validationAggregate(await runtime.validation(current, validationIds)),
    }
  },

  async propose({ runtime, current, evidence, history, iteration, state }) {
    const proposed = await runtime.evolve({
      current,
      evidence,
      history,
      iteration,
      protocol: 'evobench-paper',
    })
    return { ...proposed, state }
  },

  async observe({ runtime, candidate, evidence, validationIds }) {
    return {
      // This Cowork adaptation keeps the initial detailed feedback packet fixed;
      // only the candidate's validation score is refreshed each iteration.
      evidence,
      selection: validationAggregate(await runtime.validation(candidate, validationIds)),
    }
  },
})
