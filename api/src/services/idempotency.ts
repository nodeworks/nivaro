import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Inbound idempotency keys.
 *
 * A caller that sends `Idempotency-Key: <anything unique>` on a write gets
 * at-most-once behaviour for 24 hours: the first request runs, and a repeat
 * of the SAME request under the same key returns the first answer instead of
 * writing again. That is what makes a partner's retry-on-timeout safe — a
 * create that landed but whose response was lost no longer mints a twin.
 *
 * Rules:
 *  - Keys are scoped to the authenticated caller. One caller can never read
 *    another's stored answer, and the lookup runs AFTER authentication, so a
 *    revoked credential gets a 401, not a replay.
 *  - Only successful answers are kept. A failed request releases its key, so
 *    the caller may fix the payload and retry under the same key.
 *  - The same key with a DIFFERENT request (path or body) is refused 422 —
 *    that is a client bug, and replaying the old answer would hide it.
 *  - A repeat that arrives while the first is still running is refused 409
 *    with Retry-After; it never runs the write a second time.
 *  - Redis unavailable = the header is ignored (fail open): the write runs
 *    exactly as it would without a key.
 */

const DONE_TTL_S = Math.max(60, Number(process.env.IDEMPOTENCY_TTL_SECONDS) || 86_400)
/** How long an unfinished request holds its key. Longer than any real write;
 *  a process that died mid-request frees the key when this lapses. */
const PENDING_TTL_S = 900
const MAX_STORED_BYTES = 1_000_000
const KEY_RE = /^[\x21-\x7E]{1,200}$/

interface StoredPending {
  state: 'pending'
  fingerprint: string
  started_at: string
}
interface StoredDone {
  state: 'done'
  fingerprint: string
  status: number
  body: string | null
  content_type: string | null
  finished_at: string
}
type Stored = StoredPending | StoredDone

interface Claim {
  redisKey: string
  fingerprint: string
  scope: string
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: Claim
  }
}

