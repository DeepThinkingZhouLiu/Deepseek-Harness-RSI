import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
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
    this.code = 'RSI_RESUME_INCOMPATIBLE'
    this.retryable = false
    this.exitCode = 3
  }
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

export async function captureExecutionIdentity(repositoryRoot, { dependencyRoot, nodeVersion = process.version } = {}) {
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
    dependencies: { yaml: dependencies }, nodeVersion,
    solverFailureProtocol: SOLVER_FAILURE_PROTOCOL,
  }
  return { version: EXECUTION_IDENTITY_VERSION, digest: hash(JSON.stringify(spec)), spec }
}

export function assertExecutionIdentity(stored, current) {
  if (!stored || stored.version !== EXECUTION_IDENTITY_VERSION) {
    throw new ResumeCompatibilityError('旧 Run 缺少可证明依赖和错误处理协议一致的执行内容摘要，拒绝自动恢复', [
      '旧版本=Git-HEAD-only；新版本=execution-identity-v2',
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
