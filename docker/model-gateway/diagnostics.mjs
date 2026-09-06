import { randomBytes, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const MAXIMUM_REQUESTS = 256
const MAXIMUM_LINE_BYTES = 4 * 1024 * 1024

function contentBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + contentBytes(entry?.text), 0)
  return 0
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/u.test(value) ? value : null
}

export function createTrialDiagnostics({ emptyUsage, tokenMatches }) {
  const trials = new Map()
  function principal(header) {
    for (const trial of trials.values()) {
      if (!trial.closed && tokenMatches(header, trial.token)) return { role: 'solver', trial }
    }
    return null
  }
  function register(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)
        || Object.keys(context).some((key) => ![
          'trialId', 'candidateId', 'candidateDigest', 'partition', 'instanceId', 'seed',
        ].includes(key))
        || ['trialId', 'candidateId', 'candidateDigest', 'partition', 'instanceId'].some(
          (key) => typeof context[key] !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/u.test(context[key]),
        ) || !['feedback', 'selection', 'final'].includes(context.partition)
        || !Number.isSafeInteger(context.seed) || context.seed < 0) return null
    if (trials.has(context.trialId)) return null
    if (trials.size >= 4096) {
      for (const [id, trial] of trials) {
        if (trial.closed) { trials.delete(id); break }
      }
      if (trials.size >= 4096) return null
    }
    const trial = {
      context, token: randomBytes(32).toString('hex'), usage: emptyUsage(),
      requests: [], retryBudgets: new Map(), truncated: false, closed: false,
    }
    trials.set(context.trialId, trial)
    return { trialId: context.trialId, token: trial.token }
  }
  function snapshot(trialId, close = false) {
    const trial = trials.get(trialId)
    if (!trial) return null
    if (close) {
      if (trial.usage.activeRequests !== 0) return null
      trial.closed = true
    }
    return {
      context: trial.context,
      complete: trial.usage.activeRequests === 0 && !trial.truncated,
      requests: trial.requests,
      usage: trial.usage,
    }
  }
  function request(trial) {
    if (!trial) return null
    const record = {
      requestId: randomUUID(), upstreamRequestId: null,
      origin: 'upstream', httpStatus: null, errorCode: null,
      attempts: 0, statuses: [], requestedTools: false,
      contentBytes: 0, responseBytes: 0, sawReasoning: false, sawToolCalls: false,
      hasFinalContent: false,
      sawRefusal: false, finishReason: null, done: false,
      responseComplete: false, transportError: false, streamError: false,
      malformedEvents: 0,
    }
    if (trial.requests.length >= MAXIMUM_REQUESTS) {
      trial.truncated = true
      trial.requests.shift()
    }
    trial.requests.push(record)
    return record
  }
  return { principal, register, snapshot, request }
}

// 与原始流旁路关联，仅计算脱敏元信息；从不缓存或记录 reasoning 正文。
export function responseObserver(record, { secretValues = [] } = {}) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let overflow = false
  function inspect(line) {
    if (!line.startsWith('data:')) return
    const raw = line.slice(5).trim()
    if (raw === '[DONE]') { record.done = true; return }
    if (!raw) return
    let value
    try { value = JSON.parse(raw) } catch { record.malformedEvents += 1; return }
    if (value?.error) record.streamError = true
    for (const choice of Array.isArray(value?.choices) ? value.choices : []) {
      if (!choice || typeof choice !== 'object') continue
      const output = choice.delta ?? choice.message ?? {}
      record.contentBytes += contentBytes(output.content)
      record.hasFinalContent ||= typeof output.content === 'string'
        ? output.content.trim().length > 0
        : Array.isArray(output.content) && output.content.some((entry) => typeof entry?.text === 'string' && entry.text.trim())
      record.sawReasoning ||= contentBytes(output.reasoning_content) > 0
      record.sawToolCalls ||= Array.isArray(output.tool_calls) && output.tool_calls.length > 0
      record.sawRefusal ||= contentBytes(output.refusal) > 0
      if (['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice.finish_reason)) {
        record.finishReason = choice.finish_reason
      }
    }
  }
  return {
    headers(status, headers) {
      record.httpStatus = status
      const id = safeRequestId(headers['x-request-id'] ?? headers['request-id']
        ?? headers['x-deepseek-request-id'])
      record.upstreamRequestId = secretValues.some((value) => typeof value === 'string'
        && value.length >= 4 && id?.includes(value)) ? null : id
    },
    chunk(chunk) {
      record.responseBytes += chunk.length
      buffer += decoder.write(chunk)
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        if (!overflow) inspect(buffer.slice(0, newline))
        overflow = false
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (buffer.length > MAXIMUM_LINE_BYTES) {
        buffer = ''
        overflow = true
        record.malformedEvents += 1
      }
    },
    end() {
      buffer += decoder.end()
      if (buffer && !overflow) inspect(buffer)
      buffer = ''
      record.responseComplete = true
    },
    error() { record.transportError = true },
  }
}
