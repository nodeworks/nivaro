import type { FastifyReply, FastifyRequest } from 'fastify'
import { type DbRefusalDetail, refusalDetail } from '../lib/db-refusal.js'
import { enrichErrorBody } from '../lib/error-hints.js'
import { labelDbRefusal } from './db-refusal-labels.js'

/**
 * The onSend step that makes every error answer say what to do
 * (lib/error-hints.ts): `hint`, `fields` and `request_id` on 4xx/5xx JSON
 * bodies, and a database refusal reworded in the collection's field labels.
 * Existing keys are never replaced, `error`/`code` values never change —
 * except a labelled database refusal, whose generic sentence gives way to the
 * one naming the field.
 */

const DB_REFUSAL = Symbol.for('nivaro.dbRefusalDetail')
const MAX_BODY = 256 * 1024
/** GraphQL and MCP answer in their own protocol shapes; OAuth lives off /api. */
const SKIP = /^\/api\/(graphql|mcp)(\/|\?|$)/

/** Remember what a database refusal named, for the answer's labels. Never throws. */
export function noteDbRefusal(req: FastifyRequest, err: unknown): void {
  try {
    const detail = refusalDetail(err)
    if (detail) (req as unknown as Record<symbol, DbRefusalDetail>)[DB_REFUSAL] = detail
  } catch {
    /* labels are a courtesy */
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** The rewritten payload, or null to send it unchanged. Never throws. */
export async function enrichErrorPayload(
  req: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<string | null> {
  try {
    const status = reply.statusCode
    if (status < 400 || typeof payload !== 'string') return null
    if (payload.length > MAX_BODY || payload.charCodeAt(0) !== 123 /* { */) return null
    if (!req.url.startsWith('/api/') || SKIP.test(req.url)) return null
    const type = String(reply.getHeader('content-type') ?? '')
    if (type && !type.includes('json')) return null
    const body = JSON.parse(payload) as unknown
    if (!isPlainObject(body)) return null
    if (
      typeof body.error !== 'string' &&
      typeof body.message !== 'string' &&
      typeof body.code !== 'string'
    )
      return null
    const detail = (req as unknown as Record<symbol, DbRefusalDetail | undefined>)[DB_REFUSAL]
    const labelled = detail
      ? await labelDbRefusal(detail, {
          collection: (req.params as { collection?: string } | undefined)?.collection ?? null,
          values: isPlainObject(req.body) ? req.body : null
        }).catch(() => null)
      : null
    const next = enrichErrorBody(body, status, {
      requestId: req.requestId ?? null,
      ...(labelled ?? {})
    })
    return next ? JSON.stringify(next) : null
  } catch {
    return null
  }
}
