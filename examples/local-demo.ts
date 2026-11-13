import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createLocalRuntime } from './local-runtime.js'
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

type Pending = { request: AskUserQuestionRequest; resolve(answer: AskUserQuestionAnswer): void; reject(error: Error): void; cleanup(): void }
type RemoteTask = { task: string; node: string; note: string }

const tasks = new Map<string, RemoteTask>()
const log: { step: string; detail: unknown }[] = []
let mockWrites = 0
let state: 'idle' | 'working' | 'input-required' | 'completed' | 'error' = 'idle'
let result: unknown
let pending: Pending | undefined
let active: Promise<unknown> | undefined
const cookie = `dsh_a2a_local=${randomUUID()}`

function record(step: string, detail: unknown) {
  if (log.length >= 128) log.shift()
  log.push({ step, detail })
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}
async function body(req: IncomingMessage) {
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString()
    if (Buffer.byteLength(text) > 8192) throw new Error('Request body is too large')
  }
  return JSON.parse(text)
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind a loopback port')
  return `http://127.0.0.1:${address.port}`
}
function hitl(task: RemoteTask) {
  return { id: task.task, status: { state: 'input-required' }, artifacts: [{ metadata: {
    kind: 'hitl_required', hitl_id: task.node, action_type: 'ask_user_question',
    question: '是否确认这次模拟修改？', options: [{ label: '确认模拟修改' }, { label: '取消' }],
    multi_select: false, allow_custom_input: true, arguments: { operation: 'simulation_only', note: task.note },
  } }] }
}
function completed(task: RemoteTask, answer: string) {
  return { id: task.task, status: { state: 'completed' }, artifacts: [{ metadata: {
    kind: 'question_done', success: true, results: [{ success: true, answer }],
  } }] }
}

const remote = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      json(res, 200, { name: 'Local example agent', supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: `${remoteUrl}/rpc` }] })
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { json(res, 404, { error: 'Unknown simulated endpoint' }); return }
    const request = await body(req)
    if (request.method !== 'tasks/sendSubscribe') throw new Error('Unsupported simulated method')
    const message = request.params.message
    const session: string = message.metadata.sessionId
    const reply = message.parts.find((p: { kind: string }) => p.kind === 'data')?.data.hitl_response
    let response
    if (!reply) {
      if (tasks.size >= 64) throw new Error('Simulation task limit reached')
      const task = { task: randomUUID(), node: randomUUID(), note: message.parts[0].text }
      tasks.set(session, task)
      record('External A2A request', { sessionId: session, taskId: task.task })
      response = hitl(task)
    } else {
      const task = tasks.get(session)
      if (!task || task.node !== reply.hitl_id) throw new Error('Reply does not match the original session and pending node')
      record('Structured HITL response', reply)
      if (reply.custom_input) {
        if (reply.selected.length) throw new Error('Custom input must not authorize a selection')
        task.note = reply.custom_input
        task.node = randomUUID()
        response = hitl(task)
      } else if (reply.selected.length === 1 && reply.selected[0] === '取消') {
        tasks.delete(session)
        response = completed(task, '用户取消，模拟写入次数未增加。没有访问真实业务接口。')
      } else if (reply.selected.length === 1 && reply.selected[0] === '确认模拟修改') {
        mockWrites++
        tasks.delete(session)
        response = completed(task, '模拟修改完成，仅增加内存计数。没有访问真实业务接口。')
      } else throw new Error('Invalid simulated answer')
    }
    record('External SSE frame', response)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: response })}\n\n`)
  })().catch(error => json(res, 400, { error: String(error) }))
})
const remoteUrl = await listen(remote)
const runtime = await createLocalRuntime({ agents: [{ id: 'example', cardUrl: `${remoteUrl}/.well-known/agent-card.json`, allowPrivateNetwork: true, allowInsecureHttp: true }] }, async request => {
  if (pending) throw new Error('A human question is already pending')
  request.signal?.throwIfAborted()
  state = 'input-required'
  record('DSH native userQuestions.ask', { questionId: request.questions[0]?.id, callerId: request.agent?.id })
  return new Promise((resolve, reject) => {
    const aborted = () => {
      pending = undefined
      reject(new Error('Local human interaction was aborted'))
    }
    request.signal?.addEventListener('abort', aborted, { once: true })
    pending = { request, resolve, reject, cleanup: () => request.signal?.removeEventListener('abort', aborted) }
  })
})
const html = await readFile(new URL('./local-demo.html', import.meta.url))
const web = createServer((req, res) => {
  void (async () => {
    if (req.headers.host !== new URL(webUrl).host) { json(res, 403, { error: 'Only the local demo origin is allowed' }); return }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'set-cookie': `${cookie}; HttpOnly; SameSite=Strict; Path=/`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      })
      res.end(html)
      return
    }
    if (!req.headers.cookie?.split(';').some(item => item.trim() === cookie)) { json(res, 403, { error: 'Open the local demo first' }); return }
    if (req.method === 'GET' && req.url === '/state') {
      json(res, 200, { state, question: pending?.request.questions[0], mockWrites, result, log })
      return
    }
    if (req.method !== 'POST' || req.headers.origin !== webUrl || req.headers['content-type'] !== 'application/json') {
      json(res, 403, { error: 'Only same-origin JSON actions are allowed' }); return
    }
    if (req.url === '/start') {
      if (state === 'working' || state === 'input-required') throw new Error('A simulation is already active')
      const input = await body(req)
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4096) throw new Error('Message must be a bounded non-empty string')
      state = 'working'
      result = undefined
      active = runtime.call('local-browser', input.message).then(value => { result = value; state = 'completed' }, error => {
        state = 'error'; result = { error: String(error) }; record('Local error', String(error))
      })
      json(res, 202, { started: true })
    } else if (req.url === '/answer') {
      const input = await body(req)
      const current = pending
      if (!current || input.id !== current.request.questions[0]?.id) throw new Error('Answer does not match the pending local question')
      if (!Array.isArray(input.selected) || !input.selected.every((label: unknown) => typeof label === 'string') || typeof input.custom !== 'string') throw new Error('Invalid answer shape')
      pending = undefined
      current.cleanup()
      state = 'working'
      current.resolve({ answers: [{ id: input.id, selected: input.selected, custom: input.custom }] })
      json(res, 202, { answered: true })
    } else json(res, 404, { error: 'Unknown local action' })
  })().catch(error => json(res, 400, { error: String(error) }))
})
const webUrl = await listen(web)
console.log(`LOCAL_DEMO_URL=${webUrl}`)
console.log('This demo loads real Cordis tools and DSH userQuestions services, with a simulated Agent lifecycle and local A2A server. No model or online business service is called.')

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  pending?.cleanup()
  pending?.reject(new Error('Local demo stopped'))
  pending = undefined
  await runtime.close()
  await active
  for (const server of [web, remote]) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1 }) })
