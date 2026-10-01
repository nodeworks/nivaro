// api/src/services/traffic-taps/error-groups.ts
/**
 * #1150 Error groups: an entity's errors grouped by normalised message — the issue fingerprint
 * rule (`source|METHOD /route|message`, services/error-tracking.ts) — each 5xx group linked to
 * its `nivaro_issues` row. Counts per minute in this process's ring; the issue lookup runs only
 * when the inspector asks (entityDetail).
 */
import { db } from '../../db/index.js'
import { issueFingerprint, issueMessage } from '../error-tracking.js'
import { MinuteCounter, registerTrafficTap, type TapRequestCtx, tapState } from '../traffic-taps.js'

export const ERROR_GROUPS_TAP = 'error-groups'
export const GROUPS_PER_ENTITY = 20
const MAX_ENTITIES = 200

export interface ErrorGroupMeta {
  /** `METHOD /route/:param` as the server error handler names it (trackError's route). */
  routeKey: string
  /** The map's route template (shown). */
  route: string
  status: number
  code: string | null
  message: string
  /** 5xx only — the fingerprint its issue carries. */
  fingerprint: string | null
  last: number
}
interface EntityGroups {
  counter: MinuteCounter
  meta: Map<string, ErrorGroupMeta>
}
type State = Map<string, EntityGroups>

const state = () => tapState<State>(ERROR_GROUPS_TAP, () => new Map())

/** The message a response body carries: `message`, else `error`, else the text itself. */
export function messageOfBody(body: string | null | undefined): string {
  if (!body) return ''
  try {
    const j = JSON.parse(body) as Record<string, unknown>
    const m = j.message ?? j.error
    if (typeof m === 'string' && m.trim()) return m.trim()
    if (Array.isArray(j.errors)) {
      const first = (j.errors[0] as { message?: unknown } | undefined)?.message
      if (typeof first === 'string') return first
    }
  } catch {
    /* not JSON */
  }
  return body.replace(/\s+/g, ' ').trim()
}

/** The group a failed request belongs to (pure; exported for tests). */
export function groupOf(input: {
  method: string
  routeUrl: string | null
  path: string
  route: string
  status: number
  code: string | null
  body: string | null
}): { key: string; meta: Omit<ErrorGroupMeta, 'last'> } {
  const routeKey = `${input.method.toUpperCase()} ${input.routeUrl || input.path}`
  const message = issueMessage(messageOfBody(input.body) || input.code || `HTTP ${input.status}`)
  const server = input.status >= 500
  const fingerprint = server ? issueFingerprint('server', routeKey, message) : null
  return {
    key: `${server ? '5' : '4'}|${routeKey}|${message}`,
    meta: {
      routeKey,
      route: input.route,
      status: input.status,
      code: input.code,
      message,
      fingerprint
    }
  }
}

function onRequest(c: TapRequestCtx): void {
  if (!c.isError) return
  const req = (c.ev.req ?? {}) as {
    routeOptions?: { url?: string }
    __nvrErr?: string
  }
  const g = groupOf({
    method: c.ev.method,
    routeUrl: req.routeOptions?.url ?? null,
    path: c.ev.path,
    route: c.route,
    status: c.ev.status,
    code: c.code,
    body: req.__nvrErr ?? null
  })
  const s = state()
  let e = s.get(c.entityKey)
  if (!e) {
    if (s.size >= MAX_ENTITIES) return
    e = { counter: new MinuteCounter(GROUPS_PER_ENTITY), meta: new Map() }
    s.set(c.entityKey, e)
  }
  e.counter.bump(g.key, c.sec)
  // Over the cap the counter folds the group into its `other` key: no meta for that.
  if (e.meta.has(g.key) || e.counter.keys().includes(g.key))
    e.meta.set(g.key, { ...g.meta, last: c.ev.at })
}

export interface ErrorGroupWire {
  key: string
  route: string
  status: number
  code: string | null
  message: string
  n: number
  last: string
  issue: { id: number; status: string; occurrence_count: number } | null
}

async function entityDetail(
  entityKey: string,
  windowS: number,
  sec: number
): Promise<{ groups: ErrorGroupWire[] } | undefined> {
  const e = state().get(entityKey)
  if (!e) return { groups: [] }
  const rows = e.counter
    .top(windowS, sec, GROUPS_PER_ENTITY)
    .map(([key, n]) => ({ key, n, meta: e.meta.get(key) }))
    .filter((r): r is { key: string; n: number; meta: ErrorGroupMeta } => !!r.meta && r.n > 0)
    .slice(0, 10)
  const prints = [...new Set(rows.map((r) => r.meta.fingerprint).filter(Boolean))] as string[]
  const issues = new Map<string, { id: number; status: string; occurrence_count: number }>()
  if (prints.length) {
    const found = (await Promise.resolve(
      db('nivaro_issues')
        .whereIn('fingerprint', prints)
        .whereNot('status', 'resolved')
        .orderBy('id', 'desc')
        .select('id', 'fingerprint', 'status', 'occurrence_count')
    ).catch(() => [])) as Array<{
      id: number
      fingerprint: string
      status: string
      occurrence_count: number
    }>
    for (const f of found) {
      if (!issues.has(f.fingerprint))
        issues.set(f.fingerprint, {
          id: Number(f.id),
          status: f.status,
          occurrence_count: Number(f.occurrence_count) || 0
        })
    }
  }
  return {
    groups: rows.map((r) => ({
      key: r.key,
      route: r.meta.route,
      status: r.meta.status,
      code: r.meta.code,
      message: r.meta.message,
      n: r.n,
      last: new Date(r.meta.last).toISOString(),
      issue: r.meta.fingerprint ? (issues.get(r.meta.fingerprint) ?? null) : null
    }))
  }
}

function sweep(sec: number): void {
  const s = state()
  for (const [k, e] of s) {
    e.counter.sweep(sec)
    if (e.counter.size === 0) {
      s.delete(k)
      continue
    }
    const live = new Set(e.counter.keys())
    for (const key of e.meta.keys()) if (!live.has(key)) e.meta.delete(key)
  }
}

registerTrafficTap({ id: ERROR_GROUPS_TAP, onRequest, entityDetail, sweep })
