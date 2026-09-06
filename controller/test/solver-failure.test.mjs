import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classifySolverFailure, solverProcessEvidence, validateSolverFailures } from '../src/solver-failure.mjs'
import { assertExecutionIdentity, captureExecutionIdentity, evolutionFingerprint } from '../src/execution-identity.mjs'
import { runProcess } from '../src/process.mjs'
import { responseObserver } from '../../docker/model-gateway/diagnostics.mjs'

const processEvidence = solverProcessEvidence({ exitCode: 1, stderr: 'ValueError: arbitrary candidate text' })
const valid = {
  origin: 'upstream', httpStatus: 200, responseComplete: true, done: true, malformedEvents: 0,
  contentBytes: 50, finishReason: 'stop', sawReasoning: false, sawToolCalls: false, requestedTools: false,
}

test('Provider 反射密钥到 Request ID 时不保存该 ID，也不保存 reasoning 正文', () => {
  const secret = 'fixture-provider-secret'
  const record = { contentBytes: 0, responseBytes: 0, malformedEvents: 0 }
  const observer = responseObserver(record, { secretValues: [secret] })
  observer.headers(200, { 'x-request-id': `request-${secret}` })
  observer.chunk(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: secret } }] })}\n\n`))
  observer.end()
  assert.equal(record.upstreamRequestId, null)
  assert.equal(record.sawReasoning, true)
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret, 'u'))
})

test('Solver 归因只依赖可信观测：有效输出后解析失败可进化；reasoning-only 与无契约 tools 未定责', () => {
  const classify = (request, overrides = {}) => classifySolverFailure({
    process: processEvidence, diagnostics: { complete: true, requests: [request] }, ...overrides,
  })
  assert.equal(classify(valid).category, 'candidate')
  assert.equal(classify({ ...valid, contentBytes: 0, sawReasoning: true }).code, 'reasoning-only-response')
  assert.equal(classify({ ...valid, contentBytes: 0, sawToolCalls: true }).code, 'unrequested-native-tool-calls')
  assert.equal(classify({ ...valid, contentBytes: 0 }).category, 'unknown')
  assert.equal(classify({ ...valid, httpStatus: 400 }).category, 'unknown')
  assert.equal(classify({ ...valid, origin: 'gateway-request', httpStatus: 400, errorCode: 'invalid-json-request' }).category, 'candidate')
  for (const status of [429, 502]) assert.equal(classify({ ...valid, httpStatus: status }).category, 'provider')
  for (const status of [401, 403]) assert.equal(classify({ ...valid, httpStatus: status }).category, 'trusted-runtime')
  assert.equal(classify({ ...valid, transportError: true, responseComplete: false }).category, 'provider')
  assert.equal(classify(valid, { diagnostics: null }).category, 'unknown')
  assert.equal(classify(valid, { process: { ...processEvidence, timedOut: true } }).category, 'trusted-runtime')
  assert.deepEqual(validateSolverFailures(undefined), [])
  assert.deepEqual(validateSolverFailures(null), [])
  assert.throws(() => validateSolverFailures([{ category: 'candidate', terminal: true }]))
})

test('执行身份忽略 README/tests 和 config-only 提交，但拒绝真实源码、依赖和 Runtime 漂移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-execution-identity-'))
  const dependencyRoot = join(root, 'fixture-dependency')
  await Promise.all([mkdir(join(root, 'controller', 'src'), { recursive: true }), mkdir(dependencyRoot)])
  await writeFile(join(root, 'controller', 'src', 'fixture.mjs'), 'export const value = 1\n')
  await writeFile(join(dependencyRoot, 'index.js'), 'fixture dependency\n')
  const options = { dependencyRoot, nodeVersion: 'v24.0.0' }
  const initial = await captureExecutionIdentity(root, options)
  await mkdir(join(root, 'controller', 'test'))
  await mkdir(join(root, 'experiments'))
  await writeFile(join(root, 'README.md'), 'only docs changed\n')
  await writeFile(join(root, 'controller', 'test', 'fixture.test.mjs'), 'fixture test\n')
  await writeFile(join(root, 'experiments', 'same-config.json'), '{"frozen":"same semantic content"}\n')
  assertExecutionIdentity(initial, await captureExecutionIdentity(root, options))
  await writeFile(join(root, 'controller', 'src', 'fixture.mjs'), 'export const value = 2\n')
  assert.throws(() => assertExecutionIdentity(initial, { ...initial, digest: 'a'.repeat(64) }))
  const drift = await captureExecutionIdentity(root, options)
  assert.throws(() => assertExecutionIdentity(initial, drift), (error) => error.exitCode === 3
    && error.details.includes('controller/src/fixture.mjs'))
  assert.throws(() => assertExecutionIdentity(null, drift), /旧 Run 缺少/u)
  await writeFile(join(root, 'controller', 'src', 'fixture.mjs'), 'export const value = 1\n')
  await writeFile(join(dependencyRoot, 'index.js'), 'changed dependency\n')
  const dependencyDrift = await captureExecutionIdentity(root, options)
  assert.throws(() => assertExecutionIdentity(initial, dependencyDrift), (error) => error.details.includes('dependency:yaml'))
  const runtimeDrift = await captureExecutionIdentity(root, { ...options, nodeVersion: 'v25.0.0' })
  assert.throws(() => assertExecutionIdentity(initial, runtimeDrift), (error) => error.details.includes('runtime:nodeVersion'))
})

test('零请求退出、混合请求结果、截断和拒绝终止均不足以给 Candidate 定责', () => {
  const classify = (requests, process = processEvidence) => classifySolverFailure({
    diagnostics: { complete: true, requests }, process,
  })
  assert.equal(classify([]).category, 'unknown')
  assert.equal(classify([], { ...processEvidence, exitCode: 0, outputContractFailed: true }).category, 'candidate')
  assert.equal(classify([{ ...valid, contentBytes: 0, sawReasoning: true }, valid]).code, 'mixed-request-outcomes')
  assert.equal(classify([{ ...valid, httpStatus: 502 }, valid]).category, 'unknown')
  assert.equal(classify([{ ...valid, httpStatus: 401 }, {
    origin: 'gateway-request', httpStatus: 400, errorCode: 'invalid-json-request', responseComplete: true,
  }]).category, 'unknown')
  assert.equal(classify([{ ...valid, finishReason: 'content_filter' }]).category, 'unknown')
  assert.equal(classify([{ ...valid, hasFinalContent: false }]).category, 'unknown')
  const failure = classify([valid])
  assert.deepEqual(validateSolverFailures([{ ...failure, diagnostics: {} }])[0].diagnostics.requests, [])
  assert.deepEqual(validateSolverFailures([{ ...failure, diagnostics: { requests: null } }])[0].diagnostics.requests, [])
  assert.throws(() => validateSolverFailures([{ ...failure, diagnostics: { requests: 'invalid' } }]))
})

test('同版本 Node 二进制实际内容变化会拒绝恢复；新旧 Final 指纹各自保持一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-runtime-content-'))
  const dependencyRoot = join(root, 'dependencies')
  await mkdir(dependencyRoot)
  await writeFile(join(dependencyRoot, 'index.js'), 'fixture')
  const nodeBinary = join(root, 'node-binary-fixture')
  await writeFile(nodeBinary, 'first bytes')
  const initial = await captureExecutionIdentity(root, { dependencyRoot, nodeBinary })
  await writeFile(nodeBinary, 'other bytes')
  const changed = await captureExecutionIdentity(root, { dependencyRoot, nodeBinary })
  assert.throws(() => assertExecutionIdentity(initial, changed), (error) => error.details.includes('runtime:nodeBinary'))
  const input = { executionIdentity: initial, configDigest: 'b'.repeat(64), controllerRevision: 'a'.repeat(40) }
  assert.equal(evolutionFingerprint(input), evolutionFingerprint({ ...input, controllerRevision: 'c'.repeat(40) }))
  assert.notEqual(evolutionFingerprint(input), evolutionFingerprint({ ...input, executionIdentity: changed }))
  assert.notEqual(evolutionFingerprint({ ...input, executionIdentity: null }), evolutionFingerprint(input))
})

test('真实 Git 提交未提交过但执行内容相同的配置不会改变执行指纹', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-execution-git-'))
  const dependencyRoot = join(root, 'fixture-dependency')
  await mkdir(join(root, 'controller/src'), { recursive: true })
  await mkdir(dependencyRoot)
  await writeFile(join(root, 'controller/src/run.mjs'), 'export const value = 1\n')
  await writeFile(join(dependencyRoot, 'index.js'), 'fixture dependency')
  const git = (args) => runProcess('git', [
    '-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ])
  await git(['init'])
  await git(['add', 'controller/src/run.mjs'])
  await git(['commit', '-m', 'fixture code'])
  const originalRevision = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  await mkdir(join(root, 'experiments'))
  await writeFile(join(root, 'experiments/config.json'), '{"budget":2}\n')
  const original = await captureExecutionIdentity(root, { dependencyRoot })
  await git(['add', 'experiments/config.json'])
  await git(['commit', '-m', 'fixture same runtime config now committed'])
  assert.notEqual((await git(['rev-parse', 'HEAD'])).stdout.trim(), originalRevision)
  assertExecutionIdentity(original, await captureExecutionIdentity(root, { dependencyRoot }))
})
