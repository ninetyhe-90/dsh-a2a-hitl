import assert from 'node:assert/strict'
import { test } from 'node:test'
import { A2aClient } from '../src/client.js'
import { resolveConfig } from '../src/config.js'
import { checkAddress, type HttpTransport } from '../src/transport.js'
import { readSse } from '../src/sse.js'

function frame(id: string, state = 'completed', metadata: Record<string, unknown> = { kind: 'question_done', success: true, results: [{ success: true, answer: 'Done' }] }, task = 'task-1') {
  return { jsonrpc: '2.0', id, result: { id: task, status: { state }, artifacts: [{ metadata }] } }
}
const question = { kind: 'hitl_required', hitl_id: 'same-node', action_type: 'ask_user_question', question: 'Proceed?', options: [{ label: 'Cancel' }], multi_select: false, allow_custom_input: true }
function response(frames: unknown[]) {
  return { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')))
    controller.close()
  } }) }
}
function mock(handler: (payload: any, index: number) => ReturnType<typeof response>) {
  const calls: any[] = []
  const transport: HttpTransport = { async request(_url, input) {
    assert.equal(input.method, 'POST')
    const payload = JSON.parse(input.body!)
    calls.push(payload)
    return handler(payload, calls.length - 1)
  } }
  return { transport, calls }
}
function config(extra = {}) {
  return { agents: [{ id: 'example', cardUrl: 'https://agent.invalid/card', rpcUrl: 'https://agent.invalid/rpc' }], ...extra }
}
const input = { agentId: 'example', ownerId: 'local', message: 'Example' }

test('wrong SSE Content-Type cancels the unread response body', async () => {
  let cancelled = false
  const transport: HttpTransport = { async request() { return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }),
    body: new ReadableStream({ cancel() { cancelled = true } }) } } }
  const client = new A2aClient(config(), { transport, human: async () => { throw new Error('must not ask') } })
  await assert.rejects(client.call(input), /text\/event-stream/)
  assert.equal(cancelled, true)
  await client.dispose()
})

test('abort while parsing already buffered delta and final answer never returns success', async () => {
  const controller = new AbortController()
  const m = mock(payload => response([
    { jsonrpc: '2.0', id: payload.id, result: { id: 'task-1', status: { state: 'working' }, artifacts: [{ metadata: { kind: 'answer_delta' }, parts: [{ kind: 'text', text: 'Preview' }] }] } },
    frame(payload.id),
  ]))
  const client = new A2aClient(config(), { transport: m.transport, human: async () => { throw new Error('must not ask') } })
  await assert.rejects(client.call({ ...input, signal: controller.signal, onDelta: () => controller.abort(new Error('Stopped during delta')) }), /Stopped during delta/)
  await client.dispose()
})

test('fresh task may reuse a question id, but each task still requires its own human answer', async () => {
  const m = mock((payload, index) => response([frame(payload.id, index % 2 === 0 ? 'input-required' : 'completed', index % 2 === 0 ? question : undefined, index < 2 ? 'task-A' : 'task-B')]))
  let asked = 0
  const client = new A2aClient(config(), { transport: m.transport, human: async () => { asked++; return { selected: ['Cancel'], customInput: '' } } })
  const first = await client.call(input)
  const second = await client.call({ ...input, conversationId: first.conversation_id })
  assert.equal(asked, 2)
  assert.equal(second.task_id, 'task-B')
  assert.equal(m.calls[0].params.message.metadata.sessionId, m.calls[2].params.message.metadata.sessionId)
  await client.dispose()
})

