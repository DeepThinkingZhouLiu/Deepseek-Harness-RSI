import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { snapshotTree, treeDigest } from '../candidate.mjs'
import { resolveInside } from '../config.mjs'
import { CoworkBenchEnvironment } from '../environments/cowork-bench.mjs'
import { concurrentMap } from '../environments/omegause-officeval.mjs'
import { ProtocolError, validateBenchmark } from '../protocol.mjs'

/** Load the same checked-in benchmark contract used by the main Cowork runs. */
export async function loadCoworkBenchmark(repositoryRoot, reference, manifestReference) {
  const path = resolveInside(repositoryRoot, reference, 'Cowork benchmark')
  const benchmark = validateBenchmark(JSON.parse(await readFile(path, 'utf8')))
  const partitionTotal = Object.values(benchmark.partitions)
    .reduce((sum, partition) => sum + partition.instanceIds.length, 0)
  if (partitionTotal !== benchmark.expectedTotal) {
    throw new ProtocolError('Cowork baseline partition count is incomplete')
  }

  const manifestPath = manifestReference
    ? resolveInside(repositoryRoot, manifestReference, 'Cowork task manifest')
    : join(dirname(path), 'task-manifest.json')
  const taskManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const taskDomains = new Map((taskManifest.tasks ?? []).map((task) => [
    task.id,
    task.path.split('/')[1],
  ]))
  const partitions = {}
  const all = new Map()
  for (const [partition, spec] of Object.entries(benchmark.partitions)) {
    partitions[partition] = spec.instanceIds.map((instanceId) => {
      const domain = taskDomains.get(instanceId)
      if (!['docx', 'ppt', 'xlsx', 'cross_office'].includes(domain)) {
        throw new ProtocolError(`Cowork task manifest lacks a domain for ${instanceId}`)
      }
      const row = Object.freeze({ instance_id: instanceId, partition, domain })
      all.set(instanceId, row)
      return row
    })
  }
  return { id: benchmark.id, benchmark, reference, all, partitions }
}

export function selectionAggregate(records) {
  if (!records.length
      || new Set(records.map((record) => record.instanceId)).size !== records.length
      || records.some((record) => !Number.isFinite(record.reward)
        || record.reward < 0 || record.reward > 1)) {
    throw new ProtocolError('Incomplete or invalid benchmark result records')
  }
  return {
    count: records.length,
    meanReward: records.reduce((sum, record) => sum + record.reward, 0) / records.length,
  }
}

/** Thin baseline facade over the production Cowork-Bench environment. */
export class BaselineCoworkEnvironment {
  constructor({
    release,
    environment,
    repositoryRoot,
    runRoot,
    docker,
    solver,
    model,
    seed,
    checkBudget,
    evidencePartitions = ['feedback'],
  }) {
    Object.assign(this, { release, model, seed, checkBudget, evidencePartitions })
    this.finalAuthorization = null
    this.trials = 0
    this.native = new CoworkBenchEnvironment({
      environment,
      benchmark: release.benchmark,
      solverDriver: solver,
      docker,
      runRoot,
      repositoryRoot,
    })
  }

  async preflight() {
    const status = await this.native.preflight()
    for (const id of this.release.all.keys()) await this.native.taskLayout(id)
    return status
  }

  authorizeFinal(candidates) {
    if (this.finalAuthorization) throw new ProtocolError('Final already authorized')
    this.finalAuthorization = new Map(candidates.map((candidate) => [candidate.id, candidate.digest]))
  }

  async runTask(candidate, id, { reflection = null } = {}) {
    await this.checkBudget()
    const row = this.release.all.get(id)
    if (!row) throw new ProtocolError(`Unknown benchmark task: ${id}`)
    if (row.partition === 'final'
        && this.finalAuthorization?.get(candidate.id) !== candidate.digest) {
      throw new ProtocolError('Sealed Final is unavailable before candidate freeze')
    }
    if (!this.evidencePartitions.includes(row.partition) && reflection !== null) {
      throw new ProtocolError('Reflection is training-only')
    }
    if (treeDigest(await snapshotTree(candidate.workspace)) !== candidate.digest) {
      throw new ProtocolError('Candidate changed after snapshot')
    }

    const baseLayout = await this.native.taskLayout(id)
    const instruction = reflection === null
      ? baseLayout.task.instruction
      : `${baseLayout.task.instruction}\n\nPrevious attempt reflection:\n${JSON.stringify(reflection)}`
    const layout = { ...baseLayout, task: { ...baseLayout.task, instruction } }
    const trialNumber = ++this.trials
    const trial = await this.native.runTrial({
      candidateId: candidate.id,
      candidateWorkspace: candidate.workspace,
      layout,
      model: this.model,
      partition: row.partition,
      seed: this.seed,
      trialIndex: 0,
      executionId: `baseline-${String(trialNumber).padStart(6, '0')}`,
    })
    const record = {
      instanceId: id,
      reward: trial.reward,
      correct: trial.reward >= 1,
      candidateId: candidate.id,
      seedControlled: false,
      domain: row.domain,
      trialRoot: trial.trialRoot,
    }
    if (row.partition === 'feedback') {
      Object.assign(record, {
        instruction: baseLayout.task.instruction,
        trace: trial.solverTrace ?? trial.solverAnswer,
        answer: trial.solverAnswer,
        verifier: trial.verifierFeedback,
      })
    }
    return record
  }

  async runTasks(candidate, ids, options = {}) {
    return await concurrentMap(
      ids,
      this.native.environment.task.maximumConcurrentTrials ?? 1,
      (id) => this.runTask(candidate, id, options),
    )
  }

  async runPartition(candidate, partition) {
    const outputRoot = join(this.native.runRoot, 'partition-results')
    await mkdir(outputRoot, { recursive: true })
    const records = await this.native.runCandidatePartition({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      candidateWorkspace: candidate.workspace,
      model: this.model,
      partition,
      seeds: [this.seed],
      outputPath: join(outputRoot, `${candidate.id}-${partition}.jsonl`),
    })
    return [...records.values()].map((record) => {
      const row = this.release.all.get(record.instanceId)
      const artifactRoot = record.artifacts[0]?.root
      const result = {
        instanceId: record.instanceId,
        reward: record.reward,
        correct: record.status === 'resolved',
        candidateId: candidate.id,
        seedControlled: record.seedControlled,
        domain: row.domain,
        trialRoot: artifactRoot ? resolve(this.native.runRoot, artifactRoot) : null,
      }
    if (this.evidencePartitions.includes(partition)) {
        Object.assign(result, {
          instruction: record.feedback.taskInstruction,
          trace: record.feedback.solverAnswer,
          answer: record.feedback.solverAnswer,
          verifier: record.feedback.verifierFeedback,
        })
      }
      return result
    })
  }
}
