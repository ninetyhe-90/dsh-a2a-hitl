import { A2aError, abortable } from './errors.js'
import type { HttpResponse } from './transport.js'

export interface SseLimits {
  maxResponseBytes: number
  maxFrameBytes: number
  signal: AbortSignal
}

export async function* readSse(response: HttpResponse, limits: SseLimits): AsyncGenerator<unknown> {
  if (!response.body) throw new A2aError('INVALID_RESPONSE', 'SSE response has no body')
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
    await response.body.cancel()
    throw new A2aError('INVALID_RESPONSE', 'A2A response must use text/event-stream')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data: string[] = []
  let eventBytes = 0
  let totalBytes = 0
  let complete = false
  const line = (value: string): string | undefined => {
    limits.signal.throwIfAborted()
    eventBytes += Buffer.byteLength(value, 'utf8') + 1
    if (eventBytes > limits.maxFrameBytes) throw new A2aError('FRAME_TOO_LARGE', 'SSE frame exceeds the configured byte limit')
    if (!value) {
      const payload = data.length ? data.join('\n') : undefined
      data = []
      eventBytes = 0
      return payload
    }
    if (value.startsWith(':')) return undefined
    const separator = value.indexOf(':')
    const field = separator < 0 ? value : value.slice(0, separator)
    let body = separator < 0 ? '' : value.slice(separator + 1)
    if (body.startsWith(' ')) body = body.slice(1)
    if (field === 'data') data.push(body)
    return undefined
  }
  const parse = (payload: string): unknown => {
    try { return JSON.parse(payload) }
    catch (cause) { throw new A2aError('INVALID_RESPONSE', 'SSE data must contain valid JSON', { cause }) }
  }
  try {
    while (true) {
      const chunk = await abortable(reader.read(), limits.signal)
      if (chunk.done) { buffer += decoder.decode(); complete = true }
      else {
        totalBytes += chunk.value.byteLength
        if (totalBytes > limits.maxResponseBytes) throw new A2aError('RESPONSE_TOO_LARGE', 'SSE response exceeds the configured byte limit')
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      let end: number
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === '\r' && end === buffer.length - 1 && !complete) break
        const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1
        const payload = line(buffer.slice(0, end))
        buffer = buffer.slice(end + width)
        if (payload !== undefined) yield parse(payload)
      }
      if (Buffer.byteLength(buffer, 'utf8') + eventBytes > limits.maxFrameBytes) {
        throw new A2aError('FRAME_TOO_LARGE', 'SSE line exceeds the configured byte limit')
      }
      if (complete) {
        if (buffer) line(buffer)
        const payload = line('')
        if (payload !== undefined) yield parse(payload)
        break
      }
    }
  } finally {
    try { if (!complete) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}
