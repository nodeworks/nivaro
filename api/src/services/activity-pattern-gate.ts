import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Activity-pattern alerts (#23) — the hot-path gate. logActivity calls
 * `noteActivityForPatterns` for every entry it writes; with no rule for the
 * entry's collection + action this answers from a per-tenant index without
 * any I/O. A candidate is evaluated fire-and-forget on the background pool
 * (activity-pattern-alerts.ts), never blocking or failing the write.
 *
 * Rules are ordinary alert definitions (nivaro_alert_definitions) with
 * detection_type 'activity_pattern'; their config is the `filters` JSON
 * (ActivityPatternConfig). `collection` is the collection watched, or '*'
 * for any business collection. The index is dropped on every rule save
 * (invalidateActivityPatternRules) and re-read at most every 60 s, so other
 * replicas catch up within a minute.
 */

export const ACTIVITY_PATTERN_KIND = 'activity_pattern'

export interface ActivityPatternConfig {
  /** Whose actions: anyone, these people, or anyone holding one of these roles. */
  who: { kind: 'any' | 'users' | 'roles'; users: string[]; roles: string[] }
  /** Activity actions (update, delete, transition…); empty = any. */
  actions: string[]
  /** Directus-style filter on the record, judged as the rule owner sees it. */
  record_filter: Record<string, unknown> | null
  /** An update must change one of these fields; empty = any. */
  changed_fields: string[]
  /** Notifications per rule per clock hour; the rest are digested. */
  max_per_hour: number
}

export interface PatternRule {
  id: number
  name: string
  collection: string
  owner: string | null
  config: ActivityPatternConfig
}

export interface PatternEvent {
  activity_id: number | null
  action: string
  user: string | null
  collection: string | null
  item: string | null
  changed_fields?: string[]
  at: Date
}

export const PATTERN_MAX_PER_HOUR_DEFAULT = 10
const ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,49}$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ID_RE = /^[0-9a-f-]{8,64}$/i

