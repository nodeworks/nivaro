/**
 * Support auto-assign rules (2026-11-16) — the database half: storing the rule
 * set, gathering a request's facts and each candidate's numbers, and deciding
 * who a request goes to. The matching and choosing are pure
 * (services/support-assign-rules.ts).
 *
 * Precedence at create (and when a request's type changes): the first matching
 * rule, then the type's default assignee, then the desk. On a type change a
 * request someone already has is only moved by a rule marked "also when the
 * type changes".
 *
 * Records are read AS THE SYSTEM, only to evaluate a field or step condition;
 * no reason or answer ever carries a record's value.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { getFields } from './collections.js'
import { resolveStateOwners } from './pipeline-engine.js'
import {
  type AssignRule,
  type AssignRuleSet,
  type Candidate,
  insideHours,
  matchRule,
  type Pick,
  parseStoredRuleSet,
  pickPerson,
  type RequestFacts,
  type RequestSource,
  type SharePerson
} from './support-assign-rules.js'
import { teamIdsOf, userName } from './support-tickets.js'
import { currentTenantKey } from './tenant-rooms.js'

export const RULES_EXT = 'nivaro-core'
export const RULES_KEY = 'support_assign_rules'

export async function loadRuleSet(): Promise<AssignRuleSet> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: RULES_EXT, key: RULES_KEY })
      .first('value')) as { value: string | null } | undefined
    return parseStoredRuleSet(row?.value ?? null)
  } catch {
    return parseStoredRuleSet(null)
  }
}

export async function saveRuleSet(set: AssignRuleSet): Promise<void> {
  const value = JSON.stringify(set)
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: RULES_EXT, key: RULES_KEY })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: RULES_EXT,
      key: RULES_KEY,
      value,
      updated_at: new Date()
    })
}

// ── Assignment ledger (who was given what, when) ─────────────────────────────
// Kept in Redis (a sorted set per tenant, 8 days) so "least recently assigned" and "fewest
// assigned today / this week" count every assignment, including ones made by hand. Never
// in a config table: those move the config epoch. Without Redis the numbers come from the
// requests each person holds now (created in the window).

type RedisLike = FastifyInstance['redis'] | undefined
const LEDGER_DAYS = 8
const ledgerKey = () => `nvr:support-assigned:${currentTenantKey()}`

export function noteAssignment(redis: RedisLike, userId: string | null, ticketId: number): void {
  if (!redis || !userId) return
  const now = Date.now()
  const key = ledgerKey()
  void (async () => {
    try {
      await redis.zadd(key, now, `${userId.toUpperCase()}:${ticketId}`)
      await redis.zremrangebyscore(key, 0, now - LEDGER_DAYS * 86_400_000)
      await redis.expire(key, LEDGER_DAYS * 86_400)
    } catch {
      // the ledger is best-effort
    }
  })()
}

async function ledgerEvents(redis: RedisLike): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  if (!redis) return out
  try {
    const rows = await redis.zrangebyscore(
      ledgerKey(),
      Date.now() - LEDGER_DAYS * 86_400_000,
      '+inf',
      'WITHSCORES'
    )
    for (let i = 0; i < rows.length; i += 2) {
      const user = String(rows[i]).split(':')[0]
      const at = Number(rows[i + 1])
      out.set(user, [...(out.get(user) ?? []), at])
    }
  } catch {
    // no ledger: the DB numbers stand alone
  }
  return out
}

/** Start of today and of this week (Monday), Eastern. */
function windowStarts(now: Date): { today: number; week: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const g = (t: string) => fmt.find((p) => p.type === t)?.value ?? '0'
  const sinceMidnight =
    (Number(g('hour')) * 3600 + Number(g('minute')) * 60 + Number(g('second'))) * 1000
  const today = now.getTime() - sinceMidnight
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(g('weekday'))
  return { today, week: today - Math.max(0, dow) * 86_400_000 }
}

// ── Facts ────────────────────────────────────────────────────────────────────

export interface RequestDraft {
  category_id: number | null
  collection: string | null
  item: string | null
  requester: string | null
  priority: string
  title: string
  description: string | null
  source?: RequestSource | null
  issue_id?: number | null
  at?: Date
}

export function sourceOf(d: RequestDraft): RequestSource {
  if (d.source) return d.source
  if (d.issue_id != null) return 'report_problem'
  return d.collection ? 'record' : 'general'
}

