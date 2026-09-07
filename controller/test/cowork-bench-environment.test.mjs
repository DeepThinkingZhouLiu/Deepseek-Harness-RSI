import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import { adaptCoworkWorkspaceInstruction } from '../src/environments/cowork-bench.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)

test('Cowork-Bench 将 Harbor 输入输出路径映射到持久化 Solver Workspace', () => {
  const instruction = [
    '读取 `/app/data/input_files/source.docx`。',
    '写入 `/app/output/result.docx`。',
  ].join('\n')

  assert.equal(
    adaptCoworkWorkspaceInstruction(instruction, '/workspace'),
    '读取 `/workspace/source.docx`。\n写入 `/workspace/result.docx`。',
  )
})

test('Cowork-Bench 保留未达通过阈值但合法的连续分数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cowork-bench-judge-'))
  const submission = join(root, 'submission')
  const judge = join(root, 'judge.py')
  const output = join(root, 'result.json')
  await mkdir(submission)
  await writeFile(judge, [
    'import argparse, json',
    'from pathlib import Path',
    'parser = argparse.ArgumentParser()',
    'parser.add_argument("--artifact-dir", required=True)',
    'parser.add_argument("--result", required=True)',
    'parser.add_argument("--reward-file", required=True)',
    'args = parser.parse_args()',
    'payload = {"task_id": "cowork-evo/partial-score", "reward": 0.5, "passed": False}',
    'Path(args.result).write_text(json.dumps(payload), encoding="utf-8")',
    'Path(args.reward_file).write_text("0.500000\\n", encoding="utf-8")',
    'raise SystemExit(1)',
    '',
  ].join('\n'))

  await execFileAsync('python3', [
    resolve(repositoryRoot, 'docker/cowork-bench/run-verifier.py'),
    '--judge', judge,
    '--submission', submission,
    '--output', output,
    '--expected-id', 'partial-score',
  ])

  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
    task_id: 'cowork-evo/partial-score',
    reward: 0.5,
    passed: false,
  })
})
