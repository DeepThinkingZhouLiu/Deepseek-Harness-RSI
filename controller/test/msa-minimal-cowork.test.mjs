import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  MSA_COWORK_CONTAINER_PATHS,
  createMsaMinimalCoworkSolverDriver,
  ensureMsaMinimalCoworkRuntime,
  runMsaMinimalCoworkSolver,
} from '../src/runtimes/msa-minimal-cowork.mjs'

const executeFile = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRevision = 'a'.repeat(40)
const provider = {
  id: 'fixture-provider',
  credentials: {
    baseUrlEnvironment: 'RSI_PROVIDER_BASE_URL',
    apiKeyEnvironment: 'RSI_PROVIDER_API_KEY',
  },
  models: [{ id: 'fixture-terra' }],
}
const model = {
  provider: provider.id,
  model: 'fixture-terra',
  maxTokens: 2048,
  reasoningEffort: 'high',
}
const modelAccess = {
  network: 'fixture-run-model-net',
  environment: {
    RSI_PROVIDER_BASE_URL: 'http://model-gateway:8080',
    NO_PROXY: 'model-gateway',
    no_proxy: 'model-gateway',
  },
  secretEnvironment: { RSI_PROVIDER_API_KEY: 'fixture-dummy-token-1234567890' },
}
const runtime = {
  dockerfile: 'docker/msa-minimal-runtime/Dockerfile',
  profile: 'cowork',
  pythonCommand: 'python3',
  answerFile: 'answer.txt',
  traceFile: 'agent.jsonl',
  maximumAnswerBytes: 1024 * 1024,
  maximumTraceBytes: 4 * 1024 * 1024,
  maximumSteps: 3,
}

async function trialFixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const candidateWorkspace = join(root, 'candidate')
  const taskWorkspace = join(root, 'workspace')
  const environmentAssets = join(root, 'environment-assets')
  const sessionRoot = join(root, 'solver-output')
  await Promise.all([
    mkdir(candidateWorkspace),
    mkdir(taskWorkspace),
    mkdir(environmentAssets),
  ])
  await writeFile(join(candidateWorkspace, 'run.py'), '# fixture\n')
  await writeFile(join(environmentAssets, 'SKILL.md'), '# fixture\n')
  return { root, candidateWorkspace, taskWorkspace, environmentAssets, sessionRoot }
}