const COL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** The record's current pipeline instance + step (latest instance), or nulls. */
async function recordStep(
  collection: string,
  item: string
): Promise<{ instance: string | null; state: string | null }> {
  try {
    const row = (await db('nivaro_workflow_instances')
      .where({ collection, item })
      .orderBy('started_at', 'desc')
      .first('id', 'current_state')) as { id: string; current_state: string } | undefined
    return { instance: row?.id ?? null, state: row?.current_state ?? null }
  } catch {
    return { instance: null, state: null }
  }
}

/** Everything the set's conditions read about this request. Reads only what is asked. */
export async function gatherFacts(set: AssignRuleSet, d: RequestDraft): Promise<RequestFacts> {
  const conds = set.rules.filter((r) => r.active).flatMap((r) => r.conditions)
  const fields: Record<string, unknown> = {}
  let state: string | null = null
  if (d.collection && d.item) {
    const wanted = [
      ...new Set(
        conds.flatMap((c) => (c.kind === 'field' && c.collection === d.collection ? [c.field] : []))
      )
    ]
    if (wanted.length) {
      const defs = await getFields(d.collection).catch(() => [])
      const cols = wanted
        .map((f) => {
          const def = defs.find((x) => x.field === f)
          const col = def ? (def.db_column ?? def.field) : null
          return col && COL_RE.test(col) ? { f, col } : null
        })
        .filter((x): x is { f: string; col: string } => !!x)
      if (cols.length) {
        const row = (await db(d.collection)
          .where('id', d.item)
          .first(cols.map((c) => `${c.col} as ${c.f}`))
          .catch(() => undefined)) as Record<string, unknown> | undefined
        for (const c of cols) fields[`${d.collection}.${c.f}`] = row?.[c.f] ?? null
      }
    }
    if (conds.some((c) => c.kind === 'step') || set.rules.some((r) => usesStepOwners(r)))
      state = (await recordStep(d.collection, d.item)).state
  }
  let role: string | null = null
  let teams: number[] = []
  if (d.requester) {
    if (conds.some((c) => c.kind === 'requester_role')) {
      const u = (await db('nivaro_users')
        .where('id', d.requester)
        .first('role')
        .catch(() => undefined)) as { role: string | null } | undefined
      role = u?.role ? String(u.role) : null
    }
    if (conds.some((c) => c.kind === 'requester_team')) teams = await teamIdsOf(d.requester)
  }
  return {
    category_id: d.category_id,
    collection: d.collection,
    item: d.item,
    fields,
    state,
    requester: d.requester,
    requester_role: role,
    requester_teams: teams,
    priority: d.priority,
    title: d.title,
    description: d.description ?? '',
    source: sourceOf(d),
    at: d.at ?? new Date()
  }
}

function usesStepOwners(r: AssignRule): boolean {
  return (
    r.action.kind === 'step_owner' ||
    (r.action.kind === 'share' && r.action.strategy === 'step_owner')
  )
}

// ── Candidates ───────────────────────────────────────────────────────────────

interface UserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  status: string | null
  is_redacted: boolean | number | null
  is_out_of_office: boolean | number | null
  delegate_id: string | null
  delegate_expires_at: Date | null
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1'
const up = (s: unknown) => String(s ?? '').toUpperCase()

async function usersById(ids: string[]): Promise<Map<string, UserRow>> {
  if (!ids.length) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', ids.slice(0, 500))
    .select(
      'id',
      'first_name',
      'last_name',
      'email',
      'status',
      'is_redacted',
      'is_out_of_office',
      'delegate_id',
      'delegate_expires_at'
    )
    .catch(() => [])) as UserRow[]
  return new Map(rows.map((r) => [up(r.id), r]))
}

const inactive = (u: UserRow | undefined) =>
  !u || truthy(u.is_redacted) || (u.status != null && u.status !== 'active')

