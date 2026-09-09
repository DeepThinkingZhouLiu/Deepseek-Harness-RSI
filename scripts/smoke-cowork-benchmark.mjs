import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BaselineCoworkEnvironment,
  loadCoworkBenchmark,
} from '../controller/src/baselines/benchmark.mjs'
import { loadBaselineConfiguration } from '../controller/src/baselines/runtime.mjs'
import { snapshotTree, treeDigest } from '../controller/src/candidate.mjs'
import { REPOSITORY_ROOT } from '../controller/src/config.mjs'
import { DockerClient } from '../controller/src/docker.mjs'

const bundle = await loadBaselineConfiguration(
  join(REPOSITORY_ROOT, 'experiments/cowork-benchmark-ace-single.json'),
  REPOSITORY_ROOT,
)
const release = await loadCoworkBenchmark(REPOSITORY_ROOT, bundle.config.benchmark)
const root = await mkdtemp(join(tmpdir(), 'cowork-native-smoke-'))
const workspace = join(root, 'candidate')
await mkdir(workspace)
await writeFile(
  join(workspace, 'smoke.txt'),
  'Empty submission connectivity probe; no model is called.\n',
)
const candidate = {
  id: 'connectivity-probe',
  workspace,
  digest: treeDigest(await snapshotTree(workspace)),
}
const solver = {
  cacheKey: 'empty-submission',
  ensureRuntime: async ({ baseImage }) => ({ image: baseImage }),
  run: async () => ({
    trace: '{"type":"probe","content":"No model was called"}\n',
    answer: 'Empty submission',
  }),
}
const environment = new BaselineCoworkEnvironment({
  release,
  environment: bundle.infrastructure,
  repositoryRoot: REPOSITORY_ROOT,
  runRoot: root,
  docker: new DockerClient(),
  solver,
  model: null,
  seed: bundle.config.seed,
  checkBudget: async () => 1_800_000,
})
await environment.preflight()
const row = release.partitions.feedback[0]
const result = await environment.runTask(candidate, row.instance_id)
console.log(JSON.stringify({
  status: 'PASS',
  kind: 'native-verifier-connectivity-only',
  task: row.instance_id,
  reward: result.reward,
  passed: result.correct,
  artifacts: root,
}, null, 2))