test('MSA Bash Tool 将非 UTF-8 的 Office 原始字节安全替换，不让 Solver 崩溃', async () => {
  const toolRoot = resolve(repositoryRoot, 'sources/msa-minimal-harness')
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(toolRoot)})`,
    'from tools import run_bash',
    'print(run_bash(\'python3 -c "import sys;sys.stdout.buffer.write(bytes([255,111,107]))"\', \'/tmp\', 10, 1024))',
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.returncode, 0)
  assert.equal(result.output, '\ufffdok')
})

test('MSA Cowork Runtime 派生镜像绑定 Task Image、Source 与定义摘要', async () => {
  let buildOptions
  const docker = {
    async imageExists() { return false },
    async build(options) { buildOptions = options },
  }
  const result = await ensureMsaMinimalCoworkRuntime({
    docker,
    runtime,
    repositoryRoot,
    sourceRevision,
    sourcePath: 'sources/msa-minimal-harness',
    baseImage: 'office-task:fixture',
    baseImageIdentity: `sha256:${'b'.repeat(64)}`,
    tag: 'office-task:fixture-msa',
  })

  assert.equal(result.built, true)
  assert.equal(buildOptions.buildArgs.BASE_IMAGE, 'office-task:fixture')
  assert.equal(buildOptions.labels['org.opencontainers.image.revision'], sourceRevision)
  assert.equal(buildOptions.labels['io.harness-rsi.runtime'], 'msa-minimal-cowork-v1')
  assert.equal(buildOptions.labels['io.harness-rsi.base-image-identity'], `sha256:${'b'.repeat(64)}`)
  assert.match(buildOptions.labels['io.harness-rsi.runtime-definition-digest'], /^[0-9a-f]{64}$/u)
})

test('MSA Cowork Solver 只读挂 Candidate/Skill，只写任务与独立输出目录', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-run-')
  const task = 'Create result.xlsx.\n\nRequirements:\n- Preserve the source data.\n- Add a pivot table.'
  let invocation
  const docker = {
    async run(options) {
      invocation = options
      await writeFile(join(fixture.sessionRoot, 'answer.txt'), `done ${modelAccess.secretEnvironment.RSI_PROVIDER_API_KEY}\n`)
      await writeFile(join(fixture.sessionRoot, 'agent.jsonl'), `${JSON.stringify({
        type: 'model',
        content: modelAccess.secretEnvironment.RSI_PROVIDER_API_KEY,
      })}\n`)
      return { stderr: '', durationMs: 12, outputTruncated: false }
    },
  }

  const result = await runMsaMinimalCoworkSolver({
    docker,
    runtime,
    image: 'office-task:fixture-msa',
    model,
    provider,
    ...fixture,
    modelAccess,
    task,
    name: 'msa-cowork-fixture',
    timeoutMs: 1000,
    containerWorkspace: '/root',
  })

  assert.equal(invocation.network, modelAccess.network)
  assert.equal(invocation.readOnlyRoot, true)
  assert.equal(invocation.runAsCurrentUser, true)
  assert.deepEqual(invocation.capabilities, [])
  assert.deepEqual(invocation.inheritEnvironment, [])
  assert.equal(invocation.environment.HTTP_PROXY, '')
  assert.equal(invocation.environment.RSI_MODEL_GATEWAY_MODEL, model.model)
  assert.equal(invocation.environment.RSI_SOLVER_MAX_STEPS, '3')
  assert.equal(invocation.secretEnvironment.RSI_MODEL_GATEWAY_DUMMY_KEY, modelAccess.secretEnvironment.RSI_PROVIDER_API_KEY)
  assert.equal(invocation.command[3], task)
  assert.equal(invocation.command.at(-1), 'cowork')
  assert.equal(invocation.command.at(-5), `${MSA_COWORK_CONTAINER_PATHS.solverOutput}/answer.txt`)
  assert.equal(invocation.command.at(-3), `${MSA_COWORK_CONTAINER_PATHS.solverOutput}/agent.jsonl`)
  assert.deepEqual(
    invocation.mounts.map(({ target, readOnly }) => [target, readOnly]),
    [
      [MSA_COWORK_CONTAINER_PATHS.candidate, true],
      ['/root', false],
      [MSA_COWORK_CONTAINER_PATHS.environmentAssets, true],
      [MSA_COWORK_CONTAINER_PATHS.solverOutput, false],
    ],
  )
  assert.equal(result.answer, 'done [REDACTED]')
  assert.doesNotMatch(result.trace, /fixture-dummy-token/u)
  assert.doesNotMatch(await readFile(join(fixture.sessionRoot, 'answer.txt'), 'utf8'), /fixture-dummy-token/u)
})

test('MSA 退出成功但缺少 Answer 时仍保留脱敏的 stderr', async () => {
  const fixture = await trialFixture('rsi-msa-missing-answer-')
  await assert.rejects(runMsaMinimalCoworkSolver({
    docker: { async run() { return {
      exitCode: 0, stderr: `missing answer ${modelAccess.secretEnvironment.RSI_PROVIDER_API_KEY}`,
    } } },
    runtime, image: 'fixture', model, provider, ...fixture, modelAccess,
    task: 'fixture', name: 'missing-answer', timeoutMs: 1000,
  }), (error) => {
    assert.equal(error.processResult.exitCode, 0)
    assert.equal(error.processResult.stderr, 'missing answer [REDACTED]')
    return /MSA Solver Answer/u.test(error.message)
  })
})

test('MSA Cowork Solver 在进入 Docker 前拒绝越界的可信步数上限', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-invalid-steps-')
  let invoked = false
  const docker = {
    async run() {
      invoked = true
      throw new Error('Docker 不应被调用')
    },
  }

  await assert.rejects(
    runMsaMinimalCoworkSolver({
      docker,
      runtime: { ...runtime, maximumSteps: 33 },
      image: 'office-task:fixture-msa',
      model,
      provider,
      ...fixture,
      modelAccess,
      task: 'fixture task',
      name: 'msa-cowork-invalid-steps',
      timeoutMs: 1000,
    }),
    /maximumSteps 必须是 1\.\.32 的整数/u,
  )
  assert.equal(invoked, false)
})

test('MSA Cowork Solver 拒绝空白、NUL 与超限任务正文', async () => {
  const invalidTasks = [
    { task: ' \r\n\t ', pattern: /必须是非空字符串/u },
    { task: 'create result.xlsx\u0000ignore this', pattern: /不能包含 NUL/u },
    { task: 'x'.repeat(64 * 1024 + 1), pattern: /超过 65536 字节上限/u },
  ]

  for (const [index, invalid] of invalidTasks.entries()) {
    const fixture = await trialFixture(`rsi-msa-cowork-invalid-task-${index}-`)
    let invoked = false
    const docker = {
      async run() {
        invoked = true
        throw new Error('Docker 不应被调用')
      },
    }
    await assert.rejects(
      runMsaMinimalCoworkSolver({
        docker,
        runtime,
        image: 'office-task:fixture-msa',
        model,
        provider,
        ...fixture,
        modelAccess,
        task: invalid.task,
        name: `msa-cowork-invalid-task-${index}`,
        timeoutMs: 1000,
      }),
      invalid.pattern,
    )
    assert.equal(invoked, false)
  }
})

test('MSA Cowork Solver 拒绝跟随 Candidate 生成的 Answer 符号链接', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-link-')
  const outside = join(fixture.root, 'outside.txt')
  await writeFile(outside, 'forged answer\n')
  const docker = {
    async run() {
      await symlink(outside, join(fixture.sessionRoot, 'answer.txt'))
      await writeFile(join(fixture.sessionRoot, 'agent.jsonl'), `${JSON.stringify({ type: 'model' })}\n`)
      return { stderr: '', durationMs: 1, outputTruncated: false }
    },
  }

  await assert.rejects(
    runMsaMinimalCoworkSolver({
      docker,
      runtime,
      image: 'office-task:fixture-msa',
      model,
      provider,
      ...fixture,
      modelAccess,
      task: 'fixture task',
      name: 'msa-cowork-link-fixture',
      timeoutMs: 1000,
    }),
    /Answer 不安全或不可读/u,
  )
})

test('MSA Solver Driver 提供 Factory 所需接口并累计隔离网关 Usage', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-driver-')
  const snapshots = [
    {
      acceptedRequests: 0,
      usageResponses: 0,
      unknownUsageResponses: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      activeRequests: 0,
    },
    {
      acceptedRequests: 1,
      usageResponses: 1,
      unknownUsageResponses: 0,
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      activeRequests: 0,
    },
  ]
  const gatewayCalls = []
  const modelGateway = {
    async access(role, policy) {
      gatewayCalls.push(['access', role, policy])
      return modelAccess
    },
    async usage(role) {
      gatewayCalls.push(['usage', role])
      return snapshots.shift()
    },
  }
  const docker = {
    async run() {
      await writeFile(join(fixture.sessionRoot, 'answer.txt'), 'done\n')
      await writeFile(join(fixture.sessionRoot, 'agent.jsonl'), `${JSON.stringify({ type: 'model' })}\n`)
      return { stderr: '', durationMs: 1, outputTruncated: false }
    },
  }
  const driver = createMsaMinimalCoworkSolverDriver({
    target: { solver: { protocol: 'msa-minimal-docker-v1', runtime } },
    provider,
    docker,
    repositoryRoot,
    sourceRevision,
    sourcePath: 'sources/msa-minimal-harness',
    modelGateway,
  })

  const result = await driver.run({
    image: 'office-task:fixture-msa',
    model,
    ...fixture,
    task: 'fixture task',
    name: 'msa-cowork-driver-fixture',
    timeoutMs: 1000,
  })

  assert.equal(result.modelUsage.totalTokens, undefined)
  assert.equal(result.modelUsage.inputTokens, 20)
  assert.equal(driver.usage().totalTokens, 25)
  assert.equal(driver.cacheKey, `msa-${sourceRevision.slice(0, 12)}`)
  assert.deepEqual(gatewayCalls, [
    ['usage', 'solver'],
    ['access', 'solver', {
      model: 'fixture-terra',
      maxTokens: 2048,
      maxTokensField: 'max_tokens',
      reasoningEffort: 'high',
    }],
    ['usage', 'solver'],
  ])
})

test('MSA Solver Driver 并发 Batch 只对网关 Usage 做一次总差分', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-batch-')
  const snapshots = [
    {
      acceptedRequests: 0, usageResponses: 0, unknownUsageResponses: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      activeRequests: 0,
    },
    {
      acceptedRequests: 2, usageResponses: 2, unknownUsageResponses: 0,
      inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 0,
      activeRequests: 0,
    },
  ]
  const gatewayCalls = []
  const modelGateway = {
    async access(role) {
      gatewayCalls.push(['access', role])
      return modelAccess
    },
    async usage(role) {
      gatewayCalls.push(['usage', role])
      return snapshots.shift()
    },
  }
  const docker = {
    async run() {
      await writeFile(join(fixture.sessionRoot, 'answer.txt'), 'done\n')
      await writeFile(join(fixture.sessionRoot, 'agent.jsonl'), `${JSON.stringify({ type: 'model' })}\n`)
      return { stderr: '', durationMs: 1, outputTruncated: false }
    },
  }
  const driver = createMsaMinimalCoworkSolverDriver({
    target: { solver: { protocol: 'msa-minimal-docker-v1', runtime } },
    provider,
    docker,
    repositoryRoot,
    sourceRevision,
    sourcePath: 'sources/msa-minimal-harness',
    modelGateway,
  })

  await driver.beginUsageBatch()
  const result = await driver.run({
    image: 'office-task:fixture-msa', model, ...fixture, task: 'fixture task',
    name: 'msa-cowork-batch-fixture', timeoutMs: 1000,
  })
  assert.equal(result.modelUsage, undefined)
  await driver.endUsageBatch()
  assert.equal(driver.usage().totalTokens, 50)
  assert.deepEqual(gatewayCalls.map(([action]) => action), ['usage', 'access', 'usage'])
})

test('MSA Solver Driver 允许多个并行 Partition 共享同一个 Usage Batch', async () => {
  const snapshots = [
    {
      acceptedRequests: 0, usageResponses: 0, unknownUsageResponses: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      activeRequests: 0,
    },
    {
      acceptedRequests: 4, usageResponses: 4, unknownUsageResponses: 0,
      inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, reasoningTokens: 0,
      activeRequests: 0,
    },
  ]
  let usageCalls = 0
  const driver = createMsaMinimalCoworkSolverDriver({
    target: { solver: { protocol: 'msa-minimal-docker-v1', runtime } },
    provider,
    docker: {},
    repositoryRoot,
    sourceRevision,
    sourcePath: 'sources/msa-minimal-harness',
    modelGateway: {
      async usage() {
        usageCalls += 1
        return snapshots.shift()
      },
    },
  })

  await Promise.all([driver.beginUsageBatch(), driver.beginUsageBatch()])
  assert.equal(await driver.endUsageBatch(), null)
  const usage = await driver.endUsageBatch()
  assert.equal(usage.acceptedRequests, 4)
  assert.equal(usageCalls, 2)
  assert.equal(driver.usage().totalTokens, 100)
})

test('MSA Cowork CandidateSeed Python 可解析，Chat Client 可读取 SSE', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const pythonFiles = ['agent.py', 'model.py', 'run.py'].map((name) => join(seedRoot, name))
  await executeFile('python3', [
    '-c',
    [
      'import ast, pathlib, sys',
      'for value in sys.argv[1:]:',
      '    path = pathlib.Path(value)',
      '    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))',
    ].join('\n'),
    ...pythonFiles,
  ])

  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'cowork' } }] })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `print(query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77))`,
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(stdout.trim(), 'hello cowork')
  assert.equal(requests[0].url, '/chat/completions')
  assert.equal(requests[0].body.model, 'fixture-terra')
  assert.equal(requests[0].body.max_tokens, 77)
  assert.equal(requests[0].body.stream, true)
})

test('MSA Cowork Agent 将安全的 view_image 动作转换为多模态消息且不把图片写入 Trace', async () => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rsi-msa-image-agent-'))
  const profileRoot = join(fixtureRoot, 'profiles')
  const workspace = join(fixtureRoot, 'workspace')
  const tracePath = join(fixtureRoot, 'agent.jsonl')
  await Promise.all([mkdir(profileRoot), mkdir(workspace)])
  await writeFile(join(profileRoot, 'cowork.md'), 'fixture prompt\n')
  await writeFile(join(profileRoot, 'cowork.json'), `${JSON.stringify({
    max_steps: 2,
    max_output_tokens: 1024,
    maximum_skill_files: 1,
    maximum_skill_chars: 1024,
    command_timeout_seconds: 1,
    max_observation_chars: 1024,
    max_image_bytes: 4096,
  })}\n`)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  await writeFile(join(workspace, 'preview.png'), png)
  const script = [
    'import base64, json, pathlib, sys, types',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'calls = []',
    'replies = iter(["<view_image>preview.png</view_image>", "<final>done</final>"])',
    'def fake_query(*args):',
    '    calls.append(args[3])',
    '    return next(replies)',
    'sys.modules["model"] = types.SimpleNamespace(query=fake_query)',
    'sys.modules["tools"] = types.SimpleNamespace(run_bash=lambda *args: "unused")',
    'from agent import Agent',
    `runner = Agent(pathlib.Path(${JSON.stringify(fixtureRoot)}), "cowork", "http://gateway", "dummy", "fixture", 1024, 2, pathlib.Path(${JSON.stringify(tracePath)}))`,
    `answer = runner.run("fixture task", pathlib.Path(${JSON.stringify(workspace)}))`,
    'message = calls[1][-1]',
    'image = message["content"][1]["image_url"]',
    'trace = pathlib.Path(' + JSON.stringify(tracePath) + ').read_text(encoding="utf-8")',
    'print(json.dumps({"answer": answer, "requests": len(calls), "message": message, "trace": trace}))',
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.answer, 'done')
  assert.equal(result.requests, 2)
  assert.equal(result.message.role, 'user')
  assert.equal(result.message.content[0].type, 'text')
  assert.equal(result.message.content[1].type, 'image_url')
  assert.equal(result.message.content[1].image_url.detail, 'auto')
  assert.match(result.message.content[1].image_url.url, /^data:image\/png;base64,/u)
  assert.equal(
    Buffer.from(result.message.content[1].image_url.url.split(',', 2)[1], 'base64').toString('base64'),
    png.toString('base64'),
  )
  assert.match(result.trace, /"type": "image_observation"/u)
  assert.match(result.trace, /"path": "preview\.png"/u)
  assert.doesNotMatch(result.trace, new RegExp(png.toString('base64'), 'u'))
})

test('MSA 图片工具拒绝越界路径、符号链接、伪图片和超限文件', async () => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rsi-msa-image-policy-'))
  const workspace = join(fixtureRoot, 'workspace')
  await mkdir(workspace)
  const script = [
    'import base64, json, pathlib, sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from image_tool import ImageToolError, read_image',
    `root = pathlib.Path(${JSON.stringify(workspace)})`,
    'png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")',
    '(root / "ok.png").write_bytes(png)',
    '(root / "fake.png").write_bytes(b"not an image")',
    '(root / "large.png").write_bytes(png + b"x" * 32)',
    '(root / "link.png").symlink_to(root / "ok.png")',
    'accepted = read_image(root, "./ok.png")',
    'rejected = {}',
    'for name in ["/etc/passwd", "../ok.png", "fake.png", "link.png", "large.png"]:',
    '    try:',
    '        read_image(root, name, maximum_bytes=16)',
    '    except ImageToolError as error:',
    '        rejected[name] = str(error)',
    '    else:',
    '        rejected[name] = None',
    'print(json.dumps({"path": accepted["path"], "mime": accepted["mime_type"], "rejected": rejected}))',
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.path, 'ok.png')
  assert.equal(result.mime, 'image/png')
  for (const value of Object.values(result.rejected)) assert.equal(typeof value, 'string')
})

test('MSA Cowork Candidate Profile 不能抬高 Controller 下发的步数上限', async () => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rsi-msa-step-cap-'))
  const profileRoot = join(fixtureRoot, 'profiles')
  const tracePath = join(fixtureRoot, 'agent.jsonl')
  await mkdir(profileRoot)
  await writeFile(join(profileRoot, 'cowork.md'), 'fixture prompt\n')
  await writeFile(join(profileRoot, 'cowork.json'), `${JSON.stringify({
    max_steps: 32,
    max_output_tokens: 1024,
    maximum_skill_files: 1,
    maximum_skill_chars: 1024,
    command_timeout_seconds: 1,
    max_observation_chars: 1024,
  })}\n`)
  const script = [
    'import json, pathlib, sys, types',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'sys.modules["tools"] = types.SimpleNamespace(run_bash=lambda *args: "unused")',
    'import agent',
    'calls = []',
    'agent.query = lambda *args: calls.append(args) or "continue"',
    `runner = agent.Agent(pathlib.Path(${JSON.stringify(fixtureRoot)}), "cowork", "http://gateway", "dummy", "fixture", 1024, 2, pathlib.Path(${JSON.stringify(tracePath)}))`,
    `answer = runner.run("fixture task", pathlib.Path(${JSON.stringify(fixtureRoot)}))`,
    'print(json.dumps({"requests": len(calls), "maximum_steps": runner.maximum_steps, "answer": answer}))',
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const result = JSON.parse(stdout)

  assert.equal(result.requests, 2)
  assert.equal(result.maximum_steps, 2)
  assert.match(result.answer, /exhausted its step budget/u)
})

test('MSA Cowork Candidate 不把空 Final 或空 Bash 当成有效动作', async () => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const script = [
    'import json, sys, types',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'sys.modules["model"] = types.SimpleNamespace(query=lambda *args: "unused")',
    'sys.modules["tools"] = types.SimpleNamespace(run_bash=lambda *args: "unused")',
    'from agent import Agent',
    'print(json.dumps({',
    '  "empty_final": Agent.parse("<final>   </final>"),',
    '  "empty_bash": Agent.parse("<bash>\\n\\t</bash>"),',
    '  "valid_final": Agent.parse("<final>done</final>"),',
    '  "bash_before_image": Agent.parse("<bash>touch result.docx</bash><view_image>result.png</view_image>"),',
    '  "image_before_final": Agent.parse("<view_image>result.png</view_image><final>done</final>"),',
    '  "bash_before_final": Agent.parse("<bash>touch result.docx</bash><final>done</final>"),',
    '}))',
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const result = JSON.parse(stdout)

  assert.equal(result.empty_final, null)
  assert.equal(result.empty_bash, null)
  assert.deepEqual(result.valid_final, ['final', 'done'])
  assert.deepEqual(result.bash_before_image, ['bash', 'touch result.docx'])
  assert.deepEqual(result.image_before_final, ['view_image', 'result.png'])
  assert.deepEqual(result.bash_before_final, ['bash', 'touch result.docx'])
})

test('MSA Cowork Candidate 对多动作响应只执行最先出现的动作', async () => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rsi-msa-first-action-'))
  const profileRoot = join(fixtureRoot, 'profiles')
  const tracePath = join(fixtureRoot, 'agent.jsonl')
  await mkdir(profileRoot)
  await writeFile(join(profileRoot, 'cowork.md'), 'fixture prompt\n')
  await writeFile(join(profileRoot, 'cowork.json'), `${JSON.stringify({
    max_steps: 2,
    max_output_tokens: 1024,
    maximum_skill_files: 1,
    maximum_skill_chars: 1024,
    command_timeout_seconds: 1,
    max_observation_chars: 1024,
  })}\n`)
  const script = [
    'import copy, json, pathlib, sys, types',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'sys.modules["model"] = types.SimpleNamespace(query=lambda *args: "unused")',
    'sys.modules["tools"] = types.SimpleNamespace(run_bash=lambda *args: "unused")',
    'import agent',
    'replies = iter([',
    '  "prefix <bash>printf ok</bash><view_image>missing.png</view_image><final>not-done</final>",',
    '  "<final>done</final>",',
    '])',
    'requests = []',
    'commands = []',
    'agent.query = lambda *args: requests.append(copy.deepcopy(args[3])) or next(replies)',
    'agent.run_bash = lambda command, *args: commands.append(command) or "command-ok"',
    `runner = agent.Agent(pathlib.Path(${JSON.stringify(fixtureRoot)}), "cowork", "http://gateway", "dummy", "fixture", 1024, 2, pathlib.Path(${JSON.stringify(tracePath)}))`,
    `answer = runner.run("fixture task", pathlib.Path(${JSON.stringify(fixtureRoot)}))`,
    'print(json.dumps({"answer": answer, "commands": commands, "second_messages": requests[1]}))',
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const result = JSON.parse(stdout)

  assert.equal(result.answer, 'done')
  assert.deepEqual(result.commands, ['printf ok'])
  assert.equal(result.second_messages[2].content, '<bash>\nprintf ok\n</bash>')
  assert.doesNotMatch(result.second_messages[2].content, /view_image|not-done/u)
  assert.match(result.second_messages[3].content, /command-ok/u)
})

test('MSA Cowork Chat Client 对正常结束的空流最多重试两次', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests < 3) {
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
      return
    }
    response.end([
      `data: ${JSON.stringify({ choices: [{ message: { content: '<bash>echo safe</bash>' }, delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `print(query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77))`,
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(stdout.trim(), '<bash>echo safe</bash>')
  assert.equal(requests, 3)
})

test('MSA Cowork Chat Client 重试未交给 Agent 的 SSE 上游错误', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests < 3) {
      response.end([
        `data: ${JSON.stringify({ error: { message: 'transient private detail' } })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
      return
    }
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '<bash>echo recovered</bash>' } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `print(query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77))`,
  ].join('\n')
  const { stdout, stderr } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(stdout.trim(), '<bash>echo recovered</bash>')
  assert.equal(stderr, '')
  assert.equal(requests, 3)
})

test('MSA Cowork Chat Client 能跨过连续七次 SSE 上游错误', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests < 8) {
      response.end([
        `data: ${JSON.stringify({ error: { message: 'transient private detail' } })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
      return
    }
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '<final>recovered</final>' } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'import model',
    'model.RETRY_BASE_DELAY_SECONDS = 0',
    `print(model.query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77))`,
  ].join('\n')
  const { stdout, stderr } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(stdout.trim(), '<final>recovered</final>')
  assert.equal(stderr, '')
  assert.equal(requests, 8)
})

test('MSA Cowork Chat Client 只重试可恢复的 Gateway HTTP 状态', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    if (requests < 3) {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'private upstream detail' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{ message: { content: '<final>recovered</final>' }, finish_reason: 'stop' }],
    }))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `print(query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77))`,
  ].join('\n')
  const { stdout, stderr } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(stdout.trim(), '<final>recovered</final>')
  assert.equal(stderr, '')
  assert.equal(requests, 3)
})

