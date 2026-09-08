import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const seedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../targets/msa-minimal/cowork-v1')
const pythonEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }

async function parse(body, contentType = 'text/event-stream') {
  const script = [
    'import io, json, sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'import model',
    `response = io.BytesIO(bytes.fromhex(${JSON.stringify(Buffer.from(body).toString('hex'))}))`,
    `response.headers = {"content-type": ${JSON.stringify(contentType)}, "x-oneapi-request-id": "fixture-123"}`,
    'try:',
    '    print(json.dumps(model._read_response(response)))',
    'except Exception as error:',
    '    print(json.dumps({"error": str(error), "kind": type(error).__name__}))',
  ].join('\n')
  return JSON.parse((await execute('python3', ['-c', script], { env: pythonEnv })).stdout)
}

test('MSA 按正文识别 JSON，不被错误的 SSE 响应头或 BOM 误导', async () => {
  const result = await parse('\ufeff' + JSON.stringify({
    choices: [{ message: { content: '真实正文🙂', reasoning_content: '不能执行的推理' }, finish_reason: 'stop' }],
  }))
  assert.equal(result.text, '真实正文🙂')
  assert.equal(result.wire_format, 'json')
  assert.equal(result.request_id, 'fixture-123')
  assert.equal(result.saw_reasoning, true)
})

test('MSA 支持 SSE 多行 data、CRLF、注释及错误的 JSON 响应头', async () => {
  const result = await parse([
    ': heartbeat', 'event: message', 'data: {"choices":',
    'data: [{"delta":{"content":"完整内容🙂"},"finish_reason":"stop"}]}', '',
    'data: [DONE]', '', '',
  ].join('\r\n'), 'application/json')
  assert.equal(result.text, '完整内容🙂')
  assert.equal(result.wire_format, 'sse')
})

test('MSA 不把中途截断的正文交给 Agent 执行', async () => {
  const result = await parse('data: {"choices":[{"delta":{"content":"<bash>partial"}}]}\n\n')
  assert.equal(result.kind, 'TransientModelResponseError')
  assert.match(result.error, /incomplete stream.*fixture-123/u)
  assert.doesNotMatch(result.error, /partial/u)
})

test('MSA 区分真空流、推理内容和可执行正文', async () => {
  const result = await parse('data: {"choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  assert.equal(result.text, '')
  assert.equal(result.finish_reason, 'stop')
  assert.equal(result.saw_reasoning, true)
  assert.equal(result.request_id, 'fixture-123')
})

test('MSA 保留 HTTP 200 内的结构化错误码，不回显敏感错误正文', async () => {
  for (const body of [
    JSON.stringify({ error: { code: 'server_is_overloaded', message: 'sk-private-secret-value' } }),
    'data: {"type":"error","code":"server_is_overloaded","message":"sk-private-secret-value"}\n\n',
  ]) {
    const result = await parse(body)
    assert.equal(result.kind, 'TransientModelResponseError')
    assert.match(result.error, /server_is_overloaded.*fixture-123/u)
    assert.doesNotMatch(result.error, /private-secret/u)
  }
  const permanent = await parse(JSON.stringify({ error: { code: 'invalid_api_key' } }))
  assert.equal(permanent.kind, 'RuntimeError')
})

test('MSA 第八次传输故障仍保留状态码和上游请求编号', async (context) => {
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(500, { 'content-type': 'application/json', 'x-oneapi-request-id': `fixture-${requests}` })
    response.end(JSON.stringify({ error: { code: 'server_is_overloaded', message: 'private detail' } }))
  })
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept))
  context.after(() => new Promise((accept) => server.close(accept)))
  const script = [
    'import sys', `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'import model', 'model.RETRY_BASE_DELAY_SECONDS = 0',
    `model.query("http://127.0.0.1:${server.address().port}", "dummy", "fixture", [], 64)`,
  ].join('\n')
  await assert.rejects(execute('python3', ['-c', script], { env: pythonEnv }), (error) => {
    assert.match(error.stderr, /after 8 attempt.*HTTP 500.*server_is_overloaded.*fixture-8/u)
    assert.doesNotMatch(error.stderr, /private detail/u)
    return true
  })
  assert.equal(requests, 8)
})

test('MSA 对无 choices 的 JSON 留下请求编号，对非法结构明确报传输错误', async () => {
  const empty = await parse('{}')
  assert.equal(empty.text, '')
  assert.equal(empty.request_id, 'fixture-123')
  assert.equal(empty.wire_format, 'json')
  for (const choices of [{}, null, [null]]) {
    const malformed = await parse(JSON.stringify({ choices }))
    assert.equal(malformed.kind, 'TransientModelResponseError')
    assert.match(malformed.error, /invalid choices shape/u)
  }
})
