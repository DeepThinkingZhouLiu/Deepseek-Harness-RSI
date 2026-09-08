import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentBayDockerClient } from '../src/agentbay-docker.mjs'

test('One bridge handles concurrent runs, transfers writable output and supplies build mirrors', async () => {
  const names = ['TEST_AGENTBAY_IMAGE', 'TEST_AGENTBAY_POLICY', 'TEST_AGENTBAY_PYTHON']
  const saved = names.map(name => process.env[name])
  names.forEach((name, index) => { process.env[name] = ['image', 'policy', '/usr/bin/python3'][index] })
  try {
    const calls = []
    let bridges = 0
    let path = 0
    const client = new AgentBayDockerClient({
      repositoryRoot: '/repo',
      runAsCurrentUser: false,
      agentBay: {
        imageIdEnvironment: names[0], policyIdEnvironment: names[1],
        pythonExecutableEnvironment: names[2],
        bridgePath: 'scripts/agentbay-docker-bridge.py',
        registryMirror: 'https://docker.1panel.live',
      },
      bridgeFactory: () => {
        bridges++
        return { async request(operation, payload) {
          calls.push({ operation, ...payload })
          if (operation === 'allocatePath') return { path: `/remote/${++path}` }
          return { exitCode: 0, stdout: 'ok', stderr: '' }
        } }
      },
    })
    await Promise.all(Array.from({ length: 200 }, (_, i) => client.run({
      image: 'solver', name: `trial-${i}`,
      mounts: [
        { source: `/input/${i}`, target: '/input', readOnly: true },
        { source: `/output/${i}`, target: '/output', readOnly: false },
      ],
    })))
    assert.equal(bridges, 1)
    assert.equal(calls.filter(call => call.operation === 'downloadDir').length, 200)
    assert.equal(calls.filter(call => call.operation === 'uploadDir').length, 400)
    assert.equal(calls.filter(call => call.operation === 'removePath').length, 400)
    assert.ok(calls.filter(call => call.operation === 'downloadDir').every(call => call.localPath.startsWith('/output/')))
    await client.build({ context: '/repo', dockerfile: '/repo/Dockerfile', tag: 'runtime' })
    const build = calls.find(call => call.args?.[0] === 'build')
    assert.equal(build.timeoutSeconds, 14400)
    assert.ok(build.args.includes('DEBIAN_MIRROR=https://mirrors.tencent.com/debian'))
    assert.ok(build.args.includes('PYPI_INDEX_URL=https://mirrors.tencent.com/pypi/simple/'))
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name]
      else process.env[name] = saved[index]
    })
  }
})
