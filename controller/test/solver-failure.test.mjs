import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classifySolverFailure, solverProcessEvidence, validateSolverFailures } from '../src/solver-failure.mjs'
import { assertExecutionIdentity, captureExecutionIdentity } from '../src/execution-identity.mjs'

const processEvidence = solverProcessEvidence({ exitCode: 1, stderr: 'ValueError: arbitrary candidate text' })
const valid = {
  origin: 'upstream', httpStatus: 200, responseComplete: true, done: true, malformedEvents: 0,
  contentBytes: 50, finishReason: 'stop', sawReasoning: false, sawToolCalls: false, requestedTools: false,
}

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
  assert.throws(() => assertExecutionIdentity(initial, initial.digest === '' ? initial : { ...initial, digest: 'a'.repeat(64) }))
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
