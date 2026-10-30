import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import { noteActivityForPatterns } from './activity-pattern-gate.js'
import { actorJson, resolveActivityStamp } from './activity-scope.js'
import type { ActivityActor } from './activity-sentence.js'
import { chainFields } from './chain-columns.js'
import { attributionColumns } from './mcp-attribution.js'
import { currentTraceCaller, currentTraceRequestObject, noteDerivedWrite } from './request-trace.js'
import { tenantScopedRoom } from './tenant-rooms.js'

// Mission-control pulse: logActivity broadcasts each entry to the admin-only
// 'pulse' socket room when the server has registered itself here.
let _pulseApp: FastifyInstance | null = null
export function setPulseApp(app: FastifyInstance): void {
  _pulseApp = app
}
/** The server, once registered (activity-pattern alerts deliver through notifyUser with it). */
export function pulseApp(): FastifyInstance | null {
  return _pulseApp
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

/**
 * The burst + actor columns (migration 516): the row's group key (one bulk action, import
 * run, flow run, cron tick, batch or MCP request) and who really did it when that is not
 * simply the signed-in person (services/activity-scope.ts). A database behind 516 gets
 * nothing written.
 */
async function readableColumns(
  opts: Parameters<typeof logActivity>[0],
  req: FastifyRequest | undefined
): Promise<Record<string, string>> {
  const stamp = resolveActivityStamp({
    req: req as Parameters<typeof resolveActivityStamp>[0]['req'],
    user: opts.user ?? null,
    group_key: opts.group_key,
    actor: opts.actor
  })
  const actor = actorJson(stamp.actor)
  if (!stamp.group_key && !actor) return {}
  try {
    if (!(await hasColumn('nivaro_activity', 'group_key'))) return {}
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  if (stamp.group_key) out.group_key = stamp.group_key
  if (actor) out.actor = actor
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
  /** An update's changed field names — for activity-pattern alerts only, never stored. */
  changed_fields?: string[]
  /** The burst this row belongs to (migration 516); default: the request / runner scope. */
  group_key?: string | null
  /** Who really did it (migration 516); default: derived from the request / runner scope. */
  actor?: ActivityActor | null
}): Promise<number | null> {
  try {
    const liveReq = (opts.req ?? currentTraceRequestObject() ?? undefined) as
      | FastifyRequest
      | undefined
    const record: Record<string, unknown> = {
      action: opts.action,
      user: opts.user ?? null,
      collection: opts.collection ?? null,
      item: opts.item ?? null,
      comment: opts.comment ?? null,
      ...(await originColumn(opts.origin, opts.comment)),
      ...(await chainFields('nivaro_activity')),
      ...(await callerColumns(opts.req)),
      // #3213: a write made through the hosted MCP endpoint names its connection + app.
      ...(await attributionColumns(liveReq as Parameters<typeof attributionColumns>[0])),
      ...(await readableColumns(opts, liveReq)),
      ip: opts.req?.ip ?? null,
      user_agent: opts.req?.headers['user-agent'] ?? null,
      timestamp: new Date()
    }
    const rows = (await db('nivaro_activity').insert(record).returning('id')) as unknown[]
    const row = rows[0] as { id: number } | number
    const id = typeof row === 'object' && row !== null ? row.id : (row as number)
    noteDerivedWrite('activity')
    // #23 — activity-pattern alerts: no I/O here without a matching rule; fire-and-forget.
    noteActivityForPatterns({
      activity_id: id ?? null,
      action: opts.action,
      user: opts.user ?? null,
      collection: opts.collection ?? null,
      item: opts.item ?? null,
      changed_fields: opts.changed_fields,
      at: new Date()
    })
    try {
      // Cloud: the writing tenant's pulse room (tenant-rooms.ts).
      _pulseApp?.io?.to(tenantScopedRoom('pulse')).emit('activity:pulse', {
        id,
        action: opts.action,
        collection: opts.collection ?? null,
        item: opts.item ?? null,
        comment: opts.comment ? String(opts.comment).slice(0, 120) : null,
        timestamp: new Date().toISOString(),
        // The admin-only pulse room renders the same readable sentence as the log: who, how, which burst.
        ...pulseExtras(record)
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

const PULSE_EXTRA_KEYS = [
  'user',
  'origin',
  'group_key',
  'actor',
  'auth_method',
  'api_key_id',
  'api_key_name',
  'mcp_conn',
  'via_app',
  'via_agent',
  'chain_parent'
] as const

/** The stored columns the Live tab's sentence needs (only those present on this row). */
function pulseExtras(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PULSE_EXTRA_KEYS) if (record[k] != null) out[k] = record[k]
  return out
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
