import { createHash, randomUUID } from 'node:crypto'
import { authenticationHeaders, configuredUrl, resolveConfig, type AgentConfig, type Config, type ResolvedConfig } from './config.js'
import { A2aError, abortable, deadline, requireObject, requireString } from './errors.js'
import { readTurn, validateHumanAnswer, type HumanAnswer, type HumanPrompt } from './protocol.js'
import { SafeHttpTransport, readBody, type HttpTransport } from './transport.js'

export type { HumanAnswer, HumanPrompt } from './protocol.js'
export type { Config, AgentConfig } from './config.js'
export { A2aError, RemoteRpcError } from './errors.js'
export { SafeHttpTransport } from './transport.js'

export interface CallInput {
  agentId: string
  ownerId: string
  message: string
  conversationId?: string
  signal?: AbortSignal
  onDelta?: (delta: string) => void
}

export interface CallResult {
  conversation_id: string
  task_id: string
  state: 'completed'
  answer: string
  artifacts: Record<string, unknown>[]
}

export interface ClientOptions {
  human(prompt: HumanPrompt, signal: AbortSignal): Promise<HumanAnswer>
  transport?: HttpTransport
}

interface Conversation {
  id: string
  owner: string
  agent: string
  remoteSession: string
  credentialHash: string
  endpoint?: URL
  updated: number
  busy: boolean
}

export class A2aClient {
  readonly config: ResolvedConfig
  private readonly transport: HttpTransport
  private readonly conversations = new Map<string, Conversation>()
  private readonly stopping = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(config: Config, private readonly options: ClientOptions) {
    this.config = resolveConfig(config)
    this.transport = options.transport ?? new SafeHttpTransport()
    if (typeof options.human !== 'function') throw new A2aError('NO_PROVIDER', 'A trusted human-input provider is required')
  }

