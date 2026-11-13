import z from '@deepseek-ai/schemastery'
import { A2aError, requireObject, requireString } from './errors.js'

export interface AgentConfig {
  id: string
  cardUrl: string
  description?: string
  rpcUrl?: string
  allowedRpcOrigins?: string[]
  headersEnv?: Record<string, string>
  allowPrivateNetwork?: boolean
  allowInsecureHttp?: boolean
}

export interface Config {
  agents: AgentConfig[]
  requestTimeoutMs?: number
  humanTimeoutMs?: number
  maxResponseBytes?: number
  maxFrameBytes?: number
  maxInputRounds?: number
  maxConversations?: number
  conversationTtlMs?: number
}

export interface ResolvedConfig {
  agents: readonly AgentConfig[]
  requestTimeoutMs: number
  humanTimeoutMs: number
  maxResponseBytes: number
  maxFrameBytes: number
  maxInputRounds: number
  maxConversations: number
  conversationTtlMs: number
}

export const Config: z<Config> = z.object({
  agents: z.array(z.object({
    id: z.string().required(),
    cardUrl: z.string().required(),
    description: z.string(),
    rpcUrl: z.string(),
    allowedRpcOrigins: z.array(z.string()).default([]),
    headersEnv: z.dict(z.string()).default({}),
    allowPrivateNetwork: z.boolean().default(false),
    allowInsecureHttp: z.boolean().default(false),
  })).default([]),
  requestTimeoutMs: z.number().step(1).min(100).max(600_000).default(90_000),
  humanTimeoutMs: z.number().step(1).min(10).max(3_600_000).default(300_000),
  maxResponseBytes: z.number().step(1).min(1024).max(16_777_216).default(2_097_152),
  maxFrameBytes: z.number().step(1).min(128).max(2_097_152).default(262_144),
  maxInputRounds: z.number().step(1).min(1).max(100).default(16),
  maxConversations: z.number().step(1).min(1).max(10_000).default(256),
  conversationTtlMs: z.number().step(1).min(1000).max(86_400_000).default(3_600_000),
})

export function configuredUrl(value: string, agent: AgentConfig): URL {
  let url: URL
  try { url = new URL(value) }
  catch (cause) { throw new A2aError('INVALID_URL', 'Agent URL must be absolute', { cause }) }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && agent.allowInsecureHttp === true)) {
    throw new A2aError('INSECURE_URL', 'Agent URL must use HTTPS; HTTP requires explicit administrator opt-in')
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new A2aError('INVALID_URL', 'Credentials, query parameters and fragments are forbidden in agent URLs; authentication must use headersEnv')
  }
  return url
}

function integer(value: unknown, fallback: number, key: string, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new A2aError('INVALID_CONFIG', `${key} must be an integer in [${min}, ${max}]`)
  }
  return value
}

export function resolveConfig(input: Config): ResolvedConfig {
  requireObject(input, 'config')
  if (!Array.isArray(input.agents)) throw new A2aError('INVALID_CONFIG', 'agents must be an array')
  const seen = new Set<string>()
  const agents = input.agents.map(candidate => {
    requireObject(candidate, 'agent')
    const id = requireString(candidate.id, 'agent.id', 64)
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || seen.has(id)) throw new A2aError('INVALID_CONFIG', 'Agent ids must be unique identifiers')
    seen.add(id)
    const agent = structuredClone(candidate)
    configuredUrl(requireString(agent.cardUrl, 'agent.cardUrl', 4096), agent)
    if (agent.rpcUrl !== undefined) configuredUrl(agent.rpcUrl, agent)
    for (const key of ['allowPrivateNetwork', 'allowInsecureHttp'] as const) {
      if (agent[key] !== undefined && typeof agent[key] !== 'boolean') throw new A2aError('INVALID_CONFIG', `${key} must be a boolean`)
    }
    if (agent.allowedRpcOrigins !== undefined) {
      if (!Array.isArray(agent.allowedRpcOrigins)) throw new A2aError('INVALID_CONFIG', 'allowedRpcOrigins must be an array')
      for (const origin of agent.allowedRpcOrigins) {
        const parsed = configuredUrl(origin, agent)
        if (parsed.origin !== origin) throw new A2aError('INVALID_CONFIG', 'allowedRpcOrigins must contain exact origins, without paths')
      }
    }
    if (agent.headersEnv !== undefined) {
      for (const [header, env] of Object.entries(requireObject(agent.headersEnv, 'headersEnv'))) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) || ['host', 'connection', 'content-length', 'transfer-encoding', 'content-type', 'accept', 'proxy-authorization'].includes(header.toLowerCase())) {
          throw new A2aError('INVALID_CONFIG', `Forbidden authentication header name: ${header}`)
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(requireString(env, 'header environment name', 256))) {
          throw new A2aError('INVALID_CONFIG', 'Header values must refer to environment variable names')
        }
      }
    }
    return agent
  })
  return {
    agents,
    requestTimeoutMs: integer(input.requestTimeoutMs, 90_000, 'requestTimeoutMs', 100, 600_000),
    humanTimeoutMs: integer(input.humanTimeoutMs, 300_000, 'humanTimeoutMs', 10, 3_600_000),
    maxResponseBytes: integer(input.maxResponseBytes, 2_097_152, 'maxResponseBytes', 1024, 16_777_216),
    maxFrameBytes: integer(input.maxFrameBytes, 262_144, 'maxFrameBytes', 128, 2_097_152),
    maxInputRounds: integer(input.maxInputRounds, 16, 'maxInputRounds', 1, 100),
    maxConversations: integer(input.maxConversations, 256, 'maxConversations', 1, 10_000),
    conversationTtlMs: integer(input.conversationTtlMs, 3_600_000, 'conversationTtlMs', 1000, 86_400_000),
  }
}

export function authenticationHeaders(agent: AgentConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, variable] of Object.entries(agent.headersEnv ?? {})) {
    const value = process.env[variable]
    if (!value || /[\r\n]/.test(value)) throw new A2aError('MISSING_CREDENTIAL', `Missing or invalid environment variable: ${variable}`)
    headers[name.toLowerCase()] = value
  }
  return headers
}
