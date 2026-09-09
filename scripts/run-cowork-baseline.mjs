import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { loadCoworkBenchmark } from '../controller/src/baselines/benchmark.mjs'
import { runBaseline } from '../controller/src/baselines/loop.mjs'
import { pairedReport } from '../controller/src/baselines/report.mjs'
import {
  createBaselineRuntime,
  loadBaselineConfiguration,
} from '../controller/src/baselines/runtime.mjs'
import { REPOSITORY_ROOT, resolveInside } from '../controller/src/config.mjs'
import { ProtocolError, writeJsonFile } from '../controller/src/protocol.mjs'

function shuffled(values, seed) {
  let state = seed >>> 0
  const result = [...values]
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1))
    ;[result[index], result[selected]] = [result[selected], result[index]]
  }
  return result
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    experiment: { type: 'string' },
    'run-id': { type: 'string' },
    'source-run-id': { type: 'string' },
  },
})
const command = positionals[0] ?? 'check'
if (positionals.length > 1 || !['check', 'preflight', 'run', 'final', 'cross-final'].includes(command)
    || !values.experiment) {
  throw new ProtocolError(
    'Usage: node scripts/run-cowork-baseline.mjs check|preflight|run|final '
    + '--experiment experiments/cowork-benchmark-ace-single.json [--run-id ace-single-001] '
    + '[--source-run-id source-run]',
  )
}
const bundle = await loadBaselineConfiguration(
  resolveInside(REPOSITORY_ROOT, values.experiment, 'experiment'),
  REPOSITORY_ROOT,
)
const release = await loadCoworkBenchmark(
  REPOSITORY_ROOT,
  bundle.config.benchmark,
  bundle.infrastructure.source.manifestPath,
)

if (command === 'check') {
  console.log(JSON.stringify({
    method: bundle.config.method,
    release: release.id,
    splits: Object.fromEntries(Object.entries(release.partitions).map(
      ([key, rows]) => [key, rows.length],
    )),
    budget: bundle.config.candidateBudget,
    source: bundle.sources[bundle.config.method],
  }, null, 2))
} else {
  const id = values['run-id']
  if (!id || !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(id)) {
    throw new ProtocolError('A safe --run-id is required')
  }
  const runsRoot = join(REPOSITORY_ROOT, '.rsi/baselines')
  await mkdir(runsRoot, { recursive: true })
  const canonicalRunsRoot = await realpath(runsRoot)
  const sourceRunId = values['source-run-id']
  const sourceRunRoot = command === 'cross-final'
    ? join(canonicalRunsRoot, sourceRunId ?? '')
    : null
  if (command === 'cross-final'
      && (!sourceRunId || !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(sourceRunId))) {
    throw new ProtocolError('A safe --source-run-id is required for cross-final')
  }
  const runRoot = command === 'cross-final'
    ? join(sourceRunRoot, 'cross-final', id)
    : join(canonicalRunsRoot, id)
  if (command === 'cross-final') {
    await mkdir(runRoot, { recursive: true, mode: 0o700 })
  }
  if (command === 'run') {
    await mkdir(runRoot, { recursive: false, mode: 0o700 })
  }
  const runtime = await createBaselineRuntime({
    bundle,
    release,
    repositoryRoot: REPOSITORY_ROOT,
    runRoot,
    onEvent: (message) => console.log(message),
  })
  try {
    if (command === 'preflight') {
      console.log(JSON.stringify(await runtime.preflight(), null, 2))
    }
    if (command === 'run') {
      const feedbackIds = shuffled(
        release.partitions.feedback.map((row) => row.instance_id),
        bundle.config.seed,
      )
      await writeJsonFile(join(runRoot, 'experiment.json'), bundle.config)
      const result = await runBaseline({
        method: bundle.config.method,
        budget: bundle.config.candidateBudget,
        maximumReflectionRounds: bundle.config.maximumReflectionRounds,
        feedbackIds,
        runtime,
      })
      await writeJsonFile(join(runRoot, 'summary.json'), {
        ...result,
        usage: runtime.usage(),
      })
      console.log(JSON.stringify(result, null, 2))
    }
    if (command === 'final') {
      const frozen = JSON.parse(await readFile(join(runRoot, 'frozen.json'), 'utf8'))
      await writeFile(
        join(runRoot, 'final-claim.json'),
        JSON.stringify({ startedAt: new Date().toISOString() }),
        { flag: 'wx' },
      ).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
      const results = await runtime.final(frozen)
      const report = pairedReport(results[frozen.h0.id], results[frozen.champion.id])
      await writeJsonFile(join(runRoot, 'final-report.json'), {
        ...report,
        usage: runtime.usage(),
      })
      console.log(JSON.stringify(report, null, 2))
    }
    if (command === 'cross-final') {
      const frozen = JSON.parse(await readFile(join(sourceRunRoot, 'frozen.json'), 'utf8'))
      const results = await runtime.crossFinal(frozen)
      const report = pairedReport(results[frozen.h0.id], results[frozen.champion.id])
      await writeJsonFile(join(runRoot, 'cross-final-report.json'), {
        sourceRunId,
        targetRelease: release.id,
        ...report,
        usage: runtime.usage(),
      })
      console.log(JSON.stringify(report, null, 2))
    }
  } finally {
    try {
      if (command !== 'preflight') {
        await writeJsonFile(join(runRoot, `${command}-usage.json`), runtime.usage())
      }
    } finally {
      await runtime.close()
    }
  }
}
