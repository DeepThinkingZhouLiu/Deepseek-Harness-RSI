import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadExperimentBundle, validateEnvironmentAdapter } from '../src/adapters.mjs'
import { readConfigFile } from '../src/config.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

test('AgentBay keeps the GRHS recipe and allows 200 concurrent trials and requests', async () => {
  for (const name of ['mvp-single', 'main16-codex-single']) {
    const bundle = await loadExperimentBundle(resolve(root, `experiments/cowork-msa-grhs-${name}-agentbay.json`), root)
    assert.equal(bundle.environment.docker.backend, 'agentbay')
    assert.equal(bundle.environment.task.maximumConcurrentTrials, 200)
    assert.equal(bundle.environment.modelGateway.maximumConcurrentRequests, 200)
    assert.equal(bundle.strategy.implementation, 'group-relative-harness')
    assert.equal(bundle.recipe.spec.moduleSearch.group.enabled, true)
  }
})

test('Local Docker retains its existing concurrency bounds', async () => {
  const config = await readConfigFile(resolve(root, 'environments/omegause-officeval.yml'))
  assert.equal(validateEnvironmentAdapter(config).docker.backend, 'local')
  config.spec.task.maximumConcurrentTrials = 200
  assert.throws(() => validateEnvironmentAdapter(config), /maximumConcurrentTrials/)
})
