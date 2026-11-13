import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { ToolsService, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { UserQuestionService, type AskUserQuestionRequest, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import * as plugin from '../src/index.js'
import type { Config } from '../src/config.js'

export async function createLocalRuntime(config: Config,
  human: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>) {
  const ctx = new Context()
  const agents = new Map<string, Agent>()
  ctx.provide('agents', { get: (id: string) => agents.get(id) })
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const tools = ctx.plugin(ToolsService)
  const questions = ctx.plugin(UserQuestionService)
  await tools.inertia
  await questions.inertia
  ctx.on('user-questions/request', (request, _next) => human(request), { global: true })
  const loaded = ctx.plugin(plugin, config)
  await loaded.inertia
  if (loaded.state !== 2 || tools.state !== 2 || questions.state !== 2) throw new Error('Local DSH capability runtime did not activate')
  return {
    ctx,
    async call(owner: string, message: string, conversationId?: string, signal = new AbortController().signal) {
      let agent = agents.get(owner)
      if (!agent) {
        agent = { id: owner, session: { header: { origin: 'user' } }, ctx } as unknown as Agent
        agents.set(owner, agent)
      }
      const definition = ctx.tools.get('a2a_call')
      if (!definition) throw new Error('A2A tool is not registered')
      const exec = { agent, signal } as ToolRunContext
      const result = await definition.execute({ agent: 'example', message, ...(conversationId === undefined ? {} : { conversation_id: conversationId }) }, exec)
      if (typeof result !== 'string') throw new Error('A2A tool did not return its declared canonical output')
      return JSON.parse(result)
    },
    async close() {
      await loaded.dispose()
      await questions.dispose()
      await tools.dispose()
      await ctx.fiber.dispose()
      agents.clear()
    },
  }
}
