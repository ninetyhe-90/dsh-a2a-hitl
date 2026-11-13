import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import ipaddr from 'ipaddr.js'
import type { AgentConfig } from './config.js'
import { A2aError, abortable } from './errors.js'

export interface HttpResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export interface HttpRequest {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
  agent: AgentConfig
}

export interface HttpTransport {
  request(url: URL, input: HttpRequest): Promise<HttpResponse>
}

export function checkAddress(address: string, allowPrivate: boolean): void {
  let ip: ipaddr.IPv4 | ipaddr.IPv6
  try { ip = ipaddr.process(address) }
  catch (cause) { throw new A2aError('NETWORK_DENIED', 'Invalid resolved network address', { cause }) }
  const range = ip.range()
  if (['unspecified', 'broadcast', 'multicast', 'linkLocal'].includes(range)) {
    throw new A2aError('NETWORK_DENIED', 'Special-use and metadata network addresses are forbidden')
  }
  const extraInternal = ip.kind() === 'ipv4' && [9, 11, 21, 30].includes(ip.toByteArray()[0]!)
  if (!allowPrivate && (range !== 'unicast' || extraInternal)) {
    throw new A2aError('NETWORK_DENIED', 'Private or reserved network address requires explicit administrator opt-in')
  }
  if (ip.kind() === 'ipv6' && ['ipv4Mapped', 'rfc6052', 'rfc6145', '6to4', 'teredo'].includes(range)) {
    throw new A2aError('NETWORK_DENIED', 'IPv6 translation and tunnel addresses are forbidden')
  }
}

export class SafeHttpTransport implements HttpTransport {
  async request(url: URL, input: HttpRequest): Promise<HttpResponse> {
    input.signal.throwIfAborted()
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const literal = isIP(hostname)
    const addresses = literal
      ? [{ address: hostname, family: literal }]
      : await abortable(lookup(hostname, { all: true, verbatim: true }), input.signal)
    if (!addresses.length) throw new A2aError('NETWORK_DENIED', 'Agent hostname resolved to no addresses')
    for (const address of addresses) checkAddress(address.address, input.agent.allowPrivateNetwork === true)
    const pinned = addresses[0]!
    input.signal.throwIfAborted()
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = request(url, {
        method: input.method,
        headers: input.headers,
        signal: input.signal,
        family: pinned.family,
        agent: false,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      }, response => {
        const status = response.statusCode
        if (status === undefined) {
          response.destroy()
          reject(new A2aError('HTTP_ERROR', 'Agent response has no status code'))
          return
        }
        if (status >= 300 && status < 400) {
          response.destroy()
          reject(new A2aError('REDIRECT_DENIED', 'Agent redirects are forbidden; configure the final endpoint explicitly'))
          return
        }
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(key, item)
          else if (value !== undefined) headers.set(key, value)
        }
        resolve({ status, headers, body: Readable.toWeb(response) as ReadableStream<Uint8Array> })
      })
      req.once('error', reject)
      req.end(input.body)
    })
  }
}

export async function readBody(response: HttpResponse, maximum: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new A2aError('INVALID_RESPONSE', 'Agent response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  let complete = false
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) { complete = true; break }
      bytes += chunk.value.byteLength
      if (bytes > maximum) throw new A2aError('RESPONSE_TOO_LARGE', 'Agent response exceeds the configured byte limit')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    try { if (!complete) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}
