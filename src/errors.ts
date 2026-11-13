export class A2aError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'A2aError'
  }
}

export class RemoteRpcError extends A2aError {
  constructor(readonly remoteCode: number, message: string, readonly data?: unknown) {
    super('REMOTE_RPC_ERROR', `Remote JSON-RPC error ${remoteCode}: ${message}`)
    this.name = 'RemoteRpcError'
  }
}

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new A2aError('INVALID_DATA', `${path} must be an object`)
  }
  return value as Record<string, unknown>
}

export function requireString(value: unknown, path: string, maximum = 65_536): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new A2aError('INVALID_DATA', `${path} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new A2aError('INVALID_DATA', `${path} must be a boolean`)
  return value
}

export function deadline(milliseconds: number, parent: AbortSignal): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new A2aError('DEADLINE', 'A2A operation deadline exceeded')), milliseconds)
  timer.unref()
  return { signal: AbortSignal.any([controller.signal, parent]), clear: () => clearTimeout(timer) }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason)
    if (signal.aborted) listener()
    else signal.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([promise, aborted]) }
  finally { signal.removeEventListener('abort', listener) }
}
