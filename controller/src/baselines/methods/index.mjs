import { ProtocolError } from '../../protocol.mjs'
import { aceMethod } from './ace.mjs'
import { evoBenchMethod } from './evo-bench.mjs'
import { evoBenchPaperMethod } from './evo-bench-paper.mjs'

const methods = new Map([
  [aceMethod.id, aceMethod],
  [evoBenchMethod.id, evoBenchMethod],
  [evoBenchPaperMethod.id, evoBenchPaperMethod],
])

export const baselineMethodIds = Object.freeze([...methods.keys()])

export function getBaselineMethod(id) {
  const method = methods.get(id)
  if (!method) throw new ProtocolError(`Unknown baseline method: ${id}`)
  return method
}
