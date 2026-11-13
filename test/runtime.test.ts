import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createLocalRuntime } from '../examples/local-runtime.js'
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

test('real Cordis and DSH questions services relay concurrent owners through registered A2A tool', async () => {
  const calls: any[] = []
  const tasks = new Map<string, { task: string; node: string }>()
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk.toString()
    const input = JSON.parse(raw)
    calls.push(input)
    const session = input.params.message.metadata.sessionId
    const reply = input.params.message.parts.find((p: any) => p.kind === 'data')?.data.hitl_response
    let result
    if (!reply) {
      const task = `task-${session}`
      const node = `node-${session}`
      tasks.set(session, { task, node })
      result = { id: task, status: { state: 'input-required' }, artifacts: [{ metadata: {
        kind: 'hitl_required', hitl_id: node, action_type: 'ask_user_question', question: input.params.message.parts[0].text,
        options: [{ label: 'Confirm' }, { label: 'Cancel' }], multi_select: false, allow_custom_input: true,
      } }] }
    } else {
      const pending = tasks.get(session)
      assert.ok(pending)
      assert.equal(reply.hitl_id, pending.node)
      tasks.delete(session)
      result = { id: pending.task, status: { state: 'completed' }, artifacts: [{ metadata: {
        kind: 'question_done', success: true, results: [{ success: true, answer: reply.custom_input || reply.selected.join(',') }],
      } }] }
    }
    res.setHeader('content-type', 'text/event-stream')
    res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: input.id, result })}\n\n`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const ui = new Map<string, { request: AskUserQuestionRequest; resolve: (answer: AskUserQuestionAnswer) => void }>()
  let ready!: () => void
  const waiting = new Promise<void>(resolve => { ready = resolve })
  const runtime = await createLocalRuntime({ agents: [{ id: 'example', cardUrl: `http://127.0.0.1:${address.port}/card`, rpcUrl: `http://127.0.0.1:${address.port}/rpc`, allowPrivateNetwork: true, allowInsecureHttp: true }] }, async request => new Promise(resolve => {
    ui.set(request.agent!.id, { request, resolve })
    if (ui.size === 2) ready()
  }))
  try {
    const first = runtime.call('owner-A', 'Question A')
    const second = runtime.call('owner-B', 'Question B')
    await waiting
    assert.equal(calls.length, 2)
    const a = ui.get('owner-A')!
    const b = ui.get('owner-B')!
    assert.equal(a.request.questions[0]!.question, 'Question A')
    assert.equal(b.request.questions[0]!.question, 'Question B')
    a.resolve({ answers: [{ id: a.request.questions[0]!.id, selected: ['Cancel'] }] })
    b.resolve({ answers: [{ id: b.request.questions[0]!.id, selected: ['Confirm'], custom: 'Change parameters' }] })
    const [one, two] = await Promise.all([first, second])
    assert.equal(one.answer, 'Cancel')
    assert.equal(two.answer, 'Change parameters')
    assert.notEqual(one.conversation_id, two.conversation_id)
    assert.equal(calls.length, 4)
    const freeTextReply = calls.find(c => c.params.message.parts.some((p: any) => p.data?.hitl_response?.custom_input === 'Change parameters'))
    assert.deepEqual(freeTextReply.params.message.parts[1].data.hitl_response.selected, [])
    await assert.rejects(runtime.call('owner-B', 'Cross-owner', one.conversation_id), /owned|conversation/i)
    assert.equal(calls.length, 4)
  } finally {
    await runtime.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
