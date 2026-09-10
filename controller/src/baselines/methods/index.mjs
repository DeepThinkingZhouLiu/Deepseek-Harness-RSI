import { ProtocolError } from '../../protocol.mjs'
import { aceMethod } from './ace.mjs'
import { evoBenchMethod } from './evo-bench.mjs'

const methods = new Map([
  [aceMethod.id, aceMethod],
  [evoBenchMethod.id, evoBenchMethod],
])

export const baselineMethodIds = Object.freeze([...methods.keys()])

export function getBaselineMethod(id) {
  const method = methods.get(id)
  if (!method) throw new ProtocolError(`Unknown baseline method: ${id}`)
  return method
}
