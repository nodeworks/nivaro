import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import {
  ACTIVITY_PATTERN_KIND,
  isSystemCollection,
  normalizePatternConfig,
  type PatternEvent,
  type PatternRule
} from './activity-pattern-gate.js'

/**
 * Activity-pattern alerts (#23) — evaluation and delivery. The gate
 * (activity-pattern-gate.ts) hands over entries whose collection + action a
 * rule names; here the rest is judged:
 *   who      — anyone, listed people, or holders of listed roles
 *   changed  — for updates: one of the named fields changed
 *   record   — the optional record filter, judged as the rule OWNER reads the
 *              record (their row filters, User Scopes, field list); a record
 *              the owner cannot see never matches; a delete with a record
 *              filter never matches (the record is gone)
 * A match notifies the rule's subscribers through notifyUser (category
 * `audit`), at most `max_per_hour` per rule per clock hour; the rest are kept
 * in nivaro_alert_log as held and sent as one digest after the hour (on the
 * rule's next match, or the hourly alert sweep).
 *
 * nivaro_alert_log.field_value carries the match as JSON starting with the
 * state key: {"s":"sent"|"held"|"d:<claim>","a":action,"u":user,"f":[fields]}.
 */

export interface HeldMatch {
  action: string
  user: string | null
  collection: string
  item: string
  at: string
}

export interface PatternDeps {
  now(): Date
  actorRole(userId: string): Promise<string | null>
  ownerSees(
    rule: PatternRule,
    collection: string,
    item: string,
    filter: Record<string, unknown>
  ): Promise<boolean>
  sentSince(ruleId: number, since: Date): Promise<number>
  record(rule: PatternRule, ev: PatternEvent, state: 'sent' | 'held'): Promise<void>
  /** Claim (and return) the held matches of earlier hours, once across replicas. */
  claimHeld(ruleId: number, before: Date): Promise<HeldMatch[]>
  notify(
    rule: PatternRule,
    what: { event: PatternEvent } | { digest: { count: number; examples: HeldMatch[] } }
  ): Promise<number>
}

export type PatternOutcome = 'sent' | 'held' | 'no_match'

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/** Who / action / changed-fields — everything but the record filter. */
export async function matchesStatic(
  rule: PatternRule,
  ev: PatternEvent,
  deps: Pick<PatternDeps, 'actorRole'>
): Promise<boolean> {
  const c = rule.config
  if (rule.collection !== '*' && rule.collection !== ev.collection) return false
  if (rule.collection === '*' && isSystemCollection(ev.collection)) return false
  if (c.actions.length > 0 && !c.actions.includes(ev.action)) return false
  if (c.changed_fields.length > 0) {
    const changed = ev.changed_fields ?? []
    if (!c.changed_fields.some((f) => changed.includes(f))) return false
  }
  if (c.who.kind === 'users' && !c.who.users.some((u) => sameId(u, ev.user))) return false
  if (c.who.kind === 'roles') {
    if (!ev.user) return false
    const role = await deps.actorRole(ev.user)
    if (!c.who.roles.some((r) => sameId(r, role))) return false
  }
  return true
}

export async function matchesPattern(
  rule: PatternRule,
  ev: PatternEvent,
  deps: Pick<PatternDeps, 'actorRole' | 'ownerSees'>
): Promise<boolean> {
  if (!(await matchesStatic(rule, ev, deps))) return false
  const filter = rule.config.record_filter
  if (!filter) return true
  if (!ev.collection || !ev.item || ev.action === 'delete') return false
  return deps.ownerSees(rule, ev.collection, ev.item, filter)
}

export function hourStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000)
}

/** Send the digest of a rule's held matches from earlier hours, if any. */
export async function flushPatternDigest(rule: PatternRule, deps: PatternDeps): Promise<number> {
  const held = await deps.claimHeld(rule.id, hourStart(deps.now()))
  if (held.length === 0) return 0
  await deps.notify(rule, { digest: { count: held.length, examples: held.slice(0, 5) } })
  return held.length
}

export async function deliverPatternMatch(
  rule: PatternRule,
  ev: PatternEvent,
  deps: PatternDeps
): Promise<'sent' | 'held'> {
  await flushPatternDigest(rule, deps).catch(() => 0)
  const sent = await deps.sentSince(rule.id, hourStart(deps.now()))
  if (sent >= rule.config.max_per_hour) {
    await deps.record(rule, ev, 'held')
    return 'held'
  }
  await deps.record(rule, ev, 'sent')
  await deps.notify(rule, { event: ev })
  return 'sent'
}

export async function evaluatePatternEvent(
  ev: PatternEvent,
  rules: PatternRule[],
  deps: PatternDeps
): Promise<Map<number, PatternOutcome>> {
  const out = new Map<number, PatternOutcome>()
  for (const rule of rules) {
    try {
      if (!(await matchesPattern(rule, ev, deps))) {
        out.set(rule.id, 'no_match')
        continue
      }
      out.set(rule.id, await deliverPatternMatch(rule, ev, deps))
    } catch {
      out.set(rule.id, 'no_match')
    }
  }
  return out
}

