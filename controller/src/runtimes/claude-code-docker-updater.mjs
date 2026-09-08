import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { ProtocolError } from '../protocol.mjs'
import { validateModelGatewayEnvironment } from '../cowork-model-gateway.mjs'
import { UPDATER_SANDBOX_PATHS as paths } from '../updater-runner.mjs'
import { stageUpdaterContext } from './dsh.mjs'
import { cliUpdaterTask, createCliUsageLedger, initializeCliCandidateGit,
  readCliMutationReport, recordCliUsageAudit } from './cli-updater-common.mjs'

export function createClaudeCodeDockerUpdaterDriver({ updater, provider, repositoryRoot, docker, modelGateway }) {
  const usage = createCliUsageLedger()
  let runtimePromise
  const ensureRuntime = () => runtimePromise ??= (async () => {
    const image = updater.runtime.image
    let built = false
    if (!await docker.imageExists(image)) {
      await docker.build({ context: repositoryRoot,
        dockerfile: resolve(repositoryRoot, updater.runtime.dockerfile), tag: image,
        buildArgs: { CLAUDE_VERSION: updater.runtime.version },
      })
      built = true
    }
    return { image, version: updater.runtime.version, built }
  })()
  return {
    id: updater.protocol,
    ensureRuntime,
    async stageContext(options) {
      return await stageUpdaterContext({ ...options, promptVariables: {
        ...options.promptVariables,
        'output.mutationReportPath': `${paths.output}/${basename(options.promptVariables['output.mutationReportPath'])}`,
      } })
    },
    async run(options) {
      await ensureRuntime()
      const { apiKey, baseUrl } = validateModelGatewayEnvironment({
        upstreamApiKeyEnvironment: provider.credentials.apiKeyEnvironment,
        upstreamBaseUrlEnvironment: provider.credentials.baseUrlEnvironment,
      })
      await modelGateway.rotateRoleToken('solver')
      const root = dirname(options.candidateWorkspace)
      const gitRoot = join(root, 'updater-claude-docker.git')
      const controlOutput = join(root, 'updater-control-output')
      await mkdir(options.outputDirectory, { recursive: true })
      await mkdir(controlOutput, { recursive: true })
      await initializeCliCandidateGit(options.candidateWorkspace, gitRoot, 'Claude Docker')
      let result
      let operationError
      try {
        result = await docker.run({
          image: updater.runtime.image,
          name: options.name ?? `claude-updater-${basename(root)}`,
          command: [cliUpdaterTask({ targetId: options.targetId,
            mutationLevel: options.mutationLevel, reportName: options.reportName })],
          runAsCurrentUser: false,
          capabilities: ['CHOWN', 'FOWNER', 'SETUID', 'SETGID'],
          workdir: paths.candidate,
          mounts: [
            { source: options.candidateWorkspace, target: paths.candidate, readOnly: false },
            { source: gitRoot, target: paths.git, readOnly: false },
            { source: options.contextDirectory, target: paths.feedback, readOnly: true },
            { source: options.upstreamSource, target: paths.upstream, readOnly: true },
            { source: options.outputDirectory, target: paths.output, readOnly: false },
            { source: controlOutput, target: '/control-output', readOnly: false },
          ],
          environment: {
            UPDATER_PROVIDER_URL: baseUrl,
            UPDATER_MODEL: options.model.model,
            UPDATER_EFFORT: options.model.reasoningEffort ?? 'high',
            UPDATER_MAX_TOKENS: String(options.model.maxTokens),
            UPDATER_MAX_REQUESTS: String(updater.runtime.maximumModelRequests),
          },
          secretEnvironment: { UPDATER_PROVIDER_KEY: apiKey },
          timeoutMs: options.timeoutMs,
        })
      } catch (error) { operationError = error }
      try {
        const records = JSON.parse(await readFile(join(controlOutput, 'audit.json'), 'utf8'))
        records.forEach(record => recordCliUsageAudit(usage, record))
      } catch (error) {
        usage.complete = false
        if (!operationError) operationError = error
      }
      if (operationError) throw operationError
      if (result.exitCode !== 0) throw new ProtocolError('Claude Docker Updater failed')
      const report = await readCliMutationReport(options.outputDirectory, options.reportName, [apiKey], 'Claude Docker')
      return { ...result, report }
    },
    usage() { return { ...usage } },
  }
}
