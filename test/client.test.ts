import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { A2aClient, type HumanPrompt, type HumanAnswer } from '../src/client.js'

type Payload = Record<string, any>

async function remote(handler: (body: Payload, index: number) => Payload[], run: (url: string, calls: Payload[]) => Promise<void>) {
  const calls: Payload[] = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: 'Example agent', supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: `http://${req.headers.host}/rpc` }] }))
      return
    }
    let input = ''
    for await (const chunk of req) input += chunk.toString()
    const body = JSON.parse(input)
    calls.push(body)
    res.setHeader('content-type', 'text/event-stream')
    res.write(': keep-alive\r\n\r\n')
    for (const frame of handler(body, calls.length - 1)) {
      const encoded = Buffer.from(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, ...frame })}\r\n\r\n`)
      for (let start = 0; start < encoded.length; start += 7) res.write(encoded.subarray(start, start + 7))
    }
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try { await run(`http://127.0.0.1:${address.port}/card`, calls) }
  finally { await close(server) }
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function hitl(id = 'approval:1', extra: Payload = {}) {
  return { result: { id: 'task-1', status: { state: 'input-required' }, artifacts: [{ metadata: {
    kind: 'hitl_required', hitl_id: id, action_type: 'ask_user_question', question: '确认提交吗？',
    options: [{ label: '确认提交' }, { label: '取消' }], multi_select: false, allow_custom_input: true,
    arguments: { example: 'No real write' }, ...extra,
  } }] } }
}

function done(answer = 'Completed') {
  return { result: { id: 'task-1', status: { state: 'completed' }, artifacts: [{ metadata: {
    kind: 'question_done', success: true, sessionId: 'server-private-session', results: [{ success: true, answer }],
  } }] } }
}

function client(url: string, human: (prompt: HumanPrompt, signal: AbortSignal) => Promise<HumanAnswer>, extra: Payload = {}) {
  return new A2aClient({ agents: [{ id: 'example', cardUrl: url, allowPrivateNetwork: true, allowInsecureHttp: true }], ...extra }, { human })
}

function call(c: A2aClient, extra: Payload = {}) {
  return c.call({ agentId: 'example', ownerId: 'local-session-1', message: 'Ask example agent', ...extra })
}

test('Card discovery, chunked SSE, native human answer, exact label and task/session binding', async () => {
  await remote((_body, index) => index === 0 ? [hitl(), hitl()] : [done('已确认')], async (url, calls) => {
    let asked = 0
    const c = client(url, async prompt => {
      asked++
      assert.equal(prompt.hitlId, 'approval:1')
      assert.equal(prompt.question, '确认提交吗？')
      assert.deepEqual(prompt.metadata.arguments, { example: 'No real write' })
      assert.equal(calls.length, 1)
      return { selected: ['确认提交'], customInput: '' }
    })
    const result = await call(c)
    assert.equal(asked, 1)
    assert.equal(result.answer, '已确认')
    assert.equal(result.task_id, 'task-1')
    assert.equal(calls.length, 2)
    assert.notEqual(calls[0]!.id, calls[1]!.id)
    assert.equal(calls[0]!.params.message.metadata.sessionId, calls[1]!.params.message.metadata.sessionId)
    assert.notEqual(calls[1]!.params.message.metadata.sessionId, 'server-private-session')
    assert.equal(calls[1]!.params.contextId, undefined)
    assert.equal(calls[1]!.params.taskId, undefined)
    assert.deepEqual(calls[1]!.params.message.parts[1], { kind: 'data', data: { hitl_response: {
      hitl_id: 'approval:1', selected: ['确认提交'], custom_input: '',
    } } })
    c.dispose()
  })
})

test('human cancellation is sent exactly, never inferred from display text', async () => {
  await remote((_body, index) => index === 0 ? [hitl()] : [done('Cancelled')], async (url, calls) => {
    const result = await call(client(url, async () => ({ selected: ['取消'], customInput: '' })))
    assert.equal(result.answer, 'Cancelled')
    assert.deepEqual(calls[1]!.params.message.parts[1].data.hitl_response.selected, ['取消'])
  })
})

test('custom input clears selected and new node requires a new human answer', async () => {
  await remote((_body, index) => index === 0 ? [hitl()] : index === 1 ? [hitl('approval:2')] : [done('Cancelled')], async (url, calls) => {
    let asked = 0
    const result = await call(client(url, async () => ++asked === 1
      ? { selected: ['确认提交'], customInput: 'Please change the parameters' }
      : { selected: ['取消'], customInput: '' }))
    assert.equal(asked, 2)
    assert.equal(result.answer, 'Cancelled')
    assert.deepEqual(calls[1]!.params.message.parts[1].data.hitl_response, {
      hitl_id: 'approval:1', selected: [], custom_input: 'Please change the parameters',
    })
    assert.equal(calls[2]!.params.message.parts[1].data.hitl_response.hitl_id, 'approval:2')
  })
})