// ─── Real deps ────────────────────────────────────────────────────────────────

function matchValue(state: string, ev: PatternEvent): string {
  // The state key first: rate counting and digest claims match on the prefix.
  const body = JSON.stringify({
    a: ev.action,
    u: ev.user,
    f: (ev.changed_fields ?? []).slice(0, 10),
    id: ev.activity_id
  })
  return `{"s":${JSON.stringify(state)},${body.slice(1)}`.slice(0, 500)
}

const VERBS: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  restore: 'restored',
  transition: 'moved',
  undo: 'undid a change on',
  export: 'exported'
}

async function personName(id: string | null): Promise<string> {
  if (!id) return 'The system'
  const u = (await db('nivaro_users')
    .where({ id })
    .first('first_name', 'last_name', 'email')
    .catch(() => null)) as { first_name?: string; last_name?: string; email?: string } | null
  const name = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim()
  return name || u?.email || 'Someone'
}

export function realPatternDeps(): PatternDeps {
  const userCache = new Map<string, User | null>()
  const loadUser = async (id: string): Promise<User | null> => {
    if (userCache.has(id)) return userCache.get(id) ?? null
    const { getUser } = await import('./users.js')
    const u = (await getUser(id).catch(() => undefined)) ?? null
    userCache.set(id, u)
    return u
  }
  return {
    now: () => new Date(),

    async actorRole(userId) {
      const u = await loadUser(userId)
      return u?.role ?? null
    },

    async ownerSees(rule, collection, item, filter) {
      if (!rule.owner) return false
      const owner = await loadUser(rule.owner)
      if (owner?.status !== 'active') return false
      try {
        const { readItems } = await import('./items.js')
        const res = (await readItems(owner, collection, {
          filter: { _and: [{ id: { _eq: item } }, filter] },
          fields: ['id'],
          limit: 1,
          count: false
        })) as { data?: unknown[] }
        return (res.data?.length ?? 0) > 0
      } catch {
        return false
      }
    },

    async sentSince(ruleId, since) {
      const row = (await db('nivaro_alert_log')
        .where({ alert_definition: ruleId })
        .where('triggered_at', '>=', since)
        .where('field_value', 'like', '{"s":"sent"%')
        .count('* as c')
        .first()) as { c?: number | string } | undefined
      return Number(row?.c ?? 0)
    },

    async record(rule, ev, state) {
      await db('nivaro_alert_log').insert({
        alert_definition: rule.id,
        collection: (ev.collection ?? '-').slice(0, 255),
        item: (ev.item ?? '-').slice(0, 255),
        field_value: matchValue(state, ev),
        triggered_at: new Date()
      })
    },

    async claimHeld(ruleId, before) {
      const token = randomUUID().replace(/-/g, '').slice(0, 12)
      await db('nivaro_alert_log')
        .where({ alert_definition: ruleId })
        .where('triggered_at', '<', before)
        .where('field_value', 'like', '{"s":"held"%')
        .update({
          field_value: db.raw('REPLACE(field_value, ?, ?)', ['{"s":"held"', `{"s":"d:${token}"`])
        })
      const rows = (await db('nivaro_alert_log')
        .where({ alert_definition: ruleId })
        .where('field_value', 'like', `{"s":"d:${token}"%`)
        .orderBy('id', 'asc')
        .select('collection', 'item', 'field_value', 'triggered_at')) as Array<{
        collection: string
        item: string
        field_value: string | null
        triggered_at: Date | string
      }>
      return rows.map((r) => {
        let a = 'change'
        let u: string | null = null
        try {
          const j = JSON.parse(String(r.field_value)) as { a?: string; u?: string | null }
          a = j.a ?? a
          u = j.u ?? null
        } catch {
          /* a truncated row still counts */
        }
        return {
          action: a,
          user: u,
          collection: r.collection,
          item: r.item,
          at: new Date(r.triggered_at).toISOString()
        }
      })
    },

    async notify(rule, what) {
      const { pulseApp } = await import('./activity.js')
      const app = pulseApp()
      if (!app) return 0
      const { notifyUser } = await import('./notification-channels.js')
      const { can } = await import('./permissions.js')
      const subs = (await db('nivaro_alert_subscriptions')
        .where({ alert_definition: rule.id })
        .select('user', 'notify_inapp', 'notify_email')) as Array<{
        user: string
        notify_inapp: boolean | number
        notify_email: boolean | number
      }>
      if (subs.length === 0) return 0
      const ev = 'event' in what ? what.event : null
      let subject: string
      let message: string
      if (ev) {
        const who = await personName(ev.user)
        const verb = VERBS[ev.action] ?? ev.action
        const fields = ev.changed_fields?.length
          ? ` — changed ${ev.changed_fields.slice(0, 8).join(', ')}`
          : ''
        subject = `Alert: ${rule.name}`
        message = `${who} ${verb} ${ev.collection ?? 'a record'}${ev.item ? ` #${ev.item}` : ''}${fields}`
      } else {
        const d = (what as { digest: { count: number; examples: HeldMatch[] } }).digest
        subject = `Alert digest: ${rule.name}`
        const examples = d.examples
          .map((x) => `${VERBS[x.action] ?? x.action} ${x.collection} #${x.item}`)
          .join('; ')
        message = `${d.count} more ${d.count === 1 ? 'match' : 'matches'} after the hourly limit of ${rule.config.max_per_hour} — e.g. ${examples}`
      }
      const collection = ev?.collection ?? null
      let sent = 0
      for (const s of subs) {
        if (ev && sameId(s.user, ev.user)) continue
        const inapp = s.notify_inapp === true || s.notify_inapp === 1
        const email = s.notify_email === true || s.notify_email === 1
        if (!inapp && !email) continue
        if (collection && !isSystemCollection(collection)) {
          const u = await loadUser(s.user)
          if (!u || !(await can(u, 'read', collection).catch(() => false))) continue
        }
        try {
          await notifyUser(app, s.user, {
            subject,
            message: message.slice(0, 500),
            category: 'audit',
            channels: { inapp, email },
            ...(ev && ev.action !== 'delete' && ev.collection && ev.item
              ? { collection: ev.collection, item: ev.item }
              : { target: { kind: 'alerts', id: rule.id } }),
            source: { kind: 'alert', label: rule.name, id: rule.id },
            why: `You subscribed to the activity alert "${rule.name}".`
          })
          sent++
        } catch {
          /* one recipient never stops the rest */
        }
      }
      return sent
    }
  }
}

