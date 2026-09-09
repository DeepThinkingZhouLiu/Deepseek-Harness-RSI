import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  adaptCoworkWorkspaceInstruction, CoworkBenchEnvironment, normalizeCoworkJudgeResult,
} from '../src/environments/cowork-bench.mjs'
import { buildFeedbackPacket } from '../src/feedback.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)

function judgeFeedbackFixture() {
  return {
    reward: 0.35,
    criterion_results: [
      { criterion_id: 'R001', score: 0, evidence: '要求三张表，实际四张表',
        raw: { description: '章节与表格结构', weight: 4, type: 'hurdle', passed: false } },
      { criterion_id: 'R002', score: 0.5, evidence: '两项字段只有一项正确',
        raw: { description: '字段完整', weight: 6, type: 'positive' } },
      { criterion_id: 'R010', score: 0, evidence: '关键字段错误，触发扣分',
        raw: { description: '关键字段错误', weight: -10, type: 'penalty', passed: true } },
      { criterion_id: 'R011', score: 1, evidence: '文档可以渲染，未触发扣分',
        raw: { description: '不可渲染', weight: -10, type: 'penalty', passed: false } },
      { criterion_id: 'R012', score: 1, evidence: '不带 raw 的 OfficeBench 标准结果' },
    ],
  }
}

test('Cowork Judge 逐项说明映射到 Office Feedback，保留正分与扣分且不重算总分', () => {
  const raw = judgeFeedbackFixture()
  const before = structuredClone(raw)
  const result = normalizeCoworkJudgeResult(raw, 'fixture')
  assert.equal(result.total_score, 0.35)
  assert.equal(result.max_score, 1)
  assert.deepEqual(raw, before)
  assert.deepEqual(result.dim2_items.map(({ hit, delta, max_delta }) => ({ hit, delta, max_delta })), [
    { hit: false, delta: 0, max_delta: 4 },
    { hit: true, delta: 3, max_delta: 6 },
    { hit: true, delta: -10, max_delta: 0 },
    { hit: false, delta: 0, max_delta: 0 },
    { hit: true, delta: 1, max_delta: 1 },
  ])
  assert.match(result.dim2_items[0].rule, /R001: 章节与表格结构/u)
  assert.match(result.dim2_items[0].detail, /要求三张表，实际四张表/u)
  assert.match(result.dim2_items[2].detail, /score=0\/1 type=penalty/u)
  assert.match(result.dim2_items[4].detail, /不带 raw/u)
  assert.deepEqual(normalizeCoworkJudgeResult({ reward: 0 }, 'fixture').dim2_items, [])
})

test('Cowork Judge 非法逐项得分与权重必须报错，不能伪装成空反馈', () => {
  for (const score of [undefined, null, '1', -1, 2, NaN, Infinity]) {
    assert.throws(() => normalizeCoworkJudgeResult({
      reward: 0.5, criterion_results: [{ criterion_id: 'R001', score }],
    }, 'fixture'), /score 必须位于/u)
  }
  assert.throws(() => normalizeCoworkJudgeResult({
    reward: 0.5, criterion_results: [{ score: 1, raw: { weight: 'bad' } }],
  }, 'fixture'), /weight 无效/u)
})