/** Numbers for each id: availability, cover, load, history with this kind / this requester. */
export async function gatherCandidates(
  ids: string[],
  ctx: {
    category_id: number | null
    collection: string | null
    requester: string | null
    stepOwners: Set<string>
    redis: RedisLike
    now: Date
  }
): Promise<Map<string, Candidate>> {
  const want = [...new Set(ids.map(up))]
  const users = await usersById(want)
  // Covers of anyone out of office (a working cover: active, not out themselves).
  const coverIds = [...users.values()]
    .filter(
      (u) =>
        truthy(u.is_out_of_office) &&
        u.delegate_id &&
        (!u.delegate_expires_at || new Date(u.delegate_expires_at) > ctx.now)
    )
    .map((u) => up(u.delegate_id))
  const covers = await usersById(coverIds.filter((c) => !users.has(c)))
  for (const [k, v] of users) covers.set(k, v)
  const everyone = [...new Set([...want, ...coverIds])]

  const loads = (await db('nivaro_tasks')
    .where('kind', 'support')
    .whereIn('status', ['open', 'in_progress'])
    .whereIn('assignee', everyone.length ? everyone : ['00000000-0000-0000-0000-000000000000'])
    .groupBy('assignee')
    .select('assignee')
    .count('* as n')
    .select(db.raw("SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) as urgent"))
    .catch(() => [])) as Array<{ assignee: string; n: number; urgent: number }>
  const load = new Map(loads.map((l) => [up(l.assignee), l]))

  const closedQ = db('nivaro_tasks')
    .where('kind', 'support')
    .where('status', 'done')
    .whereIn('assignee', everyone.length ? everyone : ['00000000-0000-0000-0000-000000000000'])
  if (ctx.category_id != null) closedQ.where('category_id', ctx.category_id)
  else if (ctx.collection) closedQ.where('collection', ctx.collection)
  else closedQ.whereNull('collection').whereNull('category_id')
  const closed = new Map(
    (
      (await closedQ
        .groupBy('assignee')
        .select('assignee')
        .count('* as n')
        .catch(() => [])) as Array<{ assignee: string; n: number }>
    ).map((r) => [up(r.assignee), Number(r.n)])
  )

  const helped = new Map<string, number>()
  if (ctx.requester) {
    const rows = (await db('nivaro_tasks')
      .where({ kind: 'support', created_by: ctx.requester })
      .whereIn('assignee', everyone.length ? everyone : ['00000000-0000-0000-0000-000000000000'])
      .groupBy('assignee')
      .select('assignee')
      .max('created_at as at')
      .catch(() => [])) as Array<{ assignee: string; at: Date | string }>
    for (const r of rows) helped.set(up(r.assignee), new Date(r.at).getTime())
  }

  // Assignments in the last 8 days: the ledger, plus requests they hold now that were raised
  // in the window (so a missing ledger still counts something).
  const { today, week } = windowStarts(ctx.now)
  const ledger = await ledgerEvents(ctx.redis)
  const held = (await db('nivaro_tasks')
    .where('kind', 'support')
    .whereIn('assignee', everyone.length ? everyone : ['00000000-0000-0000-0000-000000000000'])
    .where('created_at', '>=', new Date(ctx.now.getTime() - LEDGER_DAYS * 86_400_000))
    .select('assignee', 'created_at', 'id')
    .catch(() => [])) as Array<{ assignee: string; created_at: Date; id: number }>
  const events = new Map<string, number[]>()
  for (const [u, at] of ledger) events.set(u, [...at])
  for (const h of held) {
    const u = up(h.assignee)
    const list = events.get(u) ?? []
    const t = new Date(h.created_at).getTime()
    // A request the ledger already counted has a ledger stamp at or after its creation.
    if (!list.some((x) => Math.abs(x - t) < 60_000)) list.push(t)
    events.set(u, list)
  }
  // Last assignment ever (beyond the window): the newest request they hold.
  const lastHeld = new Map(
    (
      (await db('nivaro_tasks')
        .where('kind', 'support')
        .whereIn('assignee', everyone.length ? everyone : ['00000000-0000-0000-0000-000000000000'])
        .groupBy('assignee')
        .select('assignee')
        .max('created_at as at')
        .catch(() => [])) as Array<{ assignee: string; at: Date | string }>
    ).map((r) => [up(r.assignee), new Date(r.at).getTime()])
  )

  const online = new Set<string>()
  try {
    const rows = (await db('user_presence')
      .whereIn('user_id', everyone.length ? everyone : ['00000000-0000-0000-0000-000000000000'])
      .where('last_seen', '>=', new Date(ctx.now.getTime() - 70_000))
      .where((q) => q.whereNull('is_online').orWhere('is_online', true))
      .select('user_id')) as Array<{ user_id: string }>
    for (const r of rows) online.add(up(r.user_id))
  } catch {
    // no presence: nobody reads as online
  }

  const out = new Map<string, Candidate>()
  for (const id of everyone) {
    const u = covers.get(id)
    const ev = events.get(id) ?? []
    const coverId =
      u &&
      truthy(u.is_out_of_office) &&
      u.delegate_id &&
      (!u.delegate_expires_at || new Date(u.delegate_expires_at) > ctx.now)
        ? up(u.delegate_id)
        : null
    const cover = coverId ? covers.get(coverId) : undefined
    const workingCover =
      cover && !inactive(cover) && !truthy(cover.is_out_of_office)
        ? { id: coverId as string, name: userName(cover) ?? 'their cover' }
        : null
    const lastLedger = ev.length ? Math.max(...ev) : null
    const last = Math.max(
      lastLedger ?? Number.NEGATIVE_INFINITY,
      lastHeld.get(id) ?? Number.NEGATIVE_INFINITY
    )
    out.set(id, {
      id,
      name: userName(u) ?? 'Unknown person',
      inactive: inactive(u),
      out_of_office: !!u && truthy(u.is_out_of_office),
      cover: workingCover,
      online: online.has(id),
      open: Number(load.get(id)?.n ?? 0),
      urgent_open: Number(load.get(id)?.urgent ?? 0),
      last_assigned: Number.isFinite(last) ? last : null,
      assigned_today: ev.filter((t) => t >= today).length,
      assigned_week: ev.filter((t) => t >= week).length,
      closed_same: closed.get(id) ?? 0,
      last_helped: helped.get(id) ?? null,
      step_owner: ctx.stepOwners.has(id)
    })
  }
  for (const c of out.values()) if (c.cover) c.cover.stats = out.get(c.cover.id)
  return out
}

