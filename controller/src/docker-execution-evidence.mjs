import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from './process.mjs'

// CID 文件只在宿主私有临时目录中；不能按名称误读或删除另一场实验的容器。
export async function createDockerExecutionEvidence(binary) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-container-evidence-'))
  const cidFile = join(directory, 'container-id')
  let containerId = null
  return {
    args: ['--cidfile', cidFile],
    async capture() {
      try {
        const id = (await readFile(cidFile, 'utf8')).trim()
        if (!/^[a-f0-9]{64}$/u.test(id)) return null
        containerId = id
        const result = await runProcess(binary, ['inspect', '--format', '{{json .State}}', id], { timeoutMs: 30_000 })
        const state = JSON.parse(result.stdout)
        if (typeof state?.Error !== 'string' || typeof state.OOMKilled !== 'boolean'
            || !Number.isInteger(state.ExitCode) || typeof state.StartedAt !== 'string'
            || typeof state.FinishedAt !== 'string') return null
        const isTimestamp = (value) => Number.isFinite(Date.parse(value)) && Date.parse(value) > 0
        return {
          source: 'docker-state',
          started: isTimestamp(state.StartedAt),
          finished: ['exited', 'dead'].includes(state.Status) && isTimestamp(state.FinishedAt),
          launchError: state.Error.length > 0,
          oomKilled: state.OOMKilled,
          exitCode: state.ExitCode,
        }
      } catch {
        // 缺少可信状态时不猜测，不把 Docker 故障伪装成 Candidate 错误。
        return null
      }
    },
    async cleanup() {
      try {
        if (containerId) await runProcess(binary, ['rm', '--force', containerId], {
          timeoutMs: 60_000, allowExitCodes: [0, 1],
        })
      } catch {
        // 保留原始执行结果，清理故障不能覆盖其根因。
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}
