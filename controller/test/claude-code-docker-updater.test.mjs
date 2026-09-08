import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createClaudeCodeDockerUpdaterDriver } from '../src/runtimes/claude-code-docker-updater.mjs'

test('Remote Claude updater stages candidate, uses gateway credentials and returns mutation report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-docker-test-'))
  const keyName = 'RSI_TEST_CLAUDE_DOCKER_KEY'
  const urlName = 'RSI_TEST_CLAUDE_DOCKER_URL'
  process.env[keyName] = 'test-only-provider-key'
  process.env[urlName] = 'https://provider.example'
  try {
    for (const name of ['candidate', 'feedback', 'upstream']) await mkdir(join(root, name))
    await writeFile(join(root, 'candidate/agent.py'), '# initial\n')
    let runs = 0
    let rotations = 0
    let builds = 0
    const report = { diagnosis: 'test', hypothesis: 'test', changedFiles: ['agent.py'],
      expectedImpact: 'test', validation: ['test'], remainingRisks: '' }
    const driver = createClaudeCodeDockerUpdaterDriver({
      repositoryRoot: root,
      updater: { protocol: 'claude-code-docker-v1', runtime: { image: 'claude:test',
        dockerfile: 'Dockerfile', version: '2.1.260', maximumModelRequests: 64 } },
      provider: { credentials: { apiKeyEnvironment: keyName, baseUrlEnvironment: urlName } },
      modelGateway: { async rotateRoleToken(role) { assert.equal(role, 'solver'); rotations++ } },
      docker: {
        async imageExists() { return false },
        async build() { builds++ },
        async run(options) {
          runs++
          assert.equal(options.secretEnvironment.UPDATER_PROVIDER_KEY, process.env[keyName])
          assert.equal(options.environment.UPDATER_PROVIDER_KEY, undefined)
          assert.equal(options.environment.PYTHONDONTWRITEBYTECODE, '1')
          assert.equal(options.environment.UPDATER_EFFORT, 'high')
          assert.ok(options.command[0].includes('/opt/harness-rsi/output/report.json'))
          for (const mount of options.mounts) {
            if (mount.target.endsWith('/output')) await writeFile(join(mount.source, 'report.json'), JSON.stringify(report))
            if (mount.target === '/control-output') await writeFile(join(mount.source, 'audit.json'), '[]')
          }
          return { exitCode: 0, stdout: 'done', stderr: '' }
        },
      },
    })
    await driver.ensureRuntime()
    const result = await driver.run({ candidateWorkspace: join(root, 'candidate'),
      upstreamSource: join(root, 'upstream'), contextDirectory: join(root, 'feedback'),
      outputDirectory: join(root, 'output'), name: 'test-claude', reportName: 'report.json',
      model: { model: 'claude-sonnet-5', reasoningEffort: 'high', maxTokens: 65536 },
      targetId: 'msa', mutationLevel: 'l3', timeoutMs: 30000,
    })
    assert.deepEqual(result.report, report)
    assert.equal(runs, 1)
    assert.equal(rotations, 1)
    assert.equal(builds, 1)
  } finally {
    delete process.env[keyName]
    delete process.env[urlName]
    await rm(root, { recursive: true, force: true })
  }
})
