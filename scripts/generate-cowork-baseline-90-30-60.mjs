#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(repositoryRoot, 'benchmarks/cowork-bench-240/benchmark.json')
const source = JSON.parse(await readFile(sourcePath, 'utf8'))
const manifest = JSON.parse(await readFile(
  join(repositoryRoot, 'benchmarks/cowork-bench-240/task-manifest.json'),
  'utf8',
))
const domains = new Map(manifest.tasks.map((task) => [task.id, task.path.split('/')[1]]))
const shared = source.spec.partitions
const version = source.metadata.id.match(/v[0-9]+\.[0-9]+$/u)?.[0]
if (!version) throw new Error('Canonical Cowork benchmark id lacks a release version')
const nativeFinal = shared.final.instanceIds.filter((id) => domains.get(id) !== 'cross_office')
const crossOfficeFinal = shared.final.instanceIds.filter((id) => domains.get(id) === 'cross_office')

if (shared.feedback.instanceIds.length !== 90 || shared.selection.instanceIds.length !== 30
    || nativeFinal.length !== 60 || crossOfficeFinal.length !== 60) {
  throw new Error('Canonical Cowork split is not 90 feedback / 30 selection / 60 + 60 final')
}

async function emit(directory, id, name, finalIds) {
  const benchmark = structuredClone(source)
  benchmark.metadata.id = id
  benchmark.metadata.name = name
  benchmark.spec.expectedTotal = 180
  benchmark.spec.partitions.final.instanceIds = finalIds
  benchmark.spec.partitions.final.expectedCount = 60
  const root = join(repositoryRoot, 'benchmarks', directory)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'benchmark.json'), `${JSON.stringify(benchmark, null, 2)}\n`)
}

await Promise.all([
  emit(
    'cowork-bench-native-90-30-60',
    `cowork-bench-native-90-30-60-${version}`,
    'CoworkEvoBench 90 feedback / 30 selection / 60 native final',
    nativeFinal,
  ),
  emit(
    'cowork-bench-cross-office-90-30-60',
    `cowork-bench-cross-office-90-30-60-${version}`,
    'CoworkEvoBench 90 feedback / 30 selection / 60 cross-office final',
    crossOfficeFinal,
  ),
])

process.stdout.write('Generated canonical 90/30/60 native and cross-office benchmark views.\n')
