import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { OmegaUseOfficeValEnvironment } from './omegause-officeval.mjs'
import { ProtocolError } from '../protocol.mjs'
import { copyRegularTree } from '../candidate.mjs'

const MANIFEST_API_VERSION = 'harness-rsi/cowork-bench-manifest-v1'
const MAXIMUM_MANIFEST_BYTES = 2 * 1024 * 1024

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readRegularJson(pathValue, label, maximumBytes = MAXIMUM_MANIFEST_BYTES) {
  const info = await lstat(pathValue).catch((error) => {
    throw new ProtocolError(`${label} 不存在：${pathValue}`, [error.message])
  })
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > maximumBytes) {
    throw new ProtocolError(`${label} 必须是大小合规的普通文件：${pathValue}`)
  }
  try {
    return JSON.parse(await readFile(pathValue, 'utf8'))
  } catch (error) {
    throw new ProtocolError(`${label} JSON 无效`, [error.message])
  }
}

async function currentGitRevision(root, label) {
  const { runProcess } = await import('../process.mjs')
  const result = await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
  const status = await runProcess(
    'git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], { timeoutMs: 30_000 },
  )
  if (status.stdout.trim()) throw new ProtocolError(`${label} 存在未提交文件`, [status.stdout.trim()])
  const revision = result.stdout.trim()
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new ProtocolError(`${label} Revision 无效`)
  return revision
}

function safeTaskPath(root, taskPath, label) {
  if (typeof taskPath !== 'string' || taskPath.startsWith('/') || taskPath.includes('..')) {
    throw new ProtocolError(`${label} 不是安全相对路径`)
  }
  const pathValue = resolve(root, taskPath)
  const rel = relative(root, pathValue)
  if (rel === '..' || rel.startsWith('../')) throw new ProtocolError(`${label} 逃逸任务根目录`)
  return pathValue
}

export function adaptCoworkWorkspaceInstruction(instruction, workspacePath) {
  return instruction
    .replaceAll('/app/data/input_files', workspacePath)
    .replaceAll('/app/input_files', workspacePath)
    .replaceAll('/app/output', workspacePath)
}

async function listInputFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const pathValue = join(directory, entry.name)
      if (entry.isDirectory()) await visit(pathValue)
      else if (entry.isFile()) files.push(pathValue)
      else throw new ProtocolError(`Cowork Task 输入包含非普通文件：${pathValue}`)
    }
  }
  await visit(root)
  return files
}

function normalizeJudgeResult(result, instanceId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProtocolError(`Cowork Judge 返回值不是对象：${instanceId}`)
  }
  const reward = result.reward
  if (typeof reward !== 'number' || !Number.isFinite(reward) || reward < 0 || reward > 1) {
    throw new ProtocolError(`Cowork Judge reward 必须位于 [0,1]：${instanceId}`)
  }
  const criteria = Array.isArray(result.criterion_results) ? result.criterion_results : []
  return {
    id: instanceId,
    file_name: '',
    status: 'ok',
    error: '',
    dim1_pass: true,
    dim1_reason: 'Cowork-Bench Judge',
    dim2_items: criteria,
    total_score: reward,
    max_score: 1,
  }
}

export class CoworkBenchEnvironment extends OmegaUseOfficeValEnvironment {
  constructor(options) {
    super(options)
    this.taskManifest = null
    this.taskRoots = new Map()
  }

