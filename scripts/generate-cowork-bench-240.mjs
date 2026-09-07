#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.argv[2] ?? process.env.RSI_COWORK_BENCH_DATASET_ROOT ?? '')
const releaseId = 'cowork-evo-240-v0.2'
const outputRoot = join(repositoryRoot, 'benchmarks', 'cowork-bench-240')

if (!process.argv[2] && !process.env.RSI_COWORK_BENCH_DATASET_ROOT) {
  throw new Error('用法：node scripts/generate-cowork-bench-240.mjs <cowork-evolution-benchmark-root>')
}

function parseJsonLines(source, label) {
  return source.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${label} 第 ${index + 1} 行不是合法 JSON：${error.message}`)
    }
  })
}

function assertText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} 缺失`)
  return value
}

const [{ stdout: revisionOutput }, { stdout: statusOutput }] = await Promise.all([
  execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']),
  execFileAsync('git', ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all']),
])
const revision = revisionOutput.trim()
if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('Cowork-Bench Git Revision 无效')
if (statusOutput.trim()) throw new Error('Cowork-Bench 工作树不干净，拒绝生成冻结配置')

const releaseRoot = join(sourceRoot, 'benchmarks', releaseId)
const [release, lock] = await Promise.all([
  readFile(join(releaseRoot, 'benchmark.json'), 'utf8').then(JSON.parse),
  readFile(join(releaseRoot, 'dataset.lock'), 'utf8').then(JSON.parse),
])
if (release?.metadata?.id !== releaseId || lock?.release_id !== releaseId) {
  throw new Error('Cowork-Bench Release 身份不一致')
}
if (lock.expected_task_count !== 240 || !Array.isArray(lock.tasks) || lock.tasks.length !== 240) {
  throw new Error('Cowork-Bench Dataset Lock 必须固定 240 道题')
}

const lockedTasks = new Map(lock.tasks.map((task, index) => {
  const id = assertText(task?.task_id, `dataset.lock.tasks[${index}].task_id`)
  if (id.includes('..') || !id.startsWith('cowork-evo/')) throw new Error(`Task ID 不安全：${id}`)
  return [id, {
    id,
    path: assertText(task.task_path, `Task ${id} path`),
    contentSha256: assertText(task.content_sha256, `Task ${id} digest`),
  }]
}))
if (lockedTasks.size !== 240) throw new Error('Cowork-Bench Dataset Lock 包含重复 Task ID')

const partitionConfiguration = {
  feedback: { file: 'feedback.jsonl', visibility: 'detailed', expectedCount: 90 },
  selection: { file: 'selection.jsonl', visibility: 'aggregate-only', expectedCount: 30 },
  final: { file: 'final.sealed.jsonl', visibility: 'sealed', expectedCount: 120 },
}
const partitions = {}
const assigned = new Set()
for (const [name, configuration] of Object.entries(partitionConfiguration)) {
  const records = parseJsonLines(
    await readFile(join(releaseRoot, 'splits', configuration.file), 'utf8'),
    configuration.file,
  )
  if (records.length !== configuration.expectedCount) {
    throw new Error(`${name} 题数不是 ${configuration.expectedCount}`)
  }
  const instanceIds = records.map((record, index) => {
    const id = assertText(record?.task_id, `${name}[${index}].task_id`)
    const locked = lockedTasks.get(id)
    if (!locked || locked.path !== record.task_path || locked.contentSha256 !== record.content_sha256) {
      throw new Error(`${name} Task 与 Dataset Lock 不一致：${id}`)
    }
    if (record.partition !== name || assigned.has(id)) throw new Error(`Task 分区重复或错误：${id}`)
    assigned.add(id)
    return id
  })
  partitions[name] = {
    visibility: configuration.visibility,
    expectedCount: configuration.expectedCount,
    instanceIds,
  }
}
if (assigned.size !== 240) throw new Error('三段式划分没有完整覆盖 240 道题')

const benchmark = {
  apiVersion: 'harness-rsi/v1alpha1',
  kind: 'Benchmark',
  metadata: {
    id: 'cowork-bench-240-v0.2',
    name: 'CoworkEvoBench 240 full GRHS benchmark',
  },
  spec: {
    source: {
      adapter: 'cowork-bench',
      dataset: 'DeepThinkingZhouLiu/cowork-evolution-benchmark',
      split: `benchmarks/${releaseId}`,
      revision,
    },
    evaluator: {
      adapter: 'cowork-bench',
      resultFormat: 'harness-rsi/solver-result-jsonl-v2',
    },
    expectedTotal: 240,
    partitions,
  },
}
const manifest = {
  apiVersion: 'harness-rsi/cowork-bench-manifest-v1',
  repositoryRevision: revision,
  taskTreeGitOid: lock.task_tree_git_oid,
  tasks: [...lockedTasks.values()].sort((left, right) => left.id.localeCompare(right.id)),
}

await mkdir(outputRoot, { recursive: true })
const benchmarkBytes = `${JSON.stringify(benchmark, null, 2)}\n`
const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
await Promise.all([
  writeFile(join(outputRoot, 'benchmark.json'), benchmarkBytes, { encoding: 'utf8', mode: 0o644 }),
  writeFile(join(outputRoot, 'task-manifest.json'), manifestBytes, { encoding: 'utf8', mode: 0o644 }),
])
process.stdout.write(`${JSON.stringify({
  revision,
  benchmarkPath: 'benchmarks/cowork-bench-240/benchmark.json',
  manifestPath: 'benchmarks/cowork-bench-240/task-manifest.json',
  manifestDigest: createHash('sha256').update(manifestBytes).digest('hex'),
  counts: Object.fromEntries(Object.entries(partitions).map(([name, value]) => [name, value.expectedCount])),
})}\n`)