function strList(v: unknown, re: RegExp, max: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const s = typeof x === 'string' ? x.trim() : ''
    if (s && re.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** The stored config, cleaned; throws a message for a config that cannot work. */
export function normalizePatternConfig(raw: unknown): ActivityPatternConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const w = (o.who && typeof o.who === 'object' ? o.who : {}) as Record<string, unknown>
  const users = strList(w.users, ID_RE, 100)
  const roles = strList(w.roles, ID_RE, 50)
  const kind: ActivityPatternConfig['who']['kind'] =
    w.kind === 'users' ? 'users' : w.kind === 'roles' ? 'roles' : 'any'
  if (kind === 'users' && users.length === 0) throw new Error('Pick at least one person')
  if (kind === 'roles' && roles.length === 0) throw new Error('Pick at least one role')
  let filter: Record<string, unknown> | null = null
  if (o.record_filter && typeof o.record_filter === 'object' && !Array.isArray(o.record_filter)) {
    const keys = Object.keys(o.record_filter)
    if (keys.length > 0) {
      if (JSON.stringify(o.record_filter).length > 4000)
        throw new Error('The record filter is too large')
      filter = o.record_filter as Record<string, unknown>
    }
  }
  const max = Math.floor(Number(o.max_per_hour))
  return {
    who: { kind, users: kind === 'users' ? users : [], roles: kind === 'roles' ? roles : [] },
    actions: strList(o.actions, ACTION_RE, 30),
    record_filter: filter,
    changed_fields: strList(o.changed_fields, FIELD_RE, 50),
    max_per_hour:
      Number.isFinite(max) && max > 0 ? Math.min(max, 1000) : PATTERN_MAX_PER_HOUR_DEFAULT
  }
}

/** Entries never matched: the alert engine's own writes and the log itself. */
const NEVER = new Set([
  'nivaro_notifications',
  'nivaro_alert_log',
  'nivaro_activity',
  'nivaro_revisions',
  'nivaro_alert_definitions',
  'nivaro_alert_subscriptions'
])

export function isSystemCollection(c: string | null | undefined): boolean {
  return !!c && /^(nivaro_|directus_)/i.test(c)
}

interface RuleIndex {
  at: number
  byCollection: Map<string, PatternRule[]>
  /** '*' rules — any business collection. */
  any: PatternRule[]
}

const TTL_MS = 60_000
const indexes = new Map<string, RuleIndex>()
const loading = new Map<string, Promise<RuleIndex>>()

/** Drop the cached rules of the current tenant (rule saved / deleted). */
export function invalidateActivityPatternRules(): void {
  const key = currentTenantKey()
  indexes.delete(key)
  loading.delete(key)
}

export function buildRuleIndex(rules: PatternRule[], at = Date.now()): RuleIndex {
  const byCollection = new Map<string, PatternRule[]>()
  const any: PatternRule[] = []
  for (const r of rules) {
    if (r.collection === '*' || !r.collection) any.push(r)
    else {
      const list = byCollection.get(r.collection) ?? []
      list.push(r)
      byCollection.set(r.collection, list)
    }
  }
  return { at, byCollection, any }
}

/** Rules that could match this entry (collection + action only). */
export function candidateRules(idx: RuleIndex, ev: PatternEvent): PatternRule[] {
  if (!ev.collection || NEVER.has(ev.collection)) return []
  const own = idx.byCollection.get(ev.collection) ?? []
  const wide = isSystemCollection(ev.collection) ? [] : idx.any
  if (own.length === 0 && wide.length === 0) return []
  return [...own, ...wide].filter(
    (r) => r.config.actions.length === 0 || r.config.actions.includes(ev.action)
  )
}

async function loadRules(): Promise<PatternRule[]> {
  const rows = (await db('nivaro_alert_definitions')
    .where({ detection_type: ACTIVITY_PATTERN_KIND })
    .where('is_active', true)
    .select('id', 'name', 'collection', 'filters', 'created_by')
    .catch(() => [])) as Array<{
    id: number
    name: string
    collection: string
    filters: string | null
    created_by: string | null
  }>
  const out: PatternRule[] = []
  for (const r of rows) {
    try {
      const raw = r.filters ? (JSON.parse(r.filters) as unknown) : {}
      out.push({
        id: Number(r.id),
        name: r.name,
        collection: r.collection || '*',
        owner: r.created_by ?? null,
        config: normalizePatternConfig(raw)
      })
    } catch {
      /* a broken rule matches nothing */
    }
  }
  return out
}

async function ruleIndex(): Promise<RuleIndex> {
  const key = currentTenantKey()
  const hit = indexes.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit
  let p = loading.get(key)
  if (!p) {
    p = loadRules()
      .then((rules) => {
        const idx = buildRuleIndex(rules)
        indexes.set(key, idx)
        return idx
      })
      .finally(() => loading.delete(key))
    loading.set(key, p)
  }
  return p
}

/**
 * Called by logActivity for every entry. Never throws, never awaits I/O on
 * the caller's path: a fresh index with no candidate returns at once.
 */
export function noteActivityForPatterns(ev: PatternEvent): void {
  try {
    if (!ev.collection || NEVER.has(ev.collection)) return
    const idx = indexes.get(currentTenantKey())
    if (idx && Date.now() - idx.at < TTL_MS && candidateRules(idx, ev).length === 0) return
    setImmediate(() => {
      runInBackgroundPool(async () => {
        const fresh = await ruleIndex()
        const rules = candidateRules(fresh, ev)
        if (rules.length === 0) return
        const { evaluatePatternEvent, realPatternDeps } = await import(
          './activity-pattern-alerts.js'
        )
        await evaluatePatternEvent(ev, rules, realPatternDeps())
      }).catch(() => {
        /* an alert never fails or slows a write */
      })
    })
  } catch {
    /* never */
  }
}

/** For tests: seed / clear the index of the current tenant. */
export function _setRuleIndexForTest(rules: PatternRule[] | null): void {
  const key = currentTenantKey()
  if (rules) indexes.set(key, buildRuleIndex(rules))
  else indexes.delete(key)
}
