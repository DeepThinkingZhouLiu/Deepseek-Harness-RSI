import { ProtocolError } from '../protocol.mjs'
import { BaselineBudgetExhausted } from './budget.mjs'
import { getBaselineMethod } from './methods/index.mjs'

function aggregate(value) {
  if (!value || !Number.isFinite(value.meanReward) || value.meanReward < 0
      || value.meanReward > 1 || !Number.isSafeInteger(value.count) || value.count < 1) {
    throw new ProtocolError('Invalid selection aggregate')
  }
  return { meanReward: value.meanReward, count: value.count }
}

export function anytimeValidation(scores, budget, initialScore) {
  if (!Number.isSafeInteger(budget) || budget < 1 || scores.length > budget
      || ![initialScore, ...scores].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      )) {
    throw new ProtocolError('Invalid anytime validation inputs')
  }
  let best = initialScore
  let sum = 0
  for (let index = 0; index < budget; index += 1) {
    best = Math.max(best, scores[index] ?? best)
    sum += best
  }
  return sum / budget
}

/** Common baseline lifecycle. Method-specific proposal and observation behavior
 * lives under baselines/methods so a method can be added or removed independently. */
export async function runBaseline({
  method: methodId,
  budget,
  feedbackIds,
  runtime,
  maximumReflectionRounds = 3,
  feedbackTraversal = 'single-sample',
}) {
  if (!Number.isSafeInteger(budget) || budget < 1 || !Array.isArray(feedbackIds)
      || feedbackIds.length === 0 || new Set(feedbackIds).size !== feedbackIds.length
      || !['single-sample', 'full-pass'].includes(feedbackTraversal)) {
    throw new ProtocolError('Invalid baseline configuration')
  }
  const method = getBaselineMethod(methodId)
  let current = await runtime.initialize()
  const h0 = current
  let champion = current
  const baselineSelection = aggregate(await runtime.selection(h0))
  let championSelection = baselineSelection
  const initialized = await method.initialize({ runtime, current, feedbackIds })
  let methodState = initialized.state
  let evidence = initialized.evidence
  const history = []
  let consumed = 0
  let stopReason = 'candidate-budget'

  for (let iteration = 1; iteration <= budget; iteration += 1) {
    try {
      await runtime.checkBudget()
      await runtime.reserveCandidate(iteration)
      consumed += 1
      const proposed = await method.propose({
        runtime,
        current,
        feedbackIds,
        iteration,
        budget,
        state: methodState,
        evidence,
        history: structuredClone(history),
        maximumReflectionRounds,
        feedbackTraversal,
      })
      methodState = proposed.state
      const { candidate, report } = proposed
      if (!candidate) {
        history.push({ iteration, parentId: current.id, status: 'invalid', report })
        await runtime.checkpoint({
          iteration, current, champion, championSelection, history, methodState,
        })
        continue
      }

      await runtime.assertCandidate(candidate)
      const nextEvidence = await method.observe({
        runtime, candidate, evidence, feedbackIds,
      })
      const selection = aggregate(await runtime.selection(candidate))
      const parentId = current.id
      current = candidate
      if ((selection.meanReward > championSelection.meanReward
          && await runtime.promotion({ champion, candidate }))) {
        champion = candidate
        championSelection = selection
      }
      history.push({ iteration, parentId, candidateId: candidate.id, selection, report })
      await runtime.checkpoint({
        iteration, current, champion, championSelection, history, methodState,
      })
      evidence = nextEvidence
    } catch (error) {
      if (!(error instanceof BaselineBudgetExhausted)) throw error
      stopReason = error.message
      break
    }
  }

  const frozen = await runtime.freeze({ champion, h0, current, history })
  return {
    method: methodId,
    methodVariant: method.variant,
    frozen,
    baselineSelection,
    championSelection,
    anytimeSelection: anytimeValidation(
      history.map((entry) => entry.selection?.meanReward ?? baselineSelection.meanReward),
      budget,
      baselineSelection.meanReward,
    ),
    candidatesConsumed: consumed,
    stopReason,
  }
}