  async preflight() {
    const datasetPath = process.env[this.environment.source.datasetRootEnvironment]
    const evaluatorPath = process.env[this.environment.source.evaluatorRootEnvironment]
    if (!datasetPath || !evaluatorPath) {
      throw new ProtocolError('缺少 Cowork-Bench 数据根目录环境变量')
    }
    const [datasetRoot, evaluatorRoot] = await Promise.all([
      realpath(resolve(datasetPath))
        .catch((error) => { throw new ProtocolError('Cowork-Bench Dataset Root 不可用', [error.message]) }),
      realpath(resolve(evaluatorPath))
        .catch((error) => { throw new ProtocolError('Cowork-Bench Evaluator Root 不可用', [error.message]) }),
    ])
    const evaluatorRevision = await currentGitRevision(evaluatorRoot, 'Cowork-Bench Evaluator')
    if (evaluatorRevision !== this.environment.source.evaluatorRevision) {
      throw new ProtocolError('Cowork-Bench Evaluator Revision 与 Adapter 不一致', [
        `expected=${this.environment.source.evaluatorRevision}`,
        `actual=${evaluatorRevision}`,
      ])
    }
    const manifestPath = resolve(this.repositoryRoot, this.environment.source.manifestPath)
    const manifestBytes = await readFile(manifestPath)
    if (sha256(manifestBytes) !== this.environment.source.manifestDigest) {
      throw new ProtocolError('Cowork-Bench Task Manifest 摘要不一致')
    }
    const manifest = await readRegularJson(manifestPath, 'Cowork-Bench Task Manifest')
    if (manifest.apiVersion !== MANIFEST_API_VERSION || manifest.repositoryRevision !== evaluatorRevision) {
      throw new ProtocolError('Cowork-Bench Task Manifest 身份不一致')
    }
    const selectedIds = new Set(this.benchmark.allInstanceIds)
    this.taskRoots = new Map()
    for (const entry of manifest.tasks ?? []) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.path !== 'string') continue
      if (selectedIds.has(entry.id)) this.taskRoots.set(entry.id, safeTaskPath(datasetRoot, entry.path, `Task ${entry.id}`))
    }
    const missing = [...selectedIds].filter((id) => !this.taskRoots.has(id))
    if (missing.length > 0) throw new ProtocolError('Cowork-Bench Manifest 缺少 Benchmark Task', missing)
    await this.docker.info()
    this.datasetRoot = datasetRoot
    this.evaluatorRoot = evaluatorRoot
    this.manifest = manifest
    this.sourceRevision = this.benchmark.source.revision
    return { sourceRoot: datasetRoot, sourceRevision: this.sourceRevision }
  }

  async taskLayout(instanceId) {
    if (!this.manifest) throw new ProtocolError('必须先执行 Cowork-Bench preflight')
    const taskRoot = this.taskRoots.get(instanceId)
    if (!taskRoot) throw new ProtocolError(`Cowork-Bench Task 不存在：${instanceId}`)
    const instructionPath = join(taskRoot, 'instruction.md')
    const inputRoot = join(taskRoot, 'data', 'input_files')
    const testsRoot = join(taskRoot, 'tests')
    const [instruction, inputs] = await Promise.all([
      readFile(instructionPath, 'utf8'),
      listInputFiles(inputRoot),
    ])
    if (!instruction.trim() || inputs.length === 0) throw new ProtocolError(`Cowork Task 资产不完整：${instanceId}`)
    const inputRecords = await Promise.all(inputs.map(async (source) => {
      const info = await lstat(source)
      const bytes = await readFile(source)
      return {
        source,
        name: relative(inputRoot, source).replaceAll('\\', '/'),
        record: { bytes: info.size, sha256: sha256(bytes) },
      }
    }))
    const judge = join(testsRoot, 'judge.py')
    const judgeInfo = await lstat(judge).catch(() => null)
    if (!judgeInfo?.isFile() || judgeInfo.isSymbolicLink()) throw new ProtocolError(`Cowork Task 缺少 tests/judge.py：${instanceId}`)
    const environmentAssets = resolve(this.repositoryRoot, this.environment.task.environmentAssets)
    const assetsInfo = await lstat(environmentAssets).catch(() => null)
    if (!assetsInfo?.isDirectory() || assetsInfo.isSymbolicLink()) {
      throw new ProtocolError(`Cowork Environment Assets 必须是普通目录：${environmentAssets}`)
    }
    return Object.freeze({
      instanceId,
      taskRoot,
      task: {
        id: instanceId,
        instruction: adaptCoworkWorkspaceInstruction(
          instruction.trim(),
          this.environment.task.workspacePath,
        ),
      },
      record: { verifier: { path: 'tests/judge.py' } },
      inputs: inputRecords,
      judge,
      environmentAssets,
    })
  }

  async runVerifier({ layout, submission, logs, verifierCode, name }) {
    await Promise.all([
      mkdir(logs, { recursive: false, mode: 0o700 }),
      mkdir(verifierCode, { recursive: false, mode: 0o700 }),
    ])
    const stagedTask = join(verifierCode, 'task')
    await mkdir(stagedTask, { recursive: false, mode: 0o700 })
    await Promise.all([
      copyRegularTree(join(layout.taskRoot, 'tests'), join(stagedTask, 'tests')),
      copyRegularTree(join(layout.taskRoot, 'data'), join(stagedTask, 'data')),
      copyFile(join(layout.taskRoot, 'rubric.json'), join(stagedTask, 'rubric.json')),
      copyFile(join(layout.taskRoot, 'task.toml'), join(stagedTask, 'task.toml')),
    ])
    const output = join(logs, 'result.json')
    const proxyEnvironment = Object.fromEntries([
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    ].map((key) => [key, '']))
    await this.docker.run({
      image: this.baseImage,
      name,
      entrypoint: '/usr/local/bin/python',
      command: [
        '/opt/harness-rsi/run-cowork-bench-verifier.py',
        '--judge', '/verifier/task/tests/judge.py',
        '--submission', '/submission',
        '--output', '/logs/result.json',
        '--expected-id', layout.instanceId,
      ],
      workdir: '/submission',
      mounts: [
        { source: submission, target: '/submission', readOnly: true },
        { source: verifierCode, target: '/verifier', readOnly: true },
        { source: logs, target: '/logs', readOnly: false },
      ],
      environment: {
        HOME: '/tmp/home', TMPDIR: '/tmp', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
        // 容器 UID 没有 passwd 条目时，LibreOffice 无法推导默认用户配置目录。
        UserInstallation: 'file:///tmp/libreoffice-profile',
        // 只允许受信 Judge 的只读目录解析同目录依赖，不把 Submission 加入搜索路径。
        PYTHONSAFEPATH: '1', PYTHONPATH: '/verifier/task/tests', ...proxyEnvironment,
      },
      inheritEnvironment: [],
      network: 'none',
      runAsCurrentUser: true,
      readOnlyRoot: true,
      capabilities: [],
      timeoutMs: this.environment.verifier.timeoutSeconds * 1000,
      resources: this.environment.verifier.resources,
    })
    const result = JSON.parse(await readFile(output, 'utf8'))
    return normalizeJudgeResult(result, layout.instanceId)
  }
}
