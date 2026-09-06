// 明确标记的离线 fixture：真实网关/Driver/Environment，Docker 执行底座替换成本机 Python。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { loadExperimentBundle } from '../../src/adapters.mjs'
import { copyRegularTree } from '../../src/candidate.mjs'
import { createMsaMinimalCoworkSolverDriver } from '../../src/runtimes/msa-minimal-cowork.mjs'
import { OmegaUseOfficeValEnvironment } from '../../src/environments/omegause-officeval.mjs'
import { runProcess } from '../../src/process.mjs'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const hash = (value) => createHash('sha256').update(value).digest('hex')
const python = process.env.RSI_TEST_PYTHON ?? 'python3'

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return server.address().port
}

export async function startFixtureGateway(t, { modes = new Map() } = {}) {
  const observed = []
  const upstream = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks))
      const requested = payload.messages[0].content.match(/CASE=(\w+)/u)?.[1] ?? 'valid'
      const mode = modes.get(requested) ?? requested
      observed.push({ mode, requestedTools: !!payload.tools })
      if (/^http[0-9]+$/u.test(mode)) {
        response.writeHead(Number(mode.slice(4)), { 'content-type': 'application/json' })
        response.end('{"error":"fixture"}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `fixture-${observed.length}` })
      const delta = mode === 'reasoning' ? { reasoning_content: 'PRIVATE_REASONING_MUST_NOT_LEAK' }
        : mode === 'tools' ? { tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] }
          : { content: 'valid final content but not JSON' }
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      if (mode === 'interrupt') {
        setTimeout(() => response.destroy(), 5)
        return
      }
      response.end(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: mode === 'tools' ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      })}\n\ndata: [DONE]\n\n`)
    })
  })
  const upstreamPort = await listen(upstream)
  const probe = http.createServer()
  const port = await listen(probe)
  await new Promise((resolveClose) => probe.close(resolveClose))
  const control = 'c'.repeat(64)
  const role = 's'.repeat(64)
  const url = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [join(repositoryRoot, 'docker/model-gateway/server.mjs')], {
    env: {
      ...process.env, GATEWAY_PORT: String(port), GATEWAY_TOKEN: 'a'.repeat(64),
      GATEWAY_CONTROL_TOKEN: control, GATEWAY_SOLVER_TOKEN: role, GATEWAY_UPDATER_TOKEN: 'u'.repeat(64),
      UPSTREAM_API_KEY_ENV: 'FIXTURE_PROVIDER_KEY', FIXTURE_PROVIDER_KEY: 'fixture-provider-key',
      UPSTREAM_BASE_URL_ENV: 'FIXTURE_PROVIDER_URL', FIXTURE_PROVIDER_URL: `http://127.0.0.1:${upstreamPort}`,
      GATEWAY_MAX_UPSTREAM_RETRIES: '0', GATEWAY_MAX_REQUESTS: '1000', GATEWAY_MAX_CONCURRENT_REQUESTS: '16',
    }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  t.after(async () => {
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit))
    upstream.closeAllConnections()
    await new Promise((resolveClose) => upstream.close(resolveClose))
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(stderr)
    try { if ((await fetch(`${url}/healthz`)).ok) break } catch { /* 等待受控 fixture 启动。 */ }
    await delay(10)
  }
  const controlCall = async (path, body) => {
    const response = await fetch(`${url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${control}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`fixture control HTTP ${response.status}`)
    return await response.json()
  }
  const access = (token) => ({
    network: 'fixture-solver-net',
    environment: { RSI_PROVIDER_BASE_URL: url },
    secretEnvironment: { RSI_PROVIDER_API_KEY: token },
  })
  return {
    observed, url, controlCall,
    async access(_role, policy) {
      await controlCall('/rsi/configure-role', { role: 'solver', ...policy })
      return access(role)
    },
    async beginTrial(context, policy) {
      await this.access('solver', policy)
      const result = await controlCall('/rsi/trials', context)
      return access(result.token)
    },
    async endTrial(trialId) { return await controlCall('/rsi/trials', { trialId, close: true }) },
    async usage() { return await controlCall('/rsi/usage?role=solver') },
    async stop() { return [] },
  }
}

export const failingRun = `import argparse, json, os
from pathlib import Path
from model import query
p = argparse.ArgumentParser()
p.add_argument('--task'); p.add_argument('--answer'); p.add_argument('--trace'); p.add_argument('--profile')
a = p.parse_args()
text = query(os.environ['RSI_MODEL_GATEWAY_BASE_URL'], os.environ['RSI_MODEL_GATEWAY_DUMMY_KEY'], os.environ['RSI_MODEL_GATEWAY_MODEL'], [{'role':'user','content':a.task}], 128)
Path('partial.xlsx').write_text('fixture partial artifact')
Path(a.trace).write_text(json.dumps({'type':'model','content':text}) + '\\n')
answer = json.loads(text)
Path(a.answer).write_text(str(answer))
`

export async function runtimeFixture(t, { cases = ['valid'], modes = new Map() } = {}) {
  const outputRoot = join(repositoryRoot, '.rsi', 'solver-failure-fixtures')
  await mkdir(outputRoot, { recursive: true })
  const root = await mkdtemp(join(outputRoot, 'fixture-'))
  const bundle = await loadExperimentBundle(join(repositoryRoot, 'experiments/cowork-msa-main16-codex-single-in-sample.json'), repositoryRoot)
  const candidate = join(root, 'fixture-candidate')
  await copyRegularTree(join(repositoryRoot, 'targets/msa-minimal/cowork-v1'), candidate)
  await copyFile(join(repositoryRoot, 'sources/msa-minimal-harness/tools.py'), join(candidate, 'tools.py'))
  await writeFile(join(candidate, 'run.py'), failingRun)
  const assets = join(root, 'fixture-assets')
  await mkdir(assets)
  const input = join(root, 'fixture-input.txt')
  await writeFile(input, 'fixture input')
  const instanceIds = cases.map((_, index) => `officeval_${String(index + 1).padStart(3, '0')}`)
  const benchmark = { ...bundle.benchmark, expectedTotal: instanceIds.length,
    partitions: {
      feedback: { ...bundle.benchmark.partitions.feedback, instanceIds },
      selection: { ...bundle.benchmark.partitions.selection, instanceIds: [] },
      final: { ...bundle.benchmark.partitions.final, instanceIds: [] },
    },
    allInstanceIds: new Set(instanceIds), partitionByInstance: new Map(instanceIds.map((id) => [id, 'feedback'])),
  }
  const gateway = await startFixtureGateway(t, { modes })
  const docker = {
    async run(options) {
      const mapping = new Map(options.mounts.map((mount) => [mount.target, mount.source]))
      const args = options.command.slice(1).map((arg) => {
        for (const [target, source] of mapping) if (arg.startsWith(`${target}/`)) return join(source, arg.slice(target.length + 1))
        return arg
      })
      return await runProcess(python, args, {
        cwd: mapping.get(options.workdir), timeoutMs: 10_000,
        env: { ...process.env, ...options.environment, ...options.secretEnvironment },
        secretValues: Object.values(options.secretEnvironment),
      })
    },
  }
  const createDriver = (modelGateway = gateway) => createMsaMinimalCoworkSolverDriver({
    target: bundle.target, provider: bundle.provider, docker, repositoryRoot,
    sourceRevision: bundle.target.source.revision, sourcePath: bundle.target.source.path, modelGateway,
  })
  const driver = createDriver()
  let verifierCalls = 0
  const environmentFactory = (options) => {
    const environment = new OmegaUseOfficeValEnvironment({
      ...options, benchmark, solverDriver: options.solverDriver ?? driver, docker,
      environment: { ...bundle.environment, task: { ...bundle.environment.task, maximumConcurrentTrials: 2 } },
    })
    environment.preflight = async () => {
      environment.manifest = {}; environment.sourceRevision = 'b'.repeat(64)
      return { sourceRevision: environment.sourceRevision }
    }
    environment.ensureRuntime = async () => {
      environment.runtimeRevision = 'd'.repeat(64)
      return { solverImage: 'fixture-local-python', baseImage: 'fixture-verifier' }
    }
    environment.taskLayout = async (instanceId) => ({
      instanceId, task: { instruction: `CASE=${cases[instanceIds.indexOf(instanceId)]} fixture deliverable` },
      environmentAssets: assets,
      inputs: [{ source: input, name: 'input.txt', record: { bytes: 13, sha256: hash('fixture input') } }],
    })
    environment.runVerifier = async ({ submission }) => {
      verifierCalls += 1
      const partial = await readFile(join(submission, 'partial.xlsx'), 'utf8').catch(() => '')
      return { status: 'ok', dim1_pass: Boolean(partial), dim1_reason: 'fixture rubric', dim2_items: [], total_score: partial ? 5 : 0, max_score: 10 }
    }
    return environment
  }
  return { root, bundle, benchmark, candidate, driver, createDriver, gateway, docker, environmentFactory,
    verifierCalls: () => verifierCalls, modes }
}
