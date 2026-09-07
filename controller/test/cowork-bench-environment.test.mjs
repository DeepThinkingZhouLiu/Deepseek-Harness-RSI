import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import { adaptCoworkWorkspaceInstruction, CoworkBenchEnvironment } from '../src/environments/cowork-bench.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)

test('Cowork-Bench 将 Harbor 输入输出路径映射到持久化 Solver Workspace', () => {
  const instruction = [
    '读取 `/app/data/input_files/source.docx`。',
    '读取 `/app/input_files/reference.png`。',
    '写入 `/app/output/result.docx`。',
  ].join('\n')

  assert.equal(
    adaptCoworkWorkspaceInstruction(instruction, '/workspace'),
    '读取 `/workspace/source.docx`。\n读取 `/workspace/reference.png`。\n写入 `/workspace/result.docx`。',
  )
})

test('Cowork Judge 在 safe-path 模式可导入受信同目录依赖，Submission 不能覆盖依赖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cowork-judge-import-'))
  const taskRoot = join(root, 'task')
  const tests = join(taskRoot, 'tests')
  const submission = join(root, 'submission')
  await Promise.all([mkdir(tests, { recursive: true }), mkdir(join(taskRoot, 'data'), { recursive: true }), mkdir(submission)])
  await Promise.all([
    writeFile(join(taskRoot, 'rubric.json'), '{}'),
    writeFile(join(taskRoot, 'task.toml'), ''),
    writeFile(join(tests, 'upstream_verifier.py'), 'REWARD = 0.5\n'),
    writeFile(join(submission, 'upstream_verifier.py'), 'raise RuntimeError("UNTRUSTED")\n'),
    writeFile(join(tests, 'judge.py'), [
      'import argparse, json',
      'from pathlib import Path',
      'from upstream_verifier import REWARD',
      'p = argparse.ArgumentParser()',
      'p.add_argument("--artifact-dir")',
      'p.add_argument("--result")',
      'args = p.parse_args()',
      'Path(args.result).write_text(json.dumps({"reward": REWARD}))',
    ].join('\n')),
  ])
  const environment = new CoworkBenchEnvironment({
    environment: { verifier: { timeoutSeconds: 10, resources: {} } },
    docker: { async run(options) {
      assert.equal(options.environment.PYTHONSAFEPATH, '1')
      assert.equal(options.environment.PYTHONPATH, '/verifier/task/tests')
      assert.equal(options.environment.UserInstallation, 'file:///tmp/libreoffice-profile')
      const staged = options.mounts.find((mount) => mount.target === '/verifier')
      assert.equal(staged.readOnly, true)
      const logs = options.mounts.find((mount) => mount.target === '/logs').source
      await execFileAsync('python3', [
        resolve(repositoryRoot, 'docker/cowork-bench/run-verifier.py'),
        '--judge', join(staged.source, 'task/tests/judge.py'),
        '--submission', submission, '--output', join(logs, 'result.json'), '--expected-id', 'fixture',
      ], {
        cwd: submission,
        env: { ...process.env, PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: join(staged.source, 'task/tests') },
      })
    } },
  })
  const result = await environment.runVerifier({
    layout: { taskRoot, instanceId: 'fixture' }, submission,
    logs: join(root, 'logs'), verifierCode: join(root, 'verifier-code'), name: 'fixture',
  })
  assert.equal(result.total_score, 0.5)
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
