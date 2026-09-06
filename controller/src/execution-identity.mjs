import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProtocolError } from './protocol.mjs'
import { runProcess } from './process.mjs'
import { SOLVER_FAILURE_PROTOCOL } from './solver-failure.mjs'

export const EXECUTION_IDENTITY_VERSION = 'harness-rsi/execution-identity-v2'
export const EXECUTION_PATHS = Object.freeze([
  'controller/src', 'docker', 'strategies', 'scripts', 'package.json', 'package-lock.json',
])
const hash = (value) => createHash('sha256').update(value).digest('hex')

export class ResumeCompatibilityError extends ProtocolError {
  constructor(message, details = []) {
    super(message, details)
    this.name = 'ResumeCompatibilityError'
    this.code = 'RSI_RESUME_INCOMPATIBLE'
    this.retryable = false
    this.exitCode = 3
  }
}

export async function binaryContentIdentity(path) {
  const resolved = await realpath(path)
  const info = await lstat(resolved)
  if (!info.isFile()) throw new ResumeCompatibilityError('Runtime Binary 不是普通文件', [path])
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(resolved)) digest.update(chunk)
  return { sha256: digest.digest('hex'), bytes: info.size, executable: !!(info.mode & 0o111) }
}

export async function captureRuntimeInputs(bundle) {
  const hostBinaries = {}
  for (const key of ['nodeBinary', 'bwrapPath', 'setprivPath']) {
    if (bundle.updater.runtime?.[key]) hostBinaries[key] = await binaryContentIdentity(bundle.updater.runtime[key])
  }
  // 只摘要实际 Endpoint；不读取 API Key，Endpoint 中即使有敏感信息也不落正文。
  const providerEndpoints = {}
  for (const [role, provider] of Object.entries(bundle.providers ?? { solver: bundle.provider, updater: bundle.provider })) {
    const variable = provider?.credentials?.baseUrlEnvironment
    if (!variable) continue
    const value = process.env[variable]
    providerEndpoints[role] = { environment: variable, sha256: value === undefined ? null : hash(value) }
  }
  return { hostBinaries, providerEndpoints }
}

export function evolutionFingerprint({ executionIdentity, controllerRevision, configDigest }) {
  // 字段按字典序排列，与旧的 canonicalJsonDigest 保持一致。
  return hash(JSON.stringify(executionIdentity
    ? { configDigest, executionDigest: executionIdentity.digest }
    : { configDigest, controllerRevision }))
}

async function regularTree(root, prefix = '') {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = join(root, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new ResumeCompatibilityError('执行依赖不能包含符号链接', [path])
    if (info.isDirectory()) files.push(...await regularTree(absolute, path))
    else if (info.isFile()) files.push({ path, mode: info.mode & 0o111 ? '100755' : '100644', sha256: hash(await readFile(absolute)) })
    else throw new ResumeCompatibilityError('执行依赖包含非常规文件', [path])
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

export async function captureExecutionIdentity(repositoryRoot, {
  dependencyRoot, nodeVersion = process.version, nodeBinary = process.execPath,
} = {}) {
  const files = []
  for (const path of EXECUTION_PATHS) {
    const absolute = resolve(repositoryRoot, path)
    const info = await lstat(absolute).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) continue
    if (info.isDirectory()) files.push(...await regularTree(absolute, path))
    else if (info.isFile() && !info.isSymbolicLink()) {
      files.push({ path, mode: info.mode & 0o111 ? '100755' : '100644', sha256: hash(await readFile(absolute)) })
    } else throw new ResumeCompatibilityError('执行内容路径不安全', [path])
  }
  // yaml 是 Controller 唯一生产依赖；固定已加载包的实际内容，不只检查版本字符串。
  const yamlRoot = dependencyRoot ?? resolve(dirname(fileURLToPath(import.meta.resolve('yaml'))), '..')
  const dependencies = await regularTree(yamlRoot)
  const spec = {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    dependencies: { yaml: dependencies }, nodeVersion, nodeBinary: await binaryContentIdentity(nodeBinary),
    solverFailureProtocol: SOLVER_FAILURE_PROTOCOL,
  }
  return { version: EXECUTION_IDENTITY_VERSION, digest: hash(JSON.stringify(spec)), spec }
}

export function assertExecutionIdentity(stored, current) {
  if (!stored || stored.version !== EXECUTION_IDENTITY_VERSION) {
    throw new ResumeCompatibilityError('旧 Run 缺少可证明依赖和错误处理协议一致的执行内容摘要，拒绝自动恢复', [
      `旧版本=${stored?.version ?? 'Git-HEAD-only'}；新版本=${EXECUTION_IDENTITY_VERSION}`,
      `新错误处理协议=${SOLVER_FAILURE_PROTOCOL}`,
      '不能通过改写旧 hash 迁移；需要原执行依赖/Runtime 内容证据。旧正式实验未被运行。',
    ])
  }
  if (stored.digest !== hash(JSON.stringify(stored.spec))) {
    throw new ResumeCompatibilityError('冻结执行摘要自身校验失败')
  }
  if (stored.digest !== current.digest) {
    const previous = new Map(stored.spec.files.map((entry) => [entry.path, entry]))
    const next = new Map(current.spec.files.map((entry) => [entry.path, entry]))
    const changed = [...new Set([...previous.keys(), ...next.keys()])]
      .filter((path) => JSON.stringify(previous.get(path)) !== JSON.stringify(next.get(path)))
    throw new ResumeCompatibilityError('执行内容、依赖或 Runtime 实际漂移，拒绝恢复', [
      ...changed.slice(0, 32),
      ...(JSON.stringify(stored.spec.dependencies) !== JSON.stringify(current.spec.dependencies) ? ['dependency:yaml'] : []),
      ...(stored.spec.nodeVersion !== current.spec.nodeVersion ? ['runtime:nodeVersion'] : []),
      ...(JSON.stringify(stored.spec.nodeBinary) !== JSON.stringify(current.spec.nodeBinary) ? ['runtime:nodeBinary'] : []),
    ])
  }
}

export async function inspectLegacyCodeCompatibility(repositoryRoot, revision) {
  if (!/^[0-9a-f]{40}$/u.test(revision ?? '')) throw new ResumeCompatibilityError('旧 Controller Revision 无效')
  const result = await runProcess('git', ['-C', repositoryRoot, 'diff', '--name-only', revision, '--', ...EXECUTION_PATHS])
  return { oldVersion: 'Git-HEAD-only', newVersion: EXECUTION_IDENTITY_VERSION,
    revision, changedExecutionPaths: result.stdout.trim().split('\n').filter(Boolean),
    dependencyEvidenceAvailable: false, migrationAllowed: false }
}
