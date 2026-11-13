import { A2aError, RemoteRpcError, requireBoolean, requireObject, requireString } from './errors.js'
import { readSse, type SseLimits } from './sse.js'
import type { HttpResponse } from './transport.js'

export interface HumanPrompt {
  hitlId: string
  question: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
  allowCustomInput: boolean
  metadata: Record<string, unknown>
}

export interface HumanAnswer {
  selected: string[]
  customInput: string
}

export interface TurnResult {
  taskId: string
  state: 'completed' | 'input-required'
  answer: string
  artifacts: Record<string, unknown>[]
  prompt?: HumanPrompt
}

function promptFrom(metadata: Record<string, unknown>): HumanPrompt {
  if (metadata.action_type !== 'ask_user_question') {
    throw new A2aError('UNSUPPORTED_ACTION', 'Only ask_user_question is supported; client_tool is never executed')
  }
  const options = metadata.options
  if (!Array.isArray(options)) throw new A2aError('INVALID_HITL', 'HITL options must be an array')
  const labels = new Set<string>()
  const normalized = options.map(value => {
    const option = requireObject(value, 'HITL option')
    const label = requireString(option.label, 'HITL option.label', 4096)
    if (labels.has(label)) throw new A2aError('INVALID_HITL', 'HITL option labels must be unique')
    labels.add(label)
    if (option.description !== undefined && typeof option.description !== 'string') {
      throw new A2aError('INVALID_HITL', 'HITL option description must be a string')
    }
    return { label, ...(option.description === undefined ? {} : { description: option.description as string }) }
  })
  const allowCustomInput = requireBoolean(metadata.allow_custom_input, 'HITL allow_custom_input')
  if (!normalized.length && !allowCustomInput) throw new A2aError('INVALID_HITL', 'HITL requires options or allowed custom input')
  if (normalized.length > 100) throw new A2aError('INVALID_HITL', 'Too many HITL options')
  if (metadata.questions !== undefined) {
    throw new A2aError('UNSUPPORTED_EXTENSION', 'Grouped questions require a dedicated protocol adapter; they cannot be flattened safely')
  }
  return {
    hitlId: requireString(metadata.hitl_id, 'HITL hitl_id', 1024),
    question: requireString(metadata.question, 'HITL question'),
    options: normalized,
    multiSelect: requireBoolean(metadata.multi_select, 'HITL multi_select'),
    allowCustomInput,
    metadata: structuredClone(metadata),
  }
}

export function validateHumanAnswer(prompt: HumanPrompt, input: HumanAnswer): HumanAnswer {
  const answer = requireObject(input, 'human answer')
  if (typeof answer.customInput !== 'string' || answer.customInput.length > 65_536) {
    throw new A2aError('INVALID_ANSWER', 'Human answer customInput must be a bounded string')
  }
  if (!Array.isArray(answer.selected) || !answer.selected.every(item => typeof item === 'string')) {
    throw new A2aError('INVALID_ANSWER', 'Human answer selected must be an array of exact option labels')
  }
  if (answer.customInput.trim()) {
    if (!prompt.allowCustomInput) throw new A2aError('INVALID_ANSWER', 'Custom input is not allowed for this question')
    return { selected: [], customInput: answer.customInput }
  }
  const selected = answer.selected as string[]
  if (!selected.length || (!prompt.multiSelect && selected.length !== 1)
    || new Set(selected).size !== selected.length
    || selected.some(label => !prompt.options.some(option => option.label === label))) {
    throw new A2aError('INVALID_ANSWER', 'Invalid human selection: use exact labels and the declared selection cardinality')
  }
  return { selected: [...selected], customInput: '' }
}

