import { spawn } from 'node:child_process'
import { chownSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { startModelGateway } from '/opt/harness-rsi/model-gateway.mjs'

const audit = []
const dummyKey = 'rsi-container-local-gateway'
chownSync('/control-output', 0, 0)
chmodSync('/control-output', 0o700)
mkdirSync('/tmp/claude-home', { recursive: true })
chownSync('/tmp/claude-home', 1000, 1000)
const gateway = await startModelGateway({
  wireProtocol: 'anthropic-messages',
  upstreamBaseUrl: process.env.UPDATER_PROVIDER_URL,
  getApiKey: async () => process.env.UPDATER_PROVIDER_KEY,
  trustedModel: process.env.UPDATER_MODEL,
  trustedReasoningEffort: process.env.UPDATER_EFFORT,
  maxOutputTokens: Number(process.env.UPDATER_MAX_TOKENS),
  maxRequests: Number(process.env.UPDATER_MAX_REQUESTS),
  maxConcurrency: 1,
  candidateApiKey: dummyKey,
  audit: record => { audit.push(record) },
})
try {
  const child = spawn('claude', [
    '--print', '--bare', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--permission-prompts', 'none', '--tools', 'Read,Edit,Write,Bash,Glob,Grep',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome', '--model', process.env.UPDATER_MODEL,
    '--effort', process.env.UPDATER_EFFORT, process.argv[2],
  ], {
    cwd: '/opt/harness-rsi/candidate', uid: 1000, gid: 1000,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/claude-home', LANG: 'C.UTF-8',
      ANTHROPIC_BASE_URL: new URL(gateway.url).origin, ANTHROPIC_API_KEY: dummyKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1', PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPYCACHEPREFIX: '/tmp/python-cache',
      GIT_DIR: '/opt/harness-rsi/git', GIT_WORK_TREE: '/opt/harness-rsi/candidate',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const redact = chunk => Buffer.from(chunk).toString().split(process.env.UPDATER_PROVIDER_KEY).join('[REDACTED]')
  child.stdout.on('data', chunk => process.stdout.write(redact(chunk)))
  child.stderr.on('data', chunk => process.stderr.write(redact(chunk)))
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
} finally {
  await gateway.close()
  writeFileSync('/control-output/audit.json', JSON.stringify(audit))
}
