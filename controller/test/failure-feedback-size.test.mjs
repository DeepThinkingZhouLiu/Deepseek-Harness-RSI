import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadRejectedCandidateEvidence, saveRejectedCandidateEvidence } from '../src/failure-feedback.mjs'

test('多题失败反馈按实际落盘字节限长，保存后必须能重新加载', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-feedback-size-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'candidate')
  await mkdir(workspace)
  const ids = Array.from({ length: 26 }, (_, i) => `officeval_${String(i + 1).padStart(3, '0')}`)
  const records = new Map(ids.map((instanceId) => [instanceId, {
    instanceId, status: 'unresolved', reward: 0, trialRewards: [0], policyViolations: [],
    artifacts: [], feedback: { taskInstruction: '任务'.repeat(1000), verifierFeedback: '评分'.repeat(1000) },
  }]))
  records.get(ids.at(-1)).solverFailures = [{
    protocol: 'harness-rsi/solver-failure-v1', category: 'candidate',
    code: 'candidate-process-exit', terminal: true, diagnostics: null,
  }]
  const reference = await saveRejectedCandidateEvidence({
    runRoot: root, generation: 1, parentId: 'h0', records, partition: 'feedback',
    candidate: { id: 'g001-l3', digest: 'a'.repeat(64), workspace, report: { changedFiles: [] } },
    bundle: { benchmark: { id: 'fixture', source: { revision: 'fixture' }, partitions: { feedback: { instanceIds: ids } } },
      environment: { feedback: { maximumTextBytesPerCase: 8192 } } },
  })
  const bytes = await readFile(join(root, reference.path))
  assert.ok(bytes.length <= 128 * 1024, `实际文件 ${bytes.length} 字节超限`)
  const evidence = await loadRejectedCandidateEvidence(root, reference)
  assert.ok(evidence.cases.length > 0)
  assert.ok(evidence.omittedCases > 0)
  assert.ok(evidence.cases.some((item) => item.instanceId === ids.at(-1)), '容量不足时应优先保留实际运行失败的病例')
})
