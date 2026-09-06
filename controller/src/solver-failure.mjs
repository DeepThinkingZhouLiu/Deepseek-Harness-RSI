// 分类只消费 Controller/网关观测；Candidate 自报正文不参与归因。
export const SOLVER_FAILURE_PROTOCOL = 'harness-rsi/solver-failure-v1'
export const SOLVER_FAILURE_CATEGORIES = Object.freeze([
  'candidate', 'provider', 'trusted-runtime', 'unknown',
])

export function sanitizeFailureText(value, secrets = [], maximumBytes = 4096) {
  let text = String(value ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.replaceAll(secret, '[REDACTED]')
  }
  text = text.replace(/sk-[A-Za-z0-9_-]{12,}/gu, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
  return Buffer.from(text).subarray(0, maximumBytes).toString('utf8').replace(/\ufffd$/u, '')
}

export class SolverFailure extends Error {
  constructor(failure, { modelUsage = null } = {}) {
    super(`Solver ${failure.category}: ${failure.code}`)
    this.name = 'SolverFailure'
    this.failure = failure
    this.modelUsage = modelUsage
    this.details = [`trial=${failure.context?.trialId ?? 'unknown'}`]
  }
}

function provenFinalResponse(request) {
  return request?.httpStatus === 200 && request.responseComplete && request.done
    && request.finishReason === 'stop' && request.contentBytes > 0
    && request.hasFinalContent !== false && !request.streamError && !request.transportError
    && !(request.malformedEvents > 0) && !request.sawRefusal
    && !(request.sawToolCalls && !request.requestedTools)
}

export function classifySolverFailure({ context = {}, process: processEvidence = null, diagnostics = null }) {
  const requests = diagnostics?.requests ?? []
  let category = 'unknown'
  let code = 'insufficient-trusted-evidence'
  // 非 Candidate 发出的 HTTP/认证故障优先于进程退出，不能被伪造的 Python Trace 覆盖。
  const last = requests.at(-1)
  if (diagnostics?.complete === true && last?.origin === 'gateway-request'
      && ['invalid-json-request', 'invalid-messages'].includes(last.errorCode)
      && requests.slice(0, -1).every(provenFinalResponse)) {
    category = 'candidate'
    code = 'invalid-model-request'
  } else if (last && (last.origin === 'gateway-control'
      || [401, 403].includes(last.httpStatus))) {
    category = 'trusted-runtime'
    code = 'gateway-or-provider-permission'
  } else if (last && (last.transportError || [429, 500, 502, 503, 504].includes(last.httpStatus))) {
    category = 'provider'
    code = last.transportError ? 'upstream-stream-interrupted' : 'upstream-unavailable'
  } else if (last && (last.httpStatus !== 200 || !last.responseComplete
      || last.streamError || !last.done || !last.finishReason || last.malformedEvents > 0)) {
    code = 'upstream-contract-unproven'
  } else if (last && (last.contentBytes === 0 || last.hasFinalContent === false || last.finishReason !== 'stop'
      || last.sawRefusal || (last.sawToolCalls && !last.requestedTools))) {
    code = last.sawToolCalls && !last.requestedTools
      ? 'unrequested-native-tool-calls'
      : (last.sawReasoning && last.contentBytes === 0 ? 'reasoning-only-response' : 'no-valid-final-response')
  } else if (requests.some((request) => !provenFinalResponse(request))) {
    // 同题并发或先失败后成功时，最后一个响应不能证明哪个请求导致进程退出。
    code = 'mixed-request-outcomes'
  } else if (processEvidence?.timedOut || processEvidence?.signal
      || [125, 126, 127, 137].includes(processEvidence?.exitCode)) {
    category = 'trusted-runtime'
    code = 'container-or-resource-failure'
  } else if (diagnostics?.complete === true
      && processEvidence?.source === 'trusted-process'
      && Number.isInteger(processEvidence.exitCode)
      && processEvidence.exitCode >= 0
      && (requests.length > 0 || (processEvidence.exitCode === 0 && processEvidence.outputContractFailed))
      && (processEvidence.exitCode !== 0 || processEvidence.outputContractFailed)) {
    category = 'candidate'
    code = processEvidence.outputContractFailed ? 'solver-output-contract' : 'candidate-process-exit'
  }
  return {
    protocol: SOLVER_FAILURE_PROTOCOL,
    category,
    code,
    terminal: category === 'candidate',
    context,
    process: processEvidence,
    diagnostics,
  }
}

export function validateSolverFailures(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 128) throw new Error('solver_failures 必须是有界数组')
  for (const failure of value) {
    if (failure?.protocol !== SOLVER_FAILURE_PROTOCOL
        || !SOLVER_FAILURE_CATEGORIES.includes(failure.category)
        || typeof failure.code !== 'string' || failure.code.length > 128
        || failure.terminal !== (failure.category === 'candidate')) {
      throw new Error('solver_failures 包含无效的结构化分类')
    }
    if (failure.diagnostics !== undefined && failure.diagnostics !== null
        && (typeof failure.diagnostics !== 'object' || Array.isArray(failure.diagnostics)
          || (failure.diagnostics.requests != null && !Array.isArray(failure.diagnostics.requests)))) {
      throw new Error('solver_failures diagnostics/requests 格式无效')
    }
  }
  return value.map((failure) => ({ ...failure,
    diagnostics: failure.diagnostics ? { ...failure.diagnostics, requests: failure.diagnostics.requests ?? [] } : null,
  }))
}

export function solverProcessEvidence(result, { outputContractFailed = false } = {}) {
  if (!result) return null
  // 仅保留文件/行号和异常类型；不保留 stderr 中可能混有的模型推理或密钥正文。
  const stderr = String(result.stderr ?? '')
  return {
    source: 'trusted-process',
    exitCode: result.exitCode ?? 0,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    outputTruncated: result.outputTruncated === true,
    outputContractFailed,
    frames: [...stderr.matchAll(/File "(\/candidate\/[A-Za-z0-9_./-]+\.py)", line (\d+)/gu)]
      .slice(-16).map((match) => ({ path: match[1], line: Number(match[2]) })),
    exceptionTypes: [...stderr.matchAll(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z][A-Za-z0-9]*(?:Error|Exception)):/gmu)]
      .slice(-4).map((match) => match[1]),
  }
}
