import assert from 'node:assert/strict'
import test from 'node:test'

import { adaptCoworkWorkspaceInstruction } from '../src/environments/cowork-bench.mjs'

test('Cowork-Bench 将 Harbor 输入输出路径映射到持久化 Solver Workspace', () => {
  const instruction = [
    '读取 `/app/data/input_files/source.docx`。',
    '写入 `/app/output/result.docx`。',
  ].join('\n')

  assert.equal(
    adaptCoworkWorkspaceInstruction(instruction, '/workspace'),
    '读取 `/workspace/source.docx`。\n写入 `/workspace/result.docx`。',
  )
})