test('MSA Cowork Chat Client 不重试认证错误且不回显上游响应体', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'private credential detail' }))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77)`,
  ].join('\n')

  await assert.rejects(
    executeFile('python3', ['-c', script], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }),
    (error) => {
      assert.match(error.stderr, /model gateway HTTP 401/u)
      assert.doesNotMatch(error.stderr, /private credential detail/u)
      return true
    },
  )
  assert.equal(requests, 1)
})

test('MSA Cowork Chat Client 丢弃 reasoning_content 且三次空流后关闭失败', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const hiddenCommand = '<bash>touch /tmp/must-not-run</bash>'
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: hiddenCommand } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77)`,
  ].join('\n')

  await assert.rejects(
    executeFile('python3', ['-c', script], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }),
    (error) => {
      assert.match(error.stderr, /reasoning_content_discarded=true/u)
      assert.doesNotMatch(error.stderr, /must-not-run/u)
      return true
    },
  )
  assert.equal(requests, 3)
})

test('MSA Cowork Chat Client 遇到 content_filter 不重试', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77)`,
  ].join('\n')

  await assert.rejects(
    executeFile('python3', ['-c', script], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }),
    /refused or filtered/u,
  )
  assert.equal(requests, 1)
})

test('MSA Cowork Chat Client 遇到 length 截断不重试且不暴露隐藏推理', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const hiddenCommand = '<bash>touch /tmp/truncated-reasoning</bash>'
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: hiddenCommand } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77)`,
  ].join('\n')

  await assert.rejects(
    executeFile('python3', ['-c', script], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }),
    (error) => {
      assert.match(error.stderr, /after 1 attempt\(s\).*finish_reason=length.*reasoning_content_discarded=true/su)
      assert.doesNotMatch(error.stderr, /truncated-reasoning/u)
      return true
    },
  )
  assert.equal(requests, 1)
})
