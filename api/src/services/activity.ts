import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import { chainFields } from './chain-columns.js'
import { currentTraceCaller, noteDerivedWrite } from './request-trace.js'

// Mission-control pulse: logActivity broadcasts each entry to the admin-only
// 'pulse' socket room when the server has registered itself here.
let _pulseApp: FastifyInstance | null = null
export function setPulseApp(app: FastifyInstance): void {
  _pulseApp = app
}

// The origin column arrives with migration 340; until an instance has run it,
// writing the key would fail every activity insert. Probe once per tenant
// (cloud mode: one tenant may be migrated while another is not) per process.
const hasOriginCol = new Map<string, Promise<boolean>>()
async function originColumn(
  origin: string | null | undefined,
  comment: string | undefined
): Promise<Record<string, string>> {
  const tenant = getTenantId() ?? ''
  let probe = hasOriginCol.get(tenant)
  if (!probe) {
    probe = (async () => {
      try {
        return await db.schema.hasColumn('nivaro_activity', 'origin')
      } catch {
        return false
      }
    })()
    hasOriginCol.set(tenant, probe)
  }
  if (!(await probe)) return {}
  const o = origin ?? (/^import:/i.test(String(comment ?? '').trim()) ? 'import' : null)
  return o ? { origin: o } : {}
}

/**
 * Which credential the write arrived on (migration 384, #609 / #617): the
 * named API key's id and the auth method. A key acts as its owner, so without
 * this a partner's writes through a key read as that person's edits. The
 * request is the one handed in, else the one the current trace is serving
 * (GraphQL resolvers, effects deferred inside the request). A database behind
 * the migration gets nothing written.
 */
async function callerColumns(req: FastifyRequest | undefined): Promise<Record<string, unknown>> {
  const fromReq = req
    ? {
        auth: (req as { authMethod?: string }).authMethod ?? null,
        apiKeyId: (req as { apiKeyId?: number | null }).apiKeyId ?? null
      }
    : null
  const caller = fromReq?.auth ? fromReq : (currentTraceCaller() ?? fromReq)
  if (!caller?.auth && caller?.apiKeyId == null) return {}
  try {
    if (!(await hasColumn('nivaro_activity', 'auth_method'))) return {}
  } catch {
    return {}
  }
  const out: Record<string, unknown> = {}
  if (caller.auth) out.auth_method = String(caller.auth).slice(0, 20)
  if (caller.apiKeyId != null && Number.isFinite(Number(caller.apiKeyId)))
    out.api_key_id = Number(caller.apiKeyId)
  return out
}

export async function logActivity(opts: {
  action: string
  user: string | null | undefined
  collection?: string
  item?: string
  comment?: string
  req?: FastifyRequest
  /** Who wrote it — person | machine | import | integration (#518). */
  origin?: string | null
}): Promise<number | null> {
  try {
    const rows = (await db('nivaro_activity')
      .insert({
        action: opts.action,
        user: opts.user ?? null,
        collection: opts.collection ?? null,
        item: opts.item ?? null,
        comment: opts.comment ?? null,
        ...(await originColumn(opts.origin, opts.comment)),
        ...(await chainFields('nivaro_activity')),
        ...(await callerColumns(opts.req)),
        ip: opts.req?.ip ?? null,
        user_agent: opts.req?.headers['user-agent'] ?? null,
        timestamp: new Date()
      })
      .returning('id')) as unknown[]
    const row = rows[0] as { id: number } | number
    const id = typeof row === 'object' && row !== null ? row.id : (row as number)
    noteDerivedWrite('activity')
    try {
      _pulseApp?.io?.to('pulse').emit('activity:pulse', {
        id,
        action: opts.action,
        collection: opts.collection ?? null,
        item: opts.item ?? null,
        comment: opts.comment ? String(opts.comment).slice(0, 120) : null,
        timestamp: new Date().toISOString()
      })
    } catch {
      /* pulse is best-effort */
    }
    return id
  } catch (err) {
    // Activity logging must never break the main operation
    console.error({ err, action: opts.action }, 'Failed to write activity log')
    return null
  }
}

// ─── Throttled logging for hot paths ─────────────────────────────────────────
//
// Some audit-relevant actions fire far more often than they carry information:
// a dashboard refreshing eight query widgets every minute is one access event,
// not eight hundred rows a day. logActivityThrottled collapses repeats of the
// same logical event within a window, keeping the "who touched what" signal
// while dropping the machine-driven volume that buries it.
//
// Fails OPEN: with no Redis (or a Redis error) the entry is written normally —
// losing audit coverage is worse than logging a duplicate.

interface ThrottleRedis {
  set(key: string, value: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<string | null>
}

export async function logActivityThrottled(
  redis: ThrottleRedis | null | undefined,
  dedupeKey: string,
  windowSeconds: number,
  opts: Parameters<typeof logActivity>[0]
): Promise<number | null> {
  if (redis) {
    try {
      const acquired = await redis.set(`actlog:${dedupeKey}`, '1', 'EX', windowSeconds, 'NX')
      if (acquired === null) return null // already logged inside the window
    } catch {
      /* fall through and log — never trade audit coverage for cache health */
    }
  }
  return logActivity(opts)
}
