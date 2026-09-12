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
  validationIds = feedbackIds,
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
  const validationOnly = method.validationOnly === true
  let current = await runtime.initialize()
  const h0 = current
  let champion = current
  const initialized = await method.initialize({ runtime, current, feedbackIds, validationIds })
  let methodState = initialized.state
  let evidence = initialized.evidence
  const baselineSelection = validationOnly
    ? aggregate(initialized.selection ?? method.scoreEvidence(evidence))
    : aggregate(await runtime.selection(h0))
  let championSelection = baselineSelection
  const history = []
  let consumed = 0
  let stopReason = 'candidate-budget'

  for (let iteration = 1; iteration <= budget; iteration += 1) {
    try {
      await runtime.checkBudget()
      await runtime.reserveCandidate(iteration)
      consumed += 1
      let proposed
      let proposalError
      for (let attempt = 1; attempt <= 3 && !proposed; attempt += 1) {
        try {
          proposed = await method.propose({
        runtime,
        current,
        feedbackIds,
        validationIds,
        iteration,
        budget,
        state: methodState,
        evidence,
        history: structuredClone(history),
        maximumReflectionRounds,
        feedbackTraversal,
          })
        } catch (error) {
          proposalError = error
          if (attempt < 3) continue
        }
      }
      if (!proposed) {
        history.push({ iteration, parentId: current.id, status: 'error', report: {
          message: proposalError?.message ?? 'proposal failed',
        } })
        await runtime.checkpoint({ iteration, current, champion, championSelection, history, methodState })
        continue
      }
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
        runtime, candidate, evidence, feedbackIds, validationIds,
      })
      const selection = validationOnly
        ? aggregate(nextEvidence.selection ?? method.scoreEvidence(nextEvidence.evidence ?? nextEvidence))
        : aggregate(await runtime.selection(candidate))
      const parentId = current.id
      current = candidate
      const improvesChampion = selection.meanReward > championSelection.meanReward
      const promoted = validationOnly
        ? improvesChampion
        : improvesChampion && await runtime.promotion({ champion, candidate })
      if (promoted) {
        champion = candidate
        championSelection = selection
      }
      history.push({ iteration, parentId, candidateId: candidate.id, selection, report })
      await runtime.checkpoint({
        iteration, current, champion, championSelection, history, methodState,
      })
      evidence = nextEvidence.evidence ?? nextEvidence
    } catch (error) {
      if (error instanceof BaselineBudgetExhausted) {
        stopReason = error.message
        break
      }
      history.push({ iteration, parentId: current.id, status: 'error', report: { message: error.message } })
      await runtime.checkpoint({ iteration, current, champion, championSelection, history, methodState })
    }
  }

  const frozen = await runtime.freeze({ champion, h0, current, history })
  return {
    method: methodId,
    methodVariant: method.variant,
    scorePartition: validationOnly
      ? (runtime.validationPartition ?? 'feedback')
      : 'selection',
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
