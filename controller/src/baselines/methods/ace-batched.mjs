import { applyCuratorOperations, emptyPlaybook } from '../ace.mjs'
import { ProtocolError } from '../../protocol.mjs'

/**
 * Budget-matched ACE adaptation: collect H0 Feedback once, then consume four
 * deterministic evidence shards while keeping the playbook as the only state.
 */
export const aceBatchedMethod = Object.freeze({
  id: 'ace-batched',
  variant: 'Batched ACE (Cowork playbook adaptation)',

  async initialize({ runtime, current, feedbackIds }) {
    return {
      state: emptyPlaybook(),
      evidence: await runtime.feedback(current, feedbackIds),
    }
  },

  async propose({ runtime, current, evidence, feedbackIds, iteration, budget, state }) {
    if (!Array.isArray(evidence) || evidence.length !== feedbackIds.length) {
      throw new ProtocolError('Batched ACE requires one complete shared H0 Feedback pass')
    }
    const start = Math.floor(((iteration - 1) * evidence.length) / budget)
    const end = Math.floor((iteration * evidence.length) / budget)
    const cases = evidence.slice(start, end)
    const delta = await runtime.curateBatch({ state, cases, iteration, budget })
    if (!Array.isArray(delta.operations)) {
      throw new ProtocolError('Batched ACE Curator omitted operations')
    }
    const nextState = applyCuratorOperations(state, delta.operations)
    return {
      candidate: await runtime.materializePlaybook({ current, state: nextState, iteration }),
      state: nextState,
      report: {
        taskIds: cases.map((record) => record.instanceId),
        delta,
        sharedFeedback: true,
      },
    }
  },

  async observe({ evidence }) {
    return evidence
  },
})
