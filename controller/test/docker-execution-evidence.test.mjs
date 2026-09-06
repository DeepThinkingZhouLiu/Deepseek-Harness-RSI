import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DockerClient } from '../src/docker.mjs'
import { classifySolverFailure, solverProcessEvidence } from '../src/solver-failure.mjs'

async function fixture(t, state, { corruptId = false, createFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-docker-state-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'docker-fixture')
  const log = join(root, 'calls.jsonl')
  await writeFile(binary, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const state = ${JSON.stringify(state)}
if (args[0] === 'run') {
  if (${createFails}) process.exit(125)
  const index = args.indexOf('--cidfile')
  if (index >= 0) writeFileSync(args[index + 1], ${JSON.stringify(corruptId ? 'wrong-id' : 'a'.repeat(64))})
  process.exit(state.ExitCode)
}
if (args[0] === 'inspect') process.stdout.write(JSON.stringify(state))
`, { mode: 0o700 })
  await chmod(binary, 0o700)
  const docker = new DockerClient({ binary, runAsCurrentUser: false })
  return { docker, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) }
}

const exited = { Status: 'exited', Error: '', OOMKilled: false, ExitCode: 1,
  StartedAt: '2026-09-06T00:00:00Z', FinishedAt: '2026-09-06T00:00:01Z' }

test('Docker 先按私有 CID 读取可信状态再清理，启动后的零请求崩溃可交给 Updater', async (t) => {
  const { docker, calls } = await fixture(t, exited)
  await assert.rejects(docker.run({ image: 'fixture', name: 'fixture', captureExecutionEvidence: true }), (error) => {
    const process = solverProcessEvidence(error.processResult)
    assert.equal(process.containerState.started, true)
    assert.equal(classifySolverFailure({ process, diagnostics: { complete: true, requests: [] } }).category, 'candidate')
    return true
  })
  const actual = await calls()
  assert.deepEqual(actual.map((call) => call[0]), ['run', 'inspect', 'rm'])
  assert.equal(actual[0].includes('--rm'), false)
  assert.equal(actual[1].at(-1), 'a'.repeat(64))
  assert.equal(actual[2].at(-1), 'a'.repeat(64))
  await assert.rejects(readFile(actual[0][actual[0].indexOf('--cidfile') + 1]), { code: 'ENOENT' })
})

test('Docker 成功也记录状态；真实 OOM 不被当成 Candidate 失败', async (t) => {
  const success = await fixture(t, { ...exited, ExitCode: 0 })
  const result = await success.docker.run({ image: 'fixture', name: 'fixture', captureExecutionEvidence: true })
  assert.equal(result.containerState.exitCode, 0)
  assert.deepEqual((await success.calls()).map((call) => call[0]), ['run', 'inspect', 'rm'])
  const oom = await fixture(t, { ...exited, ExitCode: 137, OOMKilled: true })
  await assert.rejects(oom.docker.run({ image: 'fixture', name: 'fixture', captureExecutionEvidence: true }), (error) => {
    assert.equal(classifySolverFailure({ process: solverProcessEvidence(error.processResult),
      diagnostics: { complete: true, requests: [] } }).category, 'trusted-runtime')
    return true
  })
})

test('Docker 未创建或 CID 损坏不读取或删除同名容器', async (t) => {
  for (const options of [{ createFails: true }, { corruptId: true }]) {
    const { docker, calls } = await fixture(t, exited, options)
    await assert.rejects(docker.run({ image: 'fixture', name: 'existing-user-container', captureExecutionEvidence: true }), (error) => {
      assert.equal(error.processResult.containerState, null)
      return true
    })
    assert.deepEqual((await calls()).map((call) => call[0]), ['run'])
  }
})
