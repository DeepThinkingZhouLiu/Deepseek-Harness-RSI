import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCliUsageLedger,
  recordCliUsageAudit,
} from '../src/runtimes/cli-updater-common.mjs'

test('CLI Usage 忽略本地探活，只统计已转发的上游模型请求', () => {
  const usage = createCliUsageLedger()
  recordCliUsageAudit(usage, { origin: 'gateway', status: 404 })
  recordCliUsageAudit(usage, {
    origin: 'upstream',
    status: 200,
    usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 },
  })

  assert.deepEqual(usage, {
    complete: true,
    requests: 1,
    usageResponses: 1,
    unknownUsageResponses: 0,
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    observedInputTokens: 11,
    observedOutputTokens: 7,
    cacheReadTokens: 3,
    reasoningTokens: 0,
  })
})