/** The record's current step owners (after delegation), active ones first in owner order. */
async function stepOwnersOf(d: RequestDraft): Promise<string[]> {
  if (!d.collection || !d.item) return []
  const { instance, state } = await recordStep(d.collection, d.item)
  if (!state) return []
  try {
    const owners = await resolveStateOwners(state, instance, d.collection, d.item)
    return [...new Set(owners.map((o) => up(o.id)))]
  } catch {
    return []
  }
}

// ── Deciding ─────────────────────────────────────────────────────────────────

export interface RuleTrace {
  id: string
  name: string
  active: boolean
  /** matched = this rule decided; no_match; not_reached = an earlier rule decided; held = it
   *  matched but does not run on a type change for a request someone has. */
  result: 'matched' | 'no_match' | 'not_reached' | 'held'
  reasons: string[]
}

export type Outcome =
  | {
      kind: 'person'
      user: { id: string; name: string }
      via: 'rule' | 'rule_fallback' | 'type_default'
      rule: { id: string; name: string } | null
      note: string
    }
  | {
      kind: 'team'
      team: { id: number; name: string }
      via: 'rule'
      rule: { id: string; name: string }
      note: string
    }
  | {
      kind: 'desk'
      via: 'rule_fallback' | 'no_rule' | 'keep'
      rule: { id: string; name: string } | null
      note: string
    }

export interface Decision {
  trace: RuleTrace[]
  outcome: Outcome
  pick: Pick | null
  /** Steps of the record's owners the action looked at (step_owner). */
  facts_used: { state: boolean; fields: number }
}

async function nameOfUser(id: string): Promise<string> {
  const u = (await usersById([id])).get(up(id))
  return userName(u) ?? 'Unknown person'
}

/**
 * Who a request goes to. `trigger` create = a new request; type_change = its type just
 * changed (a request someone has is only moved by a rule marked for it). `typeDefault` is
 * the type's default assignee.
 */
