import { chaosPoint } from './registry.js'

/**
 * Outbound dependency fault points (#2834): the AI gateway, the OIDC provider and Microsoft
 * Graph. Each call site asks once; unarmed, every helper answers at once without awaiting.
 * The errors thrown are the shapes the real failures take, so the code under test reacts the
 * way it would in production:
 *   ai.call     `AI gateway <status>: …` (GatewayHttpError's message) → withModelFallback for a
 *               refused model id, the provider-failure fallback / "AI is unavailable" 503 for 5xx;
 *               a timeout is the SDK's "Request timed out."
 *   oidc.call   a fetch that never connects (discovery or the token endpoint), or a slow one
 *   graph.call  the same for Microsoft Graph and its token endpoint
 */

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref?.()
  })

/** A fetch that could not connect, as undici throws it. */
export function unreachableError(host: string): Error {
  const err = new TypeError('fetch failed') as TypeError & { cause?: unknown }
  err.cause = Object.assign(new Error(`connect ECONNREFUSED ${host}`), { code: 'ECONNREFUSED' })
  return err
}

/** The gateway's non-2xx error, without importing the AI client (no cycle). */
export function gatewayError(status: number, detail: string): Error {
  return Object.assign(new Error(`AI gateway ${status}: ${detail}`), {
    name: 'GatewayHttpError',
    status,
    detail
  })
}

/** Act at `ai.call` for one model. `pinned` = the model the caller asked for (first in the chain). */
export async function aiCallChaos(model: string, pinned: boolean): Promise<void> {
  const f = chaosPoint('ai.call')
  if (!f) return
  const delay = Number(f.params.delay_ms) || 0
  switch (f.params.mode) {
    case 'slow':
      await sleep(delay)
      return
    case 'timeout':
      await sleep(delay)
      throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })
    case 'model_refused':
      // Only the pinned model is refused: the fallback chain's next model must answer.
      if (!pinned) return
      throw gatewayError(404, `The model "${model}" does not exist or is not available`)
    default:
      throw gatewayError(Number(f.params.status) || 503, 'Service Unavailable')
  }
}

type AnyFn = (...args: unknown[]) => unknown

/**
 * Wrap an AI client so its `messages.create` / `createStream` pass `ai.call` first. Unarmed,
 * the original method is called directly (its own promise type, nothing awaited in between).
 */
export function withAiChaos<T extends object>(client: T, model: string, pinned: boolean): T {
  const messages = (client as { messages?: Record<string, unknown> }).messages
  if (!messages) return client
  const wrap = (name: 'create' | 'createStream'): AnyFn | null => {
    const orig = messages[name]
    if (typeof orig !== 'function') return null
    return (...args: unknown[]) =>
      chaosPoint('ai.call')
        ? aiCallChaos(model, pinned).then(() => (orig as AnyFn).apply(messages, args))
        : (orig as AnyFn).apply(messages, args)
  }
  const create = wrap('create')
  const createStream = wrap('createStream')
  const m = new Proxy(messages, {
    get(t, p) {
      if (p === 'create' && create) return create
      if (p === 'createStream' && createStream) return createStream
      const v = Reflect.get(t, p, t)
      return typeof v === 'function' ? v.bind(t) : v
    }
  })
  return new Proxy(client, {
    get(t, p) {
      if (p === 'messages') return m
      const v = Reflect.get(t, p, t)
      return typeof v === 'function' ? v.bind(t) : v
    }
  })
}

/** Act at `oidc.call` for one step of the sign-in: `discovery` (metadata) or `token` (code grant). */
export async function oidcChaos(step: 'discovery' | 'token'): Promise<void> {
  const f = chaosPoint('oidc.call')
  if (!f) return
  if (f.params.step !== 'both' && f.params.step !== step) return
  if (f.params.mode === 'slow') {
    await sleep(Number(f.params.delay_ms) || 0)
    return
  }
  throw unreachableError('identity provider')
}

/**
 * Act at `graph.call` (Microsoft Graph and its token endpoint). `timeoutMs` is the caller's own
 * fetch timeout: a slow Graph past it fails the way the aborted fetch would.
 */
export async function graphChaos(timeoutMs = 8000): Promise<void> {
  const f = chaosPoint('graph.call')
  if (!f) return
  if (f.params.mode === 'slow') {
    const delay = Number(f.params.delay_ms) || 0
    await sleep(Math.min(delay, timeoutMs))
    if (delay >= timeoutMs)
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError'
      })
    return
  }
  throw unreachableError('graph.microsoft.com')
}

/** Does this error say the identity provider could not be reached (vs a refused sign-in)? */
export function idpUnreachable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } }
  const text = `${e?.code ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|timed? ?out|socket hang up|network|aborted/i.test(
    text
  )
}
