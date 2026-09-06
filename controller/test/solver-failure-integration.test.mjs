import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { buildFeedbackPacket } from '../src/feedback.mjs'
import { saveRejectedCandidateEvidence, loadRejectedCandidateEvidence } from '../src/failure-feedback.mjs'
import { SolverFailure } from '../src/solver-failure.mjs'
import { runtimeFixture, startFixtureGateway } from './fixtures/solver-failure-runtime.mjs'

async function partition(fixture, candidateId = 'h0') {
  const runRoot = join(fixture.root, 'run')
  const environment = fixture.environmentFactory({ repositoryRoot: fixture.root, runRoot })
  await environment.preflight()
  const options = {
    candidateId, candidateDigest: 'a'.repeat(64), candidateWorkspace: fixture.candidate,
    model: fixture.bundle.experiment.models.solver, partition: 'feedback', seeds: [1],
    outputPath: join(runRoot, `${candidateId}-feedback.jsonl`),
  }
  return { environment, options, runRoot }
}

test('真实网关→MSA Driver→Environment：有效模型输出后解析失败保留原 Rubric 分数并继续下一题', async (t) => {
  const fixture = await runtimeFixture(t, { cases: ['valid', 'valid'] })
  const { environment, options, runRoot } = await partition(fixture)
  const records = await environment.runCandidatePartition(options)
  assert.equal(records.size, 2)
  assert.equal(fixture.verifierCalls(), 2)
  const requestIds = new Set()
  for (const record of records.values()) {
    assert.equal(record.reward, 0.5)
    assert.equal(record.solverFailures[0].category, 'candidate')
    assert.equal(record.solverFailures[0].process.exceptionTypes[0], 'JSONDecodeError')
    assert.equal(record.solverFailures[0].context.instanceId, record.instanceId)
    const request = record.solverFailures[0].diagnostics.requests[0]
    assert.ok(request.contentBytes > 0)
    assert.equal(request.responseComplete, true)
    requestIds.add(request.requestId)
    assert.equal(record.inputTokens, 5)
  }
  assert.equal(requestIds.size, 2)
  const before = fixture.gateway.observed.length
  await environment.runCandidatePartition(options)
  assert.equal(fixture.gateway.observed.length, before)
  assert.equal(fixture.verifierCalls(), 2)
  const packet = buildFeedbackPacket({
    runId: 'fixture', generation: 1, candidateId: 'h0', benchmark: fixture.benchmark,
    records, maximumTextBytesPerCase: 8192,
  })
  assert.equal(packet.spec.cases[0].solverFailures[0].category, 'candidate')
  const candidate = { id: 'g001-l3', digest: options.candidateDigest, workspace: fixture.candidate,
    report: { changedFiles: ['run.py'] } }
  const reference = await saveRejectedCandidateEvidence({
    runRoot, generation: 1, candidate, parentId: 'h0', records, partition: 'feedback',
    bundle: { ...fixture.bundle, benchmark: fixture.benchmark },
  })
  const evidence = await loadRejectedCandidateEvidence(runRoot, reference)
  assert.equal(evidence.source.candidateId, 'g001-l3')
  assert.equal(evidence.cases.length, 2)
  assert.ok(evidence.code.some((item) => item.path === 'model.py'))
  assert.ok(evidence.code.some((item) => item.path === 'run.py' && item.text.includes('json.loads(text)')))
})

test('并发 A 可评测、B reasoning-only 暂停：不串题，不丢已提交 A，恢复只补 B', async (t) => {
  const fixture = await runtimeFixture(t, { cases: ['valid', 'reasoning'] })
  const { environment, options } = await partition(fixture)
  await assert.rejects(environment.runCandidatePartition(options), (error) => error instanceof SolverFailure
    && error.failure.category === 'unknown' && error.failure.code === 'reasoning-only-response'
    && error.failure.context.instanceId === 'officeval_002')
  assert.equal(fixture.verifierCalls(), 1)
  assert.equal(fixture.gateway.observed.filter((entry) => entry.mode === 'reasoning').length, 3)
  fixture.modes.set('reasoning', 'valid')
  const records = await environment.runCandidatePartition(options)
  assert.equal(records.size, 2)
  assert.equal(fixture.verifierCalls(), 2)
  assert.equal(fixture.gateway.observed.filter((entry) => entry.mode === 'valid').length, 2)
  const raw = JSON.stringify([...records.values()])
  assert.doesNotMatch(raw, /PRIVATE_REASONING_MUST_NOT_LEAK/u)
})