/** Hourly sweep: send the digests of every active activity-pattern rule. */
export async function flushActivityPatternDigests(): Promise<number> {
  const rows = (await db('nivaro_alert_definitions')
    .where({ detection_type: ACTIVITY_PATTERN_KIND })
    .where('is_active', true)
    .select('id', 'name', 'collection', 'filters', 'created_by')) as Array<{
    id: number
    name: string
    collection: string
    filters: string | null
    created_by: string | null
  }>
  const deps = realPatternDeps()
  let n = 0
  for (const r of rows) {
    try {
      const rule: PatternRule = {
        id: Number(r.id),
        name: r.name,
        collection: r.collection || '*',
        owner: r.created_by,
        config: normalizePatternConfig(r.filters ? JSON.parse(r.filters) : {})
      }
      n += await flushPatternDigest(rule, deps)
    } catch {
      /* next rule */
    }
  }
  return n
}

/**
 * Validate a rule's record filter as its author (the rule owner) — the same
 * path compiler a read uses, so a filter that could not run is refused at save.
 */
export async function checkPatternFilter(
  owner: User,
  collection: string,
  filter: Record<string, unknown> | null
): Promise<string | null> {
  if (!filter) return null
  if (!collection || collection === '*') return 'A record filter needs one collection'
  try {
    const { filterCheckerFor } = await import('./items.js')
    const check = await filterCheckerFor(owner, collection)
    await check(filter)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'The record filter is not valid'
  }
}

export type AlertDetectionType = 'threshold' | 'anomaly' | typeof ACTIVITY_PATTERN_KIND

export function detectionTypeOf(v: unknown): AlertDetectionType {
  if (v === 'anomaly') return 'anomaly'
  if (v === ACTIVITY_PATTERN_KIND) return ACTIVITY_PATTERN_KIND
  return 'threshold'
}

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * Shape an alert-definition body for the activity-pattern kind, in place:
 * collection ('*' = any business collection), the fixed field/operator/
 * threshold placeholders the table requires, and `filters` = the cleaned
 * ActivityPatternConfig (record filter checked as the rule's owner). For a
 * PATCH, `existing` supplies what the body leaves out. Returns an error
 * message, or null.
 */
export async function preparePatternDefinition(
  body: Record<string, unknown>,
  owner: User,
  existing?: { collection?: string | null; filters?: string | null }
): Promise<string | null> {
  const collection = String(body.collection ?? existing?.collection ?? '*').trim() || '*'
  if (collection !== '*' && !COLLECTION_RE.test(collection)) return 'Unknown collection'
  let raw: unknown = body.filters
  if (raw === undefined && existing?.filters) {
    try {
      raw = JSON.parse(existing.filters)
    } catch {
      raw = {}
    }
  }
  let config: ReturnType<typeof normalizePatternConfig>
  try {
    config = normalizePatternConfig(raw)
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid activity pattern'
  }
  const bad = await checkPatternFilter(owner, collection, config.record_filter)
  if (bad) return bad
  body.collection = collection
  body.field = '*'
  body.operator = 'pattern'
  body.threshold = 0
  body.filters = config
  return null
}