for (const answer of [
  { selected: [], customInput: '' },
  { selected: ['confirm'], customInput: '' },
  { selected: ['确认提交 '], customInput: '' },
  { selected: ['确认提交', '取消'], customInput: '' },
  { selected: ['取消', '取消'], customInput: '' },
]) test(`invalid human selection fails closed: ${JSON.stringify(answer)}`, async () => {
  await remote(() => [hitl()], async (url, calls) => {
    await assert.rejects(call(client(url, async () => answer)), /answer|selection/i)
    assert.equal(calls.length, 1)
  })
})

test('disallowed custom input is not sent to remote', async () => {
  await remote(() => [hitl('approval:1', { allow_custom_input: false })], async (url, calls) => {
    await assert.rejects(call(client(url, async () => ({ selected: [], customInput: 'Change' }))), /custom/i)
    assert.equal(calls.length, 1)
  })
})

test('consumed HITL cannot be replayed in a later response', async () => {
  await remote(() => [hitl()], async (url, calls) => {
    let asked = 0
    await assert.rejects(call(client(url, async () => { asked++; return { selected: ['取消'], customInput: '' } })), /replay|consumed/i)
    assert.equal(asked, 1)
    assert.equal(calls.length, 2)
  })
})

test('same id with changed parameters in one stream is rejected before asking', async () => {
  await remote(() => [hitl(), hitl('approval:1', { arguments: { changed: true } })], async (url, calls) => {
    let asked = 0
    await assert.rejects(call(client(url, async () => { asked++; return { selected: ['取消'], customInput: '' } })), /conflict|changed/i)
    assert.equal(asked, 0)
    assert.equal(calls.length, 1)
  })
})

test('client_tool never causes local execution or automatic approval', async () => {
  await remote(() => [hitl('approval:1', { action_type: 'client_tool', tool_name: 'shell', tool_input: {} })], async (url, calls) => {
    await assert.rejects(call(client(url, async () => { throw new Error('must not ask') })), /action_type|client_tool/i)
    assert.equal(calls.length, 1)
  })
})

test('JSON-RPC error on HTTP 200 preserves code, with no retry', async () => {
  await remote(() => [{ error: { code: -32602, message: 'Invalid input', data: { trace: 'example' } } }], async (url, calls) => {
    await assert.rejects(call(client(url, async () => { throw new Error('must not ask') })), (error: any) => error.code === 'REMOTE_RPC_ERROR' && error.remoteCode === -32602)
    assert.equal(calls.length, 1)
  })
})

test('mismatched response id, changed task, missing terminal, missing HITL payload fail', async () => {
  for (const frames of [
    [{ jsonrpc: '2.0', id: 'wrong', ...done() }],
    [{ result: { id: 'task-1', status: { state: 'working' } } }],
    [{ result: { id: 'task-1', status: { state: 'input-required' } } }],
    [hitl(), { result: { id: 'task-2', status: { state: 'input-required' }, artifacts: hitl().result.artifacts } }],
  ]) await remote(() => frames, async (url, calls) => {
    await assert.rejects(call(client(url, async () => { throw new Error('must not ask') })), /id|terminal|HITL|task/i)
    assert.equal(calls.length, 1)
  })
})

test('human provider failure and abort do not POST a fabricated reply', async () => {
  await remote(() => [hitl()], async (url, calls) => {
    await assert.rejects(call(client(url, async () => { throw new Error('NO_PROVIDER') })), /NO_PROVIDER/)
    assert.equal(calls.length, 1)
  })
  await remote(() => [hitl()], async (url, calls) => {
    const controller = new AbortController()
    await assert.rejects(call(client(url, async (_prompt, signal) => {
      controller.abort(new Error('User aborted'))
      signal.throwIfAborted()
      return { selected: ['确认提交'], customInput: '' }
    }), { signal: controller.signal }), /User aborted/)
    assert.equal(calls.length, 1)
  })
})

test('conversation handles are owner-bound and never accepted across local sessions', async () => {
  await remote(() => [done()], async (url, calls) => {
    const c = client(url, async () => { throw new Error('must not ask') })
    const first = await call(c)
    await assert.rejects(call(c, { ownerId: 'different-owner', conversationId: first.conversation_id }), /owner|conversation/i)
    assert.equal(calls.length, 1)
    const second = await call(c, { conversationId: first.conversation_id })
    assert.equal(second.conversation_id, first.conversation_id)
    assert.equal(calls[0]!.params.message.metadata.sessionId, calls[1]!.params.message.metadata.sessionId)
  })
})

test('private endpoints are disabled by default', async () => {
  await remote(() => [done()], async (url, calls) => {
    const c = new A2aClient({ agents: [{ id: 'example', cardUrl: url, allowInsecureHttp: true }] }, { human: async () => { throw new Error('must not ask') } })
    await assert.rejects(call(c), /private|network|address/i)
    assert.equal(calls.length, 0)
  })
})

test('response and human deadlines are independent; human timeout sends no reply', async () => {
  await remote(() => [hitl()], async (url, calls) => {
    const c = client(url, async () => new Promise(() => {}), { humanTimeoutMs: 30 })
    await assert.rejects(call(c), /timeout|deadline/i)
    assert.equal(calls.length, 1)
  })
})