export async function decideAssignment(
  set: AssignRuleSet,
  d: RequestDraft,
  opts: {
    trigger: 'create' | 'type_change'
    hasAssignee: boolean
    typeDefault: string | null
    redis: RedisLike
    fieldLabel?: (collection: string, field: string) => string
  }
): Promise<Decision> {
  const facts = await gatherFacts(set, d)
  const trace: RuleTrace[] = []
  let decided: { rule: AssignRule } | null = null
  for (const rule of set.rules) {
    if (decided) {
      trace.push({
        id: rule.id,
        name: rule.name,
        active: rule.active,
        result: 'not_reached',
        reasons: []
      })
      continue
    }
    const m = matchRule(rule, facts, set.hours, { field: opts.fieldLabel })
    if (!m.matched) {
      trace.push({
        id: rule.id,
        name: rule.name,
        active: rule.active,
        result: 'no_match',
        reasons: m.reasons
      })
      continue
    }
    if (opts.trigger === 'type_change' && opts.hasAssignee && !rule.on_type_change) {
      trace.push({
        id: rule.id,
        name: rule.name,
        active: rule.active,
        result: 'held',
        reasons: [
          'someone already has the request, and this rule does not run when the type changes'
        ]
      })
      continue
    }
    trace.push({
      id: rule.id,
      name: rule.name,
      active: rule.active,
      result: 'matched',
      reasons: []
    })
    decided = { rule }
  }
  const facts_used = { state: !!facts.state, fields: Object.keys(facts.fields).length }

  if (!decided) {
    if (opts.typeDefault && !(opts.trigger === 'type_change' && opts.hasAssignee))
      return {
        trace,
        pick: null,
        facts_used,
        outcome: {
          kind: 'person',
          user: { id: up(opts.typeDefault), name: await nameOfUser(opts.typeDefault) },
          via: 'type_default',
          rule: null,
          note: 'No rule matched; the type’s default assignee takes it.'
        }
      }
    return {
      trace,
      pick: null,
      facts_used,
      outcome: {
        kind: 'desk',
        via: opts.trigger === 'type_change' && opts.hasAssignee ? 'keep' : 'no_rule',
        rule: null,
        note:
          opts.trigger === 'type_change' && opts.hasAssignee
            ? 'It stays with whoever has it.'
            : 'No rule matched; it waits on the desk.'
      }
    }
  }

  const rule = decided.rule
  const ruleRef = { id: rule.id, name: rule.name }
  const now = facts.at
  const inside = insideHours(now, set.hours)
  const fallback = async (why: string, pick: Pick | null): Promise<Decision> => {
    if (rule.fallback.kind === 'person')
      return {
        trace,
        pick,
        facts_used,
        outcome: {
          kind: 'person',
          user: { id: rule.fallback.user, name: await nameOfUser(rule.fallback.user) },
          via: 'rule_fallback',
          rule: ruleRef,
          note: `${why} The rule’s fallback takes it.`
        }
      }
    return {
      trace,
      pick,
      facts_used,
      outcome: {
        kind: 'desk',
        via: 'rule_fallback',
        rule: ruleRef,
        note: `${why} It waits on the desk.`
      }
    }
  }

  const a = rule.action
  if (a.kind === 'team') {
    const team = (await db('nivaro_user_groups')
      .where('id', a.team)
      .first('id', 'name')
      .catch(() => undefined)) as { id: number; name: string } | undefined
    if (!team) return fallback('The rule’s team no longer exists.', null)
    return {
      trace,
      pick: null,
      facts_used,
      outcome: {
        kind: 'team',
        team: { id: Number(team.id), name: team.name },
        via: 'rule',
        rule: ruleRef,
        note: `Sent to ${team.name}’s desk, unassigned.`
      }
    }
  }

  let people: SharePerson[] = []
  let strategy: Parameters<typeof pickPerson>[1] = 'fewest_open'
  let giveToCover = false
  let keepOrder = false
  let stepOwners: string[] = []
  if (a.kind === 'person') {
    people = [{ id: a.user, cap: null, when: 'always' }]
    giveToCover = true
  } else if (a.kind === 'share') {
    people = a.people
    strategy = a.strategy
    giveToCover = a.give_to_cover
    if (a.strategy === 'step_owner') stepOwners = await stepOwnersOf(d)
  } else {
    stepOwners = await stepOwnersOf(d)
    if (!stepOwners.length) return fallback('The record has no step owner.', null)
    people = stepOwners.map((id) => ({ id, cap: null, when: 'always' as const }))
    keepOrder = a.pick === 'first'
    giveToCover = true
  }
  const numbers = await gatherCandidates(
    people.map((p) => p.id),
    {
      category_id: d.category_id,
      collection: d.collection,
      requester: d.requester,
      stepOwners: new Set(stepOwners),
      redis: opts.redis,
      now
    }
  )
  const rows = people.map((p) => ({
    ...(numbers.get(up(p.id)) as Candidate),
    cap: p.cap,
    when: p.when
  }))
  const pick = pickPerson(rows, strategy, {
    giveToCover,
    insideHours: inside,
    now: now.getTime(),
    keepOrder
  })
  if (!pick.winner) return fallback('Nobody on the rule could take it.', pick)
  return {
    trace,
    pick,
    facts_used,
    outcome: {
      kind: 'person',
      user: pick.winner,
      via: 'rule',
      rule: ruleRef,
      note:
        a.kind === 'share'
          ? `Shared among ${people.length}: ${pick.ranking[0]?.measure ?? ''}.`
          : a.kind === 'step_owner'
            ? 'The record’s step owner.'
            : 'Assigned by name.'
    }
  }
}
