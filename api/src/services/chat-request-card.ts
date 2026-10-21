import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Request id cards for chat (#2762). Someone pastes a request id (a uuid —
 * the id an error toast shows) or a trace id (the same id without dashes) and
 * the message unfurls into a card, built for the READER:
 *
 *   administrators — route, status, duration, who made it, when, and a link
 *                    to the request on the Traffic Map (its trace when kept);
 *   everyone else  — only that the id names a logged request. The route,
 *                    the person and the timing stay administrator data.
 *
 * Ids that name nothing get no card (null), so an ordinary uuid in a message
 * stays plain text.
 */

export interface RequestCardDetails {
  method: string
  route: string
  path: string
  status: number
  duration_ms: number
  at: string | null
  person: string | null
  caller_kind: 'user' | 'api_key' | 'anonymous'
  trace_kept: boolean
  trace_note: string | null
  trace_url: string
}

export interface RequestCard {
  kind: 'request'
  id: string
  /** Null for a reader who is not an administrator. */
  details: RequestCardDetails | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX32_RE = /^[0-9a-f]{32}$/i

/** A request id or trace id as the request id (lower-case uuid), else null. */
export function normalizeRequestId(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (UUID_RE.test(s)) return s.toLowerCase()
  if (HEX32_RE.test(s)) {
    const h = s.toLowerCase()
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return null
}

export function traceUrlFor(id: string): string {
  return `${adminBaseUrl() ?? ''}/traffic-map?inspect=${encodeURIComponent(`request:${id}`)}`
}

/** Pure: the card a reader gets from what was found. */
export function shapeRequestCard(
  id: string,
  found: RequestCardDetails | null,
  isAdmin: boolean
): RequestCard | null {
  if (!found) return null
  return { kind: 'request', id, details: isAdmin ? found : null }
}

// The same id is often pasted into a busy room: one lookup per id per minute,
// per tenant (cloud: the lookup reads the tenant's own request log, so one
// tenant's answer never serves another).
const MEMO_MS = 60_000
const memo = new Map<string, { at: number; v: RequestCardDetails | null }>()

export const requestMemoKey = (id: string, tenant: string = currentTenantKey()): string =>
  `${tenant}|${id}`

async function lookup(id: string): Promise<RequestCardDetails | null> {
  const tenant = currentTenantKey()
  const memoKey = requestMemoKey(id, tenant)
  const hit = memo.get(memoKey)
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.v
  const { getTrace } = await import('./request-trace.js')
  // The kept-trace ring is process-wide and carries no tenant: in a tenant,
  // only the tenant's request log describes an id.
  const trace = tenant ? null : getTrace(id)
  let v: RequestCardDetails | null = null
  const { findRequestRow, traceAbsence } = await import('./traffic-inspect/request.js')
  const found = await findRequestRow(id, null).catch(() => null)
  if (found?.row) {
    const r = found.row
    const absent = trace ? null : traceAbsence(r)
    v = {
      method: r.method,
      route: r.route,
      path: r.path,
      status: r.status,
      duration_ms: r.latency_ms,
      at: r.created_at,
      person: r.caller.kind === 'anonymous' ? null : r.caller.label,
      caller_kind: r.caller.kind,
      trace_kept: !!trace,
      trace_note: absent?.reason ?? null,
      trace_url: traceUrlFor(id)
    }
  } else if (trace) {
    // Not in the request log yet (it is written in batches) — the kept trace
    // on this process is enough to describe it.
    let person: string | null = null
    if (trace.user) {
      const u = (await db('nivaro_users')
        .where({ id: trace.user })
        .first('first_name', 'last_name', 'email')
        .catch(() => undefined)) as Record<string, unknown> | undefined
      person =
        [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() ||
        (u?.email ? String(u.email) : null)
    }
    v = {
      method: trace.method,
      route: `${trace.method} ${trace.route}`,
      path: trace.url.split('?')[0],
      status: trace.status,
      duration_ms: Math.round(trace.total_ms),
      at: trace.ts,
      person,
      caller_kind: trace.user ? 'user' : 'anonymous',
      trace_kept: true,
      trace_note: null,
      trace_url: traceUrlFor(id)
    }
  }
  memo.set(memoKey, { at: Date.now(), v })
  if (memo.size > 1000) memo.delete(memo.keys().next().value as string)
  return v
}

export async function requestCardFor(
  _user: User,
  isAdmin: boolean,
  rawId: string
): Promise<RequestCard | null> {
  const id = normalizeRequestId(rawId)
  if (!id) return null
  return shapeRequestCard(id, await lookup(id), isAdmin)
}

/** Tests only. */
export function __resetRequestCardMemo(): void {
  memo.clear()
}