test('真实网关的无契约 tool_calls / 401 / 429 / 502 / SSE 中断均不伪装为 Candidate 零分', async (t) => {
  for (const [mode, category] of [
    ['tools', 'unknown'], ['http401', 'trusted-runtime'], ['http429', 'provider'],
    ['http502', 'provider'], ['interrupt', 'provider'],
  ]) {
    await t.test(mode, async (child) => {
      const fixture = await runtimeFixture(child, { cases: [mode] })
      const { environment, options } = await partition(fixture)
      await assert.rejects(environment.runCandidatePartition(options), (error) => error instanceof SolverFailure
        && error.failure.category === category)
      assert.equal(fixture.verifierCalls(), 0)
      assert.equal(fixture.gateway.observed.length, 1)
      await assert.rejects(readFile(options.outputPath), { code: 'ENOENT' })
    })
  }
})

test('Selection 失败证据仅保留聚合计数及原 Candidate 代码，不暴露逐题诊断', async (t) => {
  const fixture = await runtimeFixture(t)
  const { environment, options, runRoot } = await partition(fixture)
  const records = await environment.runCandidatePartition(options)
  const reference = await saveRejectedCandidateEvidence({
    runRoot, generation: 1,
    candidate: { id: 'g001-l3', digest: 'b'.repeat(64), workspace: fixture.candidate, report: { changedFiles: ['run.py'] } },
    parentId: 'h0', records, partition: 'selection', bundle: fixture.bundle,
  })
  const evidence = await loadRejectedCandidateEvidence(runRoot, reference)
  assert.equal(evidence.source.visibility, 'aggregate-only')
  assert.equal(evidence.aggregate.runtimeFailures, 1)
  assert.deepEqual(evidence.cases, [])
  assert.doesNotMatch(JSON.stringify(evidence), /officeval_001|upstreamRequestId|fixture deliverable/u)
})

test('同一 Trial 相同模型请求全链路最多首次加 5 次重试，诊断接口不向 Candidate 开放', async (t) => {
  const gateway = await startFixtureGateway(t)
  const context = { trialId: 'fixture-retry-cap', candidateId: 'h0', candidateDigest: 'a'.repeat(64),
    partition: 'feedback', instanceId: 'officeval_001', seed: 1 }
  const access = await gateway.beginTrial(context, {
    model: 'fixture', maxTokens: 128, maxTokensField: 'max_tokens', reasoningEffort: 'high',
  })
  const token = access.secretEnvironment.RSI_PROVIDER_API_KEY
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'CASE=reasoning fixture' }] })
  for (let index = 0; index < 7; index += 1) {
    const response = await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers, body })
    assert.equal(response.status, index < 6 ? 200 : 429)
    await response.text()
  }
  assert.equal(gateway.observed.length, 6)
  const denied = await fetch(`${gateway.url}/rsi/trials`, {
    method: 'POST', headers, body: JSON.stringify({ trialId: context.trialId, close: true }),
  })
  assert.equal(denied.status, 401)
  const diagnostic = await gateway.endTrial(context.trialId)
  assert.equal(diagnostic.requests.length, 7)
  assert.equal(diagnostic.requests.at(-1).errorCode, 'identical-request-retry-budget-exhausted')
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_REASONING_MUST_NOT_LEAK|fixture-provider-key/u)
})

test('可信 Verifier 失败保持未完成，不将可用部分产物结算成零分', async (t) => {
  const fixture = await runtimeFixture(t)
  const { environment, options } = await partition(fixture)
  environment.runVerifier = async () => { throw new Error('fixture verifier unavailable') }
  await assert.rejects(environment.runCandidatePartition(options), (error) => error instanceof SolverFailure
    && error.failure.category === 'trusted-runtime' && error.failure.code === 'verifier-infrastructure')
  await assert.rejects(readFile(options.outputPath), { code: 'ENOENT' })
})
