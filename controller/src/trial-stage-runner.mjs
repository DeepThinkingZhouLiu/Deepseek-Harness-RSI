import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { ProtocolError } from './protocol.mjs'

const DEFAULT_ATTEMPTS = 3
const MAXIMUM_ATTEMPTS = 5
const MAXIMUM_DIAGNOSTIC_CHARS = 32768

function safeText(value) {
  let text = String(value ?? '')
  // 包括两种 Provider 的运行时凭据；不保存环境变量名或原值。
  for (const [name, secret] of Object.entries(process.env)) {
    if (/key|token|secret|password/iu.test(name) && secret.length >= 8) {
      text = text.replaceAll(secret, '[REDACTED]')
    }
  }
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/gu, '[REDACTED]').slice(-MAXIMUM_DIAGNOSTIC_CHARS)
}

export function retryableTrialError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable
  const text = [error?.message, ...(error?.details ?? [])].join('\n')
  if (/HTTP\s+403\b[\s\S]*pre_consume_token_quota_failed/iu.test(text)) return true
  // 配置、协议、权限、语法和安全校验失败无法靠重复执行恢复。
  if (/HTTP\s+(?:400|401|403|404|413|422)\b|ModuleNotFoundError|SyntaxError|PermissionError/iu.test(text)) return false
  return error?.processResult?.timedOut === true
    || /model gateway transient response failure|model gateway returned retryable HTTP|HTTP\s+(?:429|500|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|connection reset|timed out/iu.test(text)
    || /AgentBay env upload failed: Upload exception|SSL:\s*UNEXPECTED_EOF_WHILE_READING/iu.test(text)
    || /no final content.*finish_reason=(?:stop|missing|tool_calls|length)/su.test(text)
}

export async function writeTrialFailure({ root, file, context, stage, attempt, error, willRetry }) {
  const directory = join(root, 'diagnostics')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const result = error?.processResult
  const record = {
    kind: 'TrialStageFailure',
    recordedAt: new Date().toISOString(),
    ...context,
    stage,
    attempt,
    retryable: retryableTrialError(error),
    willRetry,
    error: {
      name: safeText(error?.name),
      message: safeText(error?.message ?? error),
      details: (error?.details ?? []).slice(0, 16).map(safeText),
      ...(result ? { process: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTruncated: result.outputTruncated,
        stdout: safeText(result.stdout),
        stderr: safeText(result.stderr),
      } } : {}),
    },
  }
  const path = join(directory, file)
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return path
}

export function trialProgress(context, event, fields = {}) {
  // Final 题目和错误细节仅进入受信运行目录，不能出现在公开终端事件中。
  if (context.partition === 'final') return
  process.stderr.write(`[trial] ${JSON.stringify({ event, ...context, ...fields })}\n`)
}

export async function runTrialStage({
  trialRoot, context, stage, operation, prepareRetry = async () => {},
  maximumAttempts = DEFAULT_ATTEMPTS, retryDelayMs = 1000,
}) {
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > MAXIMUM_ATTEMPTS
      || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new ProtocolError('Trial 重试参数无效')
  }
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (cause) {
      const willRetry = attempt < maximumAttempts && retryableTrialError(cause)
      const diagnostic = await writeTrialFailure({
        root: trialRoot, file: `${stage}-${attempt}.json`, context,
        stage, attempt, error: cause, willRetry,
      })
      trialProgress(context, willRetry ? 'retry' : 'failed', { stage, attempt, maximumAttempts, diagnostic })
      if (!willRetry) {
        const error = new ProtocolError(`Trial ${stage} 失败`, [
          cause?.message ?? String(cause), ...(cause?.details ?? []), `diagnostic=${diagnostic}`,
        ])
        error.stage = stage
        error.retryable = retryableTrialError(cause)
        throw error
      }
      await delay(Math.min(retryDelayMs * 2 ** (attempt - 1), 10000))
      await prepareRetry(attempt)
    }
  }
  throw new ProtocolError('Trial 重试次数无效')
}