test('legacy reply locates original remote task using original session and current hitl_id only', async () => {
  const pending = new Map<string, { task: string; hitl: string }>()
  const m = mock(payload => {
    const message = payload.params.message
    const reply = message.parts.find((part: any) => part.kind === 'data')?.data.hitl_response
    const session = message.metadata.sessionId
    if (!reply) {
      pending.set(session, { task: 'original-task', hitl: 'same-node' })
      return response([frame(payload.id, 'input-required', question, 'original-task')])
    }
    assert.equal(payload.params.taskId, undefined)
    assert.equal(payload.params.contextId, undefined)
    const original = pending.get(session)
    assert.ok(original)
    assert.equal(reply.hitl_id, original.hitl)
    pending.delete(session)
    return response([frame(payload.id, 'completed', undefined, original.task)])
  })
  const client = new A2aClient(config(), { transport: m.transport, human: async () => ({ selected: ['Cancel'], customInput: '' }) })
  assert.equal((await client.call(input)).task_id, 'original-task')
  assert.equal(pending.size, 0)
  await client.dispose()
})

test('HITL followed by RPC error, failed task or completed frame never opens a question', async () => {
  for (const following of [
    (id: string) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Failed' } }),
    (id: string) => frame(id, 'failed'),
    (id: string) => frame(id, 'canceled'),
    (id: string) => frame(id),
  ]) {
    let asked = 0
    const m = mock(payload => response([frame(payload.id, 'input-required', question), following(payload.id)]))
    const client = new A2aClient(config(), { transport: m.transport, human: async () => { asked++; return { selected: ['Cancel'], customInput: '' } } })
    await assert.rejects(client.call(input))
    assert.equal(asked, 0)
    assert.equal(m.calls.length, 1)
    await client.dispose()
  }
})

test('dispose during pending human interaction prohibits all late replies and subsequent calls', async () => {
  let resolveAnswer!: (answer: { selected: string[]; customInput: string }) => void
  let humanStarted!: () => void
  const started = new Promise<void>(resolve => { humanStarted = resolve })
  const m = mock(payload => response([frame(payload.id, 'input-required', question)]))
  const client = new A2aClient(config(), { transport: m.transport, human: async () => {
    humanStarted()
    return new Promise(resolve => { resolveAnswer = resolve })
  } })
  const result = client.call(input)
  const rejected = assert.rejects(result, /disposed/)
  await started
  await client.dispose()
  resolveAnswer({ selected: ['Cancel'], customInput: '' })
  await rejected
  assert.equal(m.calls.length, 1)
  await assert.rejects(client.call(input), /disposed/)
})

test('credentials in URLs and forbidden authentication headers are rejected in configuration', () => {
  assert.throws(() => resolveConfig({ agents: [{ id: 'test', cardUrl: 'https://example.com/card?api_key=secret' }] }), /query|URL/i)
  assert.throws(() => resolveConfig({ agents: [{ id: 'test', cardUrl: 'https://example.com/card', headersEnv: { Host: 'A2A_HOST' } }] }), /header/i)
  assert.throws(() => resolveConfig({ agents: [{ id: 'test', cardUrl: 'https://example.com/card', headersEnv: { Authorization: 'literal secret' } }] }), /environment|header/i)
})

for (const address of ['127.0.0.1', '10.0.0.1', '9.1.1.1', '11.1.1.1', '21.1.1.1', '30.1.1.1', '::1', '::ffff:10.0.0.1', 'fc00::1', '169.254.169.254', 'fe80::1']) {
  test(`network protection rejects ${address} by default`, () => assert.throws(() => checkAddress(address, false), /network|address/i))
}

test('SSE handles multiline data and rejects frame limits and malformed JSON', async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('data: {"ok":\rdata: true}\r\r')); c.close() } })
  const values: unknown[] = []
  for await (const value of readSse({ status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body }, { maxResponseBytes: 4096, maxFrameBytes: 1024, signal: new AbortController().signal })) values.push(value)
  assert.deepEqual(values, [{ ok: true }])
  const m = mock(payload => response([frame(payload.id)]))
  const c = new A2aClient(config({ maxFrameBytes: 128 }), { transport: m.transport, human: async () => { throw new Error('must not ask') } })
  await assert.rejects(c.call(input), /frame|line/i)
  await c.dispose()
})
