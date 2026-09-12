import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { loadExperimentBundle } from '../controller/src/adapters.mjs'
import {
  createBaselineCompatibilityIdentity,
  createBaselinePackDocument,
} from '../controller/src/baseline-pack.mjs'
import { buildFeedbackPacket } from '../controller/src/feedback.mjs'
import { validateResultRecords } from '../controller/src/protocol.mjs'
import { REPOSITORY_ROOT } from '../controller/src/config.mjs'

const { values } = parseArgs({ options: {
  experiment: { type: 'string' },
  state: { type: 'string' },
  'source-run': { type: 'string' },
  output: { type: 'string' },
  id: { type: 'string' },
} })
if (!values.experiment || !values.state || !values['source-run'] || !values.output) {
  throw new Error('Usage: node scripts/import-legacy-baseline-pack.mjs '
    + '--experiment <config.json> --state <state.json> --source-run <baseline-run> '
    + '--output <pack.json> [--id <pack-id>]')
}
const repositoryRoot = REPOSITORY_ROOT
const configPath = resolve(repositoryRoot, values.experiment)
const statePath = resolve(repositoryRoot, values.state)
const sourceRoot = resolve(repositoryRoot, values['source-run'])
const sourceRunId = basename(sourceRoot)
const legacyRoot = resolve(sourceRoot, 'partition-results')
const outputPath = resolve(repositoryRoot, values.output)

function parseJsonl(text, label) {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${label} line ${index + 1}: ${error.message}`) }
  })
}

const [bundle, state, feedbackText, selectionText] = await Promise.all([
  loadExperimentBundle(configPath, repositoryRoot),
  readFile(statePath, 'utf8').then(JSON.parse),
  readFile(resolve(legacyRoot, 'h0-feedback.jsonl'), 'utf8'),
  readFile(resolve(legacyRoot, 'h0-selection.jsonl'), 'utf8'),
])
const feedbackRaw = parseJsonl(feedbackText, 'feedback')
const selectionRaw = parseJsonl(selectionText, 'selection')
const feedbackRecords = validateResultRecords(feedbackRaw, bundle.benchmark, 'Legacy H0 Feedback')
const selectionRecords = validateResultRecords(selectionRaw, bundle.benchmark, 'Legacy H0 Selection')
const seeds = state.spec.seeds
const candidateDigest = state.spec.candidates.find((candidate) => candidate.id === 'h0')?.digest
if (!candidateDigest) throw new Error('Current GRHS state has no H0 digest')
const identity = createBaselineCompatibilityIdentity({
  bundle,
  targetSourceRevision: state.spec.targetSourceRevision,
  benchmarkSourceRevision: state.spec.benchmarkSourceRevision,
  candidateDigest,
  seeds,
})
const metric = bundle.policy.primaryMetric
const selectionValue = [...selectionRecords.values()].reduce((sum, record) => sum + record.reward, 0) / selectionRecords.size
const feedbackPacket = buildFeedbackPacket({
  runId: sourceRunId,
  generation: 1,
  candidateId: 'h0',
  benchmark: bundle.benchmark,
  records: feedbackRecords,
  maximumTextBytesPerCase: bundle.environment.feedback.maximumTextBytesPerCase,
  maximumArtifactEntriesPerCase: bundle.environment.feedback.maximumArtifactEntriesPerCase,
  maximumArtifactBytesPerCase: bundle.environment.feedback.maximumArtifactBytesPerCase,
  maximumHistoryEntries: bundle.environment.feedback.maximumHistoryEntries,
  maximumHistoryBytes: bundle.environment.feedback.maximumHistoryBytes,
  searchHistory: [],
  peerEvidence: [],
})
const pack = createBaselinePackDocument({
  id: values.id ?? `${sourceRunId}-h0`,
  createdAt: new Date().toISOString(),
  source: {
    runId: sourceRunId,
    baselineId: 'h0',
    legacyFeedbackPath: 'partition-results/h0-feedback.jsonl',
    legacySelectionPath: 'partition-results/h0-selection.jsonl',
  },
  identity,
  benchmark: bundle.benchmark,
  decisionPartition: 'selection',
  decisionRecords: selectionRaw,
  decisionEvaluation: {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvaluationSummary',
    candidateId: 'h0',
    primary: { metric, value: selectionValue, direction: 'maximize', total: null },
  },
  feedbackRecords: feedbackRaw,
  feedbackPacket,
})
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx', mode: 0o400 })
console.log(JSON.stringify({ path: outputPath, feedback: feedbackRaw.length,
  selection: selectionRaw.length, selectionValue }, null, 2))
