import { ProtocolError } from '../protocol.mjs'
import { selectionAggregate } from './benchmark.mjs'

export function pairedReport(baseline, candidate) {
  selectionAggregate(baseline)
  selectionAggregate(candidate)
  if ([...baseline, ...candidate].some((record) => typeof record.correct !== 'boolean')) {
    throw new ProtocolError('Final requires native Judge pass/fail results')
  }
  const before = new Map(baseline.map((record) => [record.instanceId, record]))
  if (baseline.length !== candidate.length
      || candidate.some((record) => !before.has(record.instanceId))) {
    throw new ProtocolError('Final requires exactly paired H0/Candidate tasks')
  }

  function summarize(rows) {
    if (!rows.length) return null
    const base = rows.map((record) => before.get(record.instanceId))
    const failed = base.filter((record) => !record.correct).length
    const passed = base.length - failed
    const fixes = rows.filter(
      (record) => !before.get(record.instanceId).correct && record.correct,
    ).length
    const regressions = rows.filter(
      (record) => before.get(record.instanceId).correct && !record.correct,
    ).length
    const baselineScore = selectionAggregate(base).meanReward
    const score = selectionAggregate(rows).meanReward
    return {
      count: rows.length,
      baselineScore,
      score,
      gain: score - baselineScore,
      fixes,
      regressions,
      fixRate: failed ? fixes / failed : null,
      regressionRate: passed ? regressions / passed : null,
    }
  }

  return {
    overall: summarize(candidate),
    byDomain: Object.fromEntries(['docx', 'ppt', 'xlsx', 'cross_office'].map(
      (domain) => [domain, summarize(candidate.filter((record) => record.domain === domain))],
    )),
    inDomain: summarize(candidate.filter((record) => record.domain !== 'cross_office')),
    compositionalOOD: summarize(candidate.filter((record) => record.domain === 'cross_office')),
  }
}
