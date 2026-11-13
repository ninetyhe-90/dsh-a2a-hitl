import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { createNativeHumanBridge, apply } from '../src/index.js'
import type { HumanPrompt } from '../src/client.js'

const prompt: HumanPrompt = {
  hitlId: 'external:1', question: 'Confirm this change?', options: [{ label: 'Confirm' }, { label: 'Cancel' }],
  multiSelect: false, allowCustomInput: true, metadata: { arguments: { note: 'Example only' } },
}

const agent = { id: 'calling-session' } as Agent

test('native bridge asks actual DSH capability with exact caller and preserves parameter detail', async () => {
  let request: any
  const human = createNativeHumanBridge({ ask: async input => {
    request = input
    return { answers: [{ id: input.questions[0]!.id, selected: ['Cancel'] }] }
  } }, () => agent)
  const signal = new AbortController().signal
  assert.deepEqual(await human(prompt, signal), { selected: ['Cancel'], customInput: '' })
  assert.equal(request.agent, agent)
  assert.equal(request.signal, signal)
  assert.equal(request.questions[0].question, prompt.question)
  assert.deepEqual(request.questions[0].options, prompt.options)
  assert.match(request.questions[0].detail, /Example only/)
  assert.notEqual(request.questions[0].id, prompt.hitlId)
})

test('native bridge fails closed for missing UI, wrong node, skipped question and cancellation', async () => {
  const signal = new AbortController().signal
  for (const result of [
    { answers: [] },
    { answers: [{ id: 'wrong', selected: ['Confirm'] }] },
    { answers: [{ id: 'wrong', selected: ['Confirm'] }, { id: 'wrong', selected: ['Cancel'] }] },
  ]) {
    const bridge = createNativeHumanBridge({ ask: async () => result }, () => agent)
    await assert.rejects(bridge(prompt, signal), /answer|question/i)
  }
  await assert.rejects(createNativeHumanBridge({ ask: async () => { throw new Error('NO_PROVIDER') } }, () => agent)(prompt, signal), /NO_PROVIDER/)
  await assert.rejects(createNativeHumanBridge({ ask: async () => { throw new Error('must not ask') } }, () => undefined)(prompt, signal), /calling agent/i)
})

test('trusted free text is mapped, but never exposed as a model-answer tool', async () => {
  const bridge = createNativeHumanBridge({ ask: async input => ({ answers: [{ id: input.questions[0]!.id, selected: ['Confirm'], custom: 'Change request' }] }) }, () => agent)
  assert.deepEqual(await bridge(prompt, new AbortController().signal), { selected: ['Confirm'], customInput: 'Change request' })
  const ctx = new Context()
  const definitions: any[] = []
  ctx.provide('tools', { register: (definition: any) => { definitions.push(definition); return () => {} } })
  ctx.provide('userQuestions', { ask: async () => { throw new Error('must not ask') } })
  const plugin = ctx.plugin(apply, { agents: [] })
  await plugin.inertia
  assert.equal(plugin.state, 2)
  assert.deepEqual(definitions.map(d => d.name), ['a2a_list_agents', 'a2a_call'])
  const caller = definitions.find(d => d.name === 'a2a_call')
  assert.equal(caller.parameters.properties.selected, undefined)
  assert.equal(caller.parameters.properties.hitl_response, undefined)
  await assert.rejects(caller.execute({ agent: 'example', message: 'Example' }, { signal: new AbortController().signal }), /caller|agent/i)
  await plugin.dispose()
  await ctx.fiber.dispose()
})