  call(input: CallInput): Promise<CallResult> {
    const work = this.run(input)
    this.pending.add(work)
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work))
    return work
  }

  async dispose(): Promise<void> {
    this.stopping.abort(new A2aError('PLUGIN_DISPOSED', 'A2A plugin was disposed; no further reply will be sent'))
    await Promise.allSettled([...this.pending])
    this.conversations.clear()
  }

  private agent(id: string): AgentConfig {
    const agent = this.config.agents.find(item => item.id === id)
    if (!agent) throw new A2aError('UNKNOWN_AGENT', 'Agent is not in the administrator-configured allowlist')
    return agent
  }

  private async discover(agent: AgentConfig, signal: AbortSignal): Promise<URL> {
    if (agent.rpcUrl !== undefined) return configuredUrl(agent.rpcUrl, agent)
    const clock = deadline(this.config.requestTimeoutMs, signal)
    try {
      const response = await this.transport.request(configuredUrl(agent.cardUrl, agent), {
        method: 'GET', headers: { accept: 'application/json' }, signal: clock.signal, agent,
      })
      const raw = await readBody(response, this.config.maxResponseBytes, clock.signal)
      if (response.status !== 200) throw new A2aError('HTTP_ERROR', `Agent Card request failed with HTTP ${response.status}`)
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new A2aError('INVALID_CARD', 'Agent Card must use application/json')
      }
      let value: unknown
      try { value = JSON.parse(raw) }
      catch (cause) { throw new A2aError('INVALID_CARD', 'Agent Card must contain valid JSON', { cause }) }
      const card = requireObject(value, 'Agent Card')
      if (card.supportedInterfaces !== undefined && !Array.isArray(card.supportedInterfaces)) {
        throw new A2aError('INVALID_CARD', 'supportedInterfaces must be an array')
      }
      const interfaces = (card.supportedInterfaces as unknown[] | undefined ?? []).map(value => requireObject(value, 'supported interface'))
      const selected = interfaces.find(item => item.protocolBinding === 'JSONRPC' && typeof item.url === 'string' && item.url.trim())
      const endpoint = configuredUrl(requireString(selected?.url ?? card.url, 'Card JSONRPC URL', 4096), agent)
      const origins = new Set([configuredUrl(agent.cardUrl, agent).origin, ...(agent.allowedRpcOrigins ?? [])])
      if (!origins.has(endpoint.origin)) throw new A2aError('ENDPOINT_DENIED', 'Agent Card RPC origin is not explicitly allowed')
      return endpoint
    } finally { clock.clear() }
  }

  private conversation(input: CallInput, agent: AgentConfig, credentialHash: string): Conversation {
    const now = Date.now()
    for (const [id, item] of this.conversations) {
      if (!item.busy && now - item.updated >= this.config.conversationTtlMs) this.conversations.delete(id)
    }
    if (input.conversationId !== undefined) {
      const existing = this.conversations.get(input.conversationId)
      if (!existing || existing.owner !== input.ownerId || existing.agent !== agent.id || existing.credentialHash !== credentialHash) {
        throw new A2aError('CONVERSATION_DENIED', 'Unknown, expired or differently owned conversation')
      }
      if (existing.busy) throw new A2aError('CONVERSATION_BUSY', 'Another call is still using this conversation')
      return existing
    }
    if (this.conversations.size >= this.config.maxConversations) {
      throw new A2aError('CAPACITY', 'Conversation capacity exceeded; no existing conversation was evicted')
    }
    const id = randomUUID()
    const created: Conversation = { id, owner: input.ownerId, agent: agent.id, remoteSession: randomUUID(),
      credentialHash, updated: now, busy: false }
    this.conversations.set(id, created)
    return created
  }

  private async run(input: CallInput): Promise<CallResult> {
    const signal = input.signal === undefined ? this.stopping.signal : AbortSignal.any([input.signal, this.stopping.signal])
    signal.throwIfAborted()
    requireString(input.ownerId, 'ownerId', 1024)
    requireString(input.message, 'message')
    const agent = this.agent(input.agentId)
    const auth = authenticationHeaders(agent)
    const credentialHash = createHash('sha256').update(JSON.stringify(Object.entries(auth).sort())).digest('hex')
    const conversation = this.conversation(input, agent, credentialHash)
    conversation.busy = true
    try {
      conversation.endpoint ??= await this.discover(agent, signal)
      let parts: Record<string, unknown>[] = [{ kind: 'text', text: input.message }]
      let taskId: string | undefined
      let inputRounds = 0
      const consumed = new Set<string>()
      while (true) {
        signal.throwIfAborted()
        const requestId = randomUUID()
        const payload = {
          jsonrpc: '2.0', id: requestId, method: 'tasks/sendSubscribe',
          params: { message: { role: 'user', parts, metadata: { sessionId: conversation.remoteSession } },
            configuration: { acceptedOutputModes: ['text'] } },
        }
        const clock = deadline(this.config.requestTimeoutMs, signal)
        let turn
        try {
          const response = await this.transport.request(conversation.endpoint, {
            method: 'POST', headers: { ...auth, 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify(payload), signal: clock.signal, agent,
          })
          if (response.status !== 200) {
            await readBody(response, Math.min(this.config.maxResponseBytes, 65_536), clock.signal)
            throw new A2aError('HTTP_ERROR', `A2A request failed with HTTP ${response.status}; no retry was attempted`)
          }
          turn = await readTurn(response, requestId, taskId, { signal: clock.signal,
            maxResponseBytes: this.config.maxResponseBytes, maxFrameBytes: this.config.maxFrameBytes }, input.onDelta)
          clock.signal.throwIfAborted()
        } finally { clock.clear() }
        signal.throwIfAborted()
        taskId = turn.taskId
        if (turn.state === 'completed') {
          conversation.updated = Date.now()
          return { conversation_id: conversation.id, task_id: taskId, state: 'completed', answer: turn.answer, artifacts: turn.artifacts }
        }
        const prompt = turn.prompt
        if (!prompt) throw new A2aError('INVALID_HITL', 'input-required is missing its parsed prompt')
        if (consumed.has(prompt.hitlId)) throw new A2aError('HITL_REPLAY', 'The HITL node was already consumed; replay is forbidden')
        if (++inputRounds > this.config.maxInputRounds) throw new A2aError('INPUT_LIMIT', 'Too many human-input rounds')
        const humanClock = deadline(this.config.humanTimeoutMs, signal)
        let answer: HumanAnswer
        try {
          const response = await abortable(this.options.human(structuredClone(prompt), humanClock.signal), humanClock.signal)
          humanClock.signal.throwIfAborted()
          answer = validateHumanAnswer(prompt, response)
        } finally { humanClock.clear() }
        signal.throwIfAborted()
        consumed.add(prompt.hitlId)
        parts = [
          { kind: 'text', text: answer.customInput || answer.selected.join(' / ') },
          { kind: 'data', data: { hitl_response: { hitl_id: prompt.hitlId, selected: answer.selected, custom_input: answer.customInput } } },
        ]
      }
    } catch (error) {
      this.conversations.delete(conversation.id)
      throw error
    } finally { conversation.busy = false }
  }
}