test('Cowork 单题真实格式的 Judge 输出经过继承链后，逐项原因进入 Updater FeedbackPacket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cowork-feedback-fields-'))
  const taskRoot = join(root, 'task')
  const input = join(taskRoot, 'data', 'input_files', 'source.txt')
  await Promise.all([
    mkdir(join(taskRoot, 'tests'), { recursive: true }),
    mkdir(join(taskRoot, 'data', 'input_files'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(input, 'source'), writeFile(join(taskRoot, 'rubric.json'), '{}'),
    writeFile(join(taskRoot, 'task.toml'), ''), writeFile(join(taskRoot, 'tests', 'judge.py'), '# fixture\n'),
  ])
  const environment = new CoworkBenchEnvironment({
    runRoot: root, repositoryRoot,
    environment: {
      task: { workspacePath: '/workspace', maximumSolverAttempts: 5, workspaceLimits: {
        maximumFiles: 10, maximumBytes: 1024, maximumFileBytes: 1024,
        maximumChangedFiles: 10, maximumChangedBytes: 1024,
      } },
      docker: { resources: { timeoutSeconds: 10 } },
      verifier: { timeoutSeconds: 10, resources: {} },
      feedback: { maximumTextBytesPerCase: 32768 },
    },
    solverDriver: { async run({ taskWorkspace }) {
      await writeFile(join(taskWorkspace, 'done.docx'), 'fixture artifact')
      return { answer: 'done' }
    } },
    docker: { async run(options) {
      const logs = options.mounts.find((mount) => mount.target === '/logs').source
      await writeFile(join(logs, 'result.json'), JSON.stringify(judgeFeedbackFixture()))
    } },
  })
  environment.ensureRuntime = async () => ({ solverImage: 'fixture' })
  const trialOptions = {
    candidateId: 'h0', candidateWorkspace: root, model: {}, partition: 'feedback',
    seed: 1, trialIndex: 0, executionId: 'fixture',
    layout: { instanceId: 'cowork-evo/fixture', taskRoot, task: { instruction: 'fixture' }, inputs: [
      { source: input, name: 'source.txt', record: {
        bytes: 6, sha256: createHash('sha256').update('source').digest('hex'),
      } },
    ] },
  }
  const trial = await environment.runTrial(trialOptions)
  assert.equal(trial.reward, 0.35)
  const oldSession = join(trial.trialRoot, 'solver-session')
  await mkdir(oldSession, { recursive: true })
  await writeFile(join(oldSession, 'answer.txt'), 'done')
  environment.allowRuntimeRecovery = true
  environment.solverDriver.run = async () => { throw new Error('Solver must not rerun for verifier recovery') }
  const recovered = await environment.runTrial({
    ...trialOptions, executionId: 'recovery', previousTrialRoot: trial.trialRoot,
  })
  assert.equal(recovered.reward, trial.reward)
  assert.match(trial.verifierFeedback, /rule=R001: 章节与表格结构/u)
  assert.match(trial.verifierFeedback, /delta=-10\/0/u)
  assert.match(trial.verifierFeedback, /要求三张表，实际四张表/u)
  assert.equal((await readFile(join(trial.trialRoot, 'verifier-feedback.txt'), 'utf8')).trim(), trial.verifierFeedback)
  const packet = buildFeedbackPacket({
    runId: 'fixture', generation: 1, candidateId: 'h0',
    benchmark: { id: 'fixture', source: { revision: 'fixture' },
      partitions: { feedback: { instanceIds: ['cowork-evo/fixture'] } } },
    records: new Map([['cowork-evo/fixture', {
      instanceId: 'cowork-evo/fixture', reward: trial.reward, status: 'unresolved',
      feedback: { taskInstruction: 'fixture', solverAnswer: 'done', verifierFeedback: trial.verifierFeedback, errors: [] },
    }]]), maximumTextBytesPerCase: 32768,
  })
  assert.match(JSON.stringify(packet), /要求三张表，实际四张表/u)
  assert.match(JSON.stringify(packet), /关键字段错误，触发扣分/u)
})

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
      assert.equal(options.environment.INPUT_DIR, '/verifier/task/data/input_files')
      assert.equal(options.environment.DATA_DIR, '/verifier/task/data/input_files')
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
          PYTHONPATH: join(staged.source, 'task/tests'),
          INPUT_DIR: join(staged.source, 'task/data/input_files'),
          DATA_DIR: join(staged.source, 'task/data/input_files') },
      })
    } },
  })
  const result = await environment.runVerifier({
    layout: { taskRoot, instanceId: 'fixture' }, submission,
    logs: join(root, 'logs'), verifierCode: join(root, 'verifier-code'), name: 'fixture',
  })
  assert.equal(result.total_score, 0.5)
})

test('Cowork-Bench accepts score/criteria judges and supplies their original input directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cowork-score-'))
  const tests = join(root, 'tests')
  const input = join(root, 'data', 'input_files')
  const submission = join(root, 'submission')
  await mkdir(tests)
  await mkdir(input, { recursive: true })
  await mkdir(submission)
  await writeFile(join(input, 'input.txt'), 'original')
  const judge = join(tests, 'judge.py')
  await writeFile(judge, [
    'import argparse, json',
    'from pathlib import Path',
    'p = argparse.ArgumentParser()',
    'p.add_argument("--artifact-dir")',
    'p.add_argument("--result")',
    'p.add_argument("--data-dir", required=True)',
    'p.add_argument("--input-dir", required=True)',
    'p.add_argument("--source-dir", required=True)',
    'a = p.parse_args()',
    'assert a.input_dir == a.data_dir',
    'assert a.source_dir == a.data_dir',
    'assert (Path(a.data_dir) / "input.txt").read_text() == "original"',
    'Path(a.result).write_text(json.dumps({"score": 0.4, "criteria": [{"id": "R001", "score": 0, "weight": 5, "passed": False, "evidence": "missing"}]}))',
  ].join('\n'))
  const output = join(root, 'result.json')
  await execFileAsync('python3', [resolve(repositoryRoot, 'docker/cowork-bench/run-verifier.py'),
    '--judge', judge, '--submission', submission, '--output', output, '--expected-id', 'fixture'])
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.reward, 0.4)
  assert.equal(result.criterion_results[0].raw.weight, 5)
  assert.equal(normalizeCoworkJudgeResult(result, 'fixture').total_score, 0.4)
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

test('Cowork-Bench Judge 因提交内容无法解析而退出 1 时记为 0 分', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cowork-bench-malformed-'))
  const submission = join(root, 'submission')
  const judge = join(root, 'judge.py')
  const output = join(root, 'result.json')
  await mkdir(submission)
  await writeFile(judge, 'raise ValueError("malformed workbook")\n')
  await execFileAsync('python3', [
    resolve(repositoryRoot, 'docker/cowork-bench/run-verifier.py'),
    '--judge', judge,
    '--submission', submission,
    '--output', output,
    '--expected-id', 'malformed-workbook',
  ])
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.reward, 0)
  assert.equal(result.passed, false)
  assert.match(result.judge_error, /malformed workbook/u)
})
