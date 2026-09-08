import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runProcess } from '../src/process.mjs'
import { ProtocolError } from '../src/protocol.mjs'
import { retryableTrialError, runTrialStage } from '../src/trial-stage-runner.mjs'

const context = { candidateId: 'h0', instanceId: 'fixture', partition: 'feedback', seed: 1 }

test('Trial 在进程删除后仍保留已脱敏的 stderr、退出码与超时状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-trial-diagnostic-'))
  const secret = 'sk-fixture-sensitive-123456789'
  await assert.rejects(runTrialStage({
    trialRoot: root, context, stage: 'solver',
    operation: () => runProcess(process.execPath, ['-e',
      'process.stderr.write(process.env.FIXTURE_SECRET); process.exit(17)',
    ], { env: { ...process.env, FIXTURE_SECRET: secret }, secretValues: [secret] }),
  }), /Trial solver 失败/u)
  const raw = await readFile(join(root, 'diagnostics/solver-1.json'), 'utf8')
  const record = JSON.parse(raw)
  assert.equal(record.error.process.exitCode, 17)
  assert.equal(record.error.process.timedOut, false)
  assert.equal(record.error.process.stderr, '[REDACTED]')
  assert.equal(record.willRetry, false)
  assert.ok(!raw.includes(secret))
  assert.ok(!raw.includes('FIXTURE_SECRET'))
})

test('Trial 瞬时错误先落盘，再准备重试，并保留每次错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-trial-retry-'))
  const attempts = []
  const result = await runTrialStage({
    trialRoot: root, context, stage: 'solver', retryDelayMs: 0,
    operation: async (attempt) => {
      attempts.push(attempt)
      if (attempt < 3) throw new ProtocolError('model gateway transient response failure after 8 attempt(s)')
      return { reward: 0 }
    },
    prepareRetry: async (attempt) => {
      const record = JSON.parse(await readFile(join(root, `diagnostics/solver-${attempt}.json`), 'utf8'))
      assert.equal(record.willRetry, true)
    },
  })
  assert.deepEqual(attempts, [1, 2, 3])
  assert.deepEqual(result, { reward: 0 })
  assert.deepEqual((await readdir(join(root, 'diagnostics'))).sort(), ['solver-1.json', 'solver-2.json'])
})

test('Trial 重试耗尽后抛错，不伪造 0 分；永久错误只运行一次', async () => {
  for (const [message, expectedAttempts] of [
    ['model gateway returned retryable HTTP 503', 3],
    ['model gateway returned no final content after 1 attempt(s) (finish_reason=tool_calls)', 3],
    ['model gateway HTTP 401', 1],
    ['ModuleNotFoundError: upstream_verifier', 1],
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'rsi-trial-exhausted-'))
    let calls = 0
    await assert.rejects(runTrialStage({
      trialRoot: root, context, stage: 'verifier', retryDelayMs: 0,
      operation: async () => { calls += 1; throw new ProtocolError(message) },
    }), /Trial verifier 失败/u)
    assert.equal(calls, expectedAttempts)
    const record = JSON.parse(await readFile(join(root, `diagnostics/verifier-${calls}.json`), 'utf8'))
    assert.equal(record.willRetry, false)
  }
  assert.equal(retryableTrialError({ processResult: { timedOut: true } }), true)
  assert.equal(retryableTrialError(new ProtocolError('无效的 Trace')), false)
})

test('Trial 可明确配置五次尝试，第五次仍失败则停止并保留全部记录', async () => {
  for (const succeeds of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'rsi-trial-five-attempts-'))
    let calls = 0
    const run = runTrialStage({
      trialRoot: root, context, stage: 'solver', maximumAttempts: 5, retryDelayMs: 0,
      operation: async (attempt) => {
        calls += 1
        if (succeeds && attempt === 5) return 'done'
        throw new ProtocolError('model gateway returned no final content after 3 attempt(s) (finish_reason=stop)')
      },
    })
    if (succeeds) assert.equal(await run, 'done')
    else await assert.rejects(run, /Trial solver 失败/u)
    assert.equal(calls, 5)
    const files = await readdir(join(root, 'diagnostics'))
    assert.equal(files.length, succeeds ? 4 : 5)
    for (let attempt = 1; attempt <= files.length; attempt += 1) {
      const record = JSON.parse(await readFile(join(root, `diagnostics/solver-${attempt}.json`), 'utf8'))
      assert.equal(record.willRetry, attempt < 5)
    }
  }
})

test('Trial 拒绝非法尝试次数，不开始执行', async () => {
  for (const maximumAttempts of [0, 6, 1.5, '5']) {
    await assert.rejects(runTrialStage({
      maximumAttempts, operation: () => assert.fail('非法配置不得执行'),
    }), /重试参数无效/u)
  }
})