export async function readTurn(response: HttpResponse, requestId: string, previousTask: string | undefined,
  limits: SseLimits, onDelta?: (delta: string) => void): Promise<TurnResult> {
  let taskId = previousTask
  let terminal: TurnResult | undefined
  for await (const value of readSse(response, limits)) {
    const frame = requireObject(value, 'JSON-RPC frame')
    if (frame.jsonrpc !== '2.0' || frame.id !== requestId) {
      throw new A2aError('INVALID_RESPONSE', 'JSON-RPC version or response id does not match the request')
    }
    if (frame.error !== undefined) {
      const error = requireObject(frame.error, 'JSON-RPC error')
      if (!Number.isSafeInteger(error.code) || typeof error.message !== 'string') throw new A2aError('INVALID_RESPONSE', 'Invalid JSON-RPC error')
      throw new RemoteRpcError(error.code as number, error.message, error.data)
    }
    const result = requireObject(frame.result, 'JSON-RPC result')
    const id = requireString(result.id, 'task id', 1024)
    if (taskId !== undefined && taskId !== id) throw new A2aError('TASK_MISMATCH', 'Remote task id changed during the confirmation chain')
    taskId = id
    const status = requireObject(result.status, 'task status')
    const state = requireString(status.state, 'task state', 64)
    if (result.artifacts !== undefined && !Array.isArray(result.artifacts)) throw new A2aError('INVALID_RESPONSE', 'Task artifacts must be an array')
    const artifacts = (result.artifacts as unknown[] | undefined ?? []).map(item => requireObject(item, 'artifact'))
    if (state === 'failed' || state === 'canceled') {
      throw new A2aError('REMOTE_TASK_FAILED', `Remote task ${state}: ${JSON.stringify(status.message ?? 'No failure detail')}`)
    }
    if (state === 'working' || state === 'submitted') {
      if (terminal) throw new A2aError('INVALID_RESPONSE', 'Remote task continued after a terminal frame')
      for (const artifact of artifacts) {
        if (artifact.metadata !== undefined && requireObject(artifact.metadata, 'artifact metadata').kind === 'answer_delta') {
          if (!Array.isArray(artifact.parts)) throw new A2aError('INVALID_RESPONSE', 'answer_delta requires text parts')
          for (const part of artifact.parts) {
            const p = requireObject(part, 'text part')
            if (p.kind !== 'text' || typeof p.text !== 'string') throw new A2aError('INVALID_RESPONSE', 'answer_delta requires text parts')
            onDelta?.(p.text)
          }
        }
      }
      continue
    }
    let next: TurnResult
    if (state === 'input-required') {
      const hitls = artifacts.map(item => item.metadata === undefined ? undefined : requireObject(item.metadata, 'artifact metadata'))
        .filter(item => item?.kind === 'hitl_required')
      if (hitls.length !== 1) throw new A2aError('INVALID_HITL', 'input-required must contain exactly one HITL payload')
      if (artifacts.some(item => item.metadata !== undefined && requireObject(item.metadata, 'artifact metadata').kind === 'question_done')) {
        throw new A2aError('INVALID_HITL', 'HITL cannot be combined with question_done')
      }
      next = { taskId, state, answer: '', artifacts, prompt: promptFrom(hitls[0]!) }
    } else if (state === 'completed') {
      const answers: string[] = []
      for (const artifact of artifacts) {
        const meta = artifact.metadata === undefined ? undefined : requireObject(artifact.metadata, 'artifact metadata')
        if (meta?.kind === 'hitl_required') throw new A2aError('INVALID_HITL', 'HITL cannot be marked completed')
        if (meta?.kind === 'question_done') {
          if (meta.success === false) throw new A2aError('REMOTE_TASK_FAILED', 'Remote question_done reports failure')
          if (!Array.isArray(meta.results)) throw new A2aError('INVALID_RESPONSE', 'question_done requires results')
          for (const value of meta.results) {
            const row = requireObject(value, 'question_done result')
            if (row.success === false) throw new A2aError('REMOTE_TASK_FAILED', `Remote answer failed: ${JSON.stringify(row.error)}`)
            if (row.success !== true || typeof row.answer !== 'string') throw new A2aError('INVALID_RESPONSE', 'Successful final answer must be text')
            answers.push(row.answer)
          }
        } else if (artifact.parts !== undefined) {
          if (!Array.isArray(artifact.parts)) throw new A2aError('INVALID_RESPONSE', 'Artifact parts must be an array')
          for (const value of artifact.parts) {
            const part = requireObject(value, 'artifact part')
            if (part.kind === 'text' && typeof part.text === 'string') answers.push(part.text)
          }
        }
      }
      next = { taskId, state, answer: answers.join('\n'), artifacts }
    } else {
      throw new A2aError('UNSUPPORTED_STATE', `Unsupported remote task state: ${state}`)
    }
    if (terminal && JSON.stringify(terminal) !== JSON.stringify(next)) {
      throw new A2aError('CONFLICTING_FRAME', 'Conflicting terminal frames or changed HITL parameters in one response')
    }
    terminal = next
  }
  if (!terminal) throw new A2aError('MISSING_TERMINAL', 'SSE ended without completed or input-required terminal state')
  return terminal
}