function sha(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

/** Stable JSON: key order must not change the fingerprint. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return sha(`${method.toUpperCase()}\n${path}\n${stableStringify(body ?? null)}`)
}

function callerScope(req: FastifyRequest): string | null {
  const u = req.user as ({ id?: string; api_key_id?: number | string | null } & object) | undefined
  if (!u?.id) return null
  return u.api_key_id != null ? `k${u.api_key_id}` : `u${String(u.id).toUpperCase()}`
}

/** A GraphQL body is only worth deduplicating when it writes. */
export function isGraphQLMutation(query: unknown): boolean {
  if (typeof query !== 'string') return false
  const stripped = query.replace(/#[^\n]*/g, '').trimStart()
  return /^mutation\b/.test(stripped)
}

/**
 * Claim the request's key. Returns a reply when the request must NOT run
 * (replay, in progress, key reuse, bad key) — the caller returns it as is.
 * Returns null when the handler should proceed.
 */
export async function beginIdempotency(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string
): Promise<FastifyReply | null> {
  const raw = req.headers['idempotency-key']
  if (raw == null || raw === '') return null
  if (req.method !== 'POST') return null
  const key = Array.isArray(raw) ? raw[0] : raw
  if (!KEY_RE.test(key)) {
    return reply.code(400).send({
      error: 'Idempotency-Key must be 1–200 printable characters with no spaces',
      code: 'IDEMPOTENCY_KEY_INVALID'
    })
  }
  const caller = callerScope(req)
  if (!caller) return null
  const redis = (req.server as FastifyInstance & { redis?: import('ioredis').Redis }).redis
  if (!redis) return null

  const path = (req.raw.url ?? req.url).split('?')[0]
  const fingerprint = requestFingerprint(req.method, path, req.body)
  const redisKey = `nvr:idem:${caller}:${sha(key)}`

  try {
    const pending: StoredPending = {
      state: 'pending',
      fingerprint,
      started_at: new Date().toISOString()
    }
    const claimed = await redis.set(redisKey, JSON.stringify(pending), 'EX', PENDING_TTL_S, 'NX')
    if (claimed === 'OK') {
      req.idempotency = { redisKey, fingerprint, scope }
      return null
    }
    const existingRaw = await redis.get(redisKey)
    if (!existingRaw) {
      // Expired between the two calls — claim again, once.
      const again = await redis.set(redisKey, JSON.stringify(pending), 'EX', PENDING_TTL_S, 'NX')
      if (again === 'OK') {
        req.idempotency = { redisKey, fingerprint, scope }
        return null
      }
      return reply.code(409).header('retry-after', '2').send({
        error: 'A request with this Idempotency-Key is still running',
        code: 'IDEMPOTENCY_IN_PROGRESS'
      })
    }
    const existing = JSON.parse(existingRaw) as Stored
    if (existing.fingerprint !== fingerprint) {
      return reply.code(422).send({
        error:
          'This Idempotency-Key was already used for a different request. Use a new key for a new request.',
        code: 'IDEMPOTENCY_KEY_REUSED'
      })
    }
    if (existing.state === 'pending') {
      return reply.code(409).header('retry-after', '2').send({
        error: 'A request with this Idempotency-Key is still running',
        code: 'IDEMPOTENCY_IN_PROGRESS',
        started_at: existing.started_at
      })
    }
    reply.header('idempotent-replay', 'true')
    reply.header('idempotency-original-at', existing.finished_at)
    reply.code(existing.status)
    if (existing.content_type) reply.header('content-type', existing.content_type)
    if (existing.body == null) {
      return reply.send({
        replayed: true,
        body_omitted: true,
        note: 'The original response was too large to keep. The write happened once; read the record to see it.'
      })
    }
    return reply.send(existing.body)
  } catch (err) {
    req.log.warn({ err }, 'idempotency lookup failed — request runs without it')
    return null
  }
}

/** preHandler form for route plugins that authenticate in a hook. */
export function idempotencyPreHandler(scope: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Returning the reply tells fastify the request is answered; the handler
    // is skipped.
    const answered = await beginIdempotency(req, reply, scope)
    if (answered) return answered as unknown as undefined
  }
}

function payloadToString(payload: unknown): string | null {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  if (Buffer.isBuffer(payload)) return payload.toString('utf8')
  return null // a stream — never stored
}

/**
 * Global onSend: a request that claimed a key stores its answer (success) or
 * releases the key (anything else). Registered once for the whole app; it is
 * a no-op for requests that carry no claim.
 */
export function registerIdempotencyStore(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const claim = req.idempotency
    if (!claim) return payload
    req.idempotency = undefined
    const redis = (app as FastifyInstance & { redis?: import('ioredis').Redis }).redis
    if (!redis) return payload
    try {
      const status = reply.statusCode
      const text = payloadToString(payload)
      let ok = status >= 200 && status < 300 && text !== null
      // GraphQL answers 200 for a refused mutation; the errors array decides.
      if (ok && claim.scope === 'graphql' && text) {
        try {
          const parsed = JSON.parse(text) as { errors?: unknown[] }
          if (Array.isArray(parsed.errors) && parsed.errors.length > 0) ok = false
        } catch {
          ok = false
        }
      }
      if (!ok) {
        await redis.del(claim.redisKey)
        return payload
      }
      const ct = reply.getHeader('content-type')
      const done: StoredDone = {
        state: 'done',
        fingerprint: claim.fingerprint,
        status,
        body: text != null && Buffer.byteLength(text) <= MAX_STORED_BYTES ? text : null,
        content_type: typeof ct === 'string' ? ct : null,
        finished_at: new Date().toISOString()
      }
      await redis.set(claim.redisKey, JSON.stringify(done), 'EX', DONE_TTL_S)
    } catch (err) {
      req.log.warn({ err }, 'idempotency store failed')
    }
    return payload
  })
}
