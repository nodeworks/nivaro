import type { Knex } from 'knex'
import { runBookkeepingWrite } from '../../db/config-epoch.js'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { rawRows } from '../../db/raw-rows.js'
import { sqlDialect } from '../../db/sql-dialect.js'
import { NIVARO_VERSION } from '../../version.js'
import { registerAppKeyed } from '../app-forget.js'
import { appEnvironment } from '../app-info-environment.js'
import { appBox, appMap, appSet } from '../app-state.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { groupSimilarIssues } from '../issue-groups.js'
import { hitCounts, hitKey } from '../issue-raise.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { getConnection, type TrackerConnection } from './connections.js'
import { trackersEnabled } from './feature.js'
import { LINKS, MEMBERS, SOURCE_ISSUE } from './link-store.js'
import { CONNECTION_CAP_PER_HOUR, requestCreate } from './links.js'
import { enqueue, OUTBOX } from './outbox.js'
import {
  type Counts,
  evaluateRule,
  evaluateTicketRule,
  type GuardState,
  type IssueFacts,
  nextQuietEnd,
  type Outcome,
  type TicketFacts
} from './rule-eval.js'
import { type TrackerRule, type ValidateResult, validateRule } from './rules.js'
import { findHome, joinAsExample } from './similar.js'
import { IMPORTED_SOURCE, isSyncOwnSource, personWritten, sourceOn } from './source-switch.js'
import { defaultBodyTemplate } from './templates.js'

/**
 * The rule engine runner: reads the facts of one issue, walks the enabled rules in `sort` order
 * (rule-eval.ts decides each one), and acts — a fire first looks for a home (findHome: same
 * fingerprint, same group, a similar GitLab issue) and joins it as an example, else queues a
 * GitLab create; a suggest marks the issue (`nivaro_issues.tracker_suggested_rule`). Every outcome
 * but `no_match` is kept in `nivaro_tracker_decisions` (last 200 per rule) so "why didn't it
 * fire?" always has an answer. Quiet hours are stored with the window's end and re-tried by the
 * sweep once it passes.
 */

export const RULES = 'nivaro_tracker_rules'
export const DECISIONS = 'nivaro_tracker_decisions'
/** Decision rows kept per rule. */
export const KEEP_DECISIONS = 200
/** 'fired' rows younger than this are never trimmed (the caps count the last 24 h). */
export const FIRED_KEEP_MS = 25 * 3_600_000
/** Decision rows about the sweep itself (no rule). */
export const SWEEP_RULE = 0
/**
 * Decision rows of the flow step gitlab.create_issue ("Flow"): claimed like a rule's fire, with
 * the connection on the row, so flow-created GitLab issues count toward the connection cap.
 */
export const FLOW_RULE = -1
/**
 * Decision rows of a create by a non-admin (a connection's create_roles, "Person"): claimed like a
 * flow's, so person-made GitLab issues count toward the connection cap too.
 */
export const PERSON_RULE = -2
/** Pseudo rules whose decision rows carry their connection (counted toward its cap). */
export const CONNECTION_RULES = [FLOW_RULE, PERSON_RULE]
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const DETAIL_MAX = 500
const SKIP_STATUSES = ['resolved', 'closed']

type Row = Record<string, unknown>

const parseObj = (v: unknown): Row => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Row
  if (typeof v !== 'string' || !v) return {}
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Row) : {}
  } catch {
    return {}
  }
}
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
const toDate = (v: unknown): Date | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}
const iso = (v: unknown): string => toDate(v)?.toISOString() ?? ''
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ── Stored rules ──────────────────────────────────────────────────────────────

/** The rule as validateRule sees it: the stored row's columns + JSON parts. */
function rawRule(row: Row): Row {
  const action = parseObj(row.action)
  if (action.connection == null && row.connection != null)
    action.connection = Number(row.connection)
  return {
    ...(row.applies_to != null ? { applies_to: row.applies_to } : {}),
    name: row.name,
    enabled: truthy(row.enabled),
    mode: row.mode,
    sort: Number(row.sort ?? 0),
    continue_after: truthy(row.continue_after),
    match: parseObj(row.match),
    threshold: parseObj(row.threshold),
    guards: parseObj(row.guards),
    action
  }
}

/** A stored rule row as a TrackerRule (defaults filled), or null when it no longer validates. */
export function ruleFromRow(row: Row): TrackerRule | null {
  const res = validateRule(rawRule(row))
  return res.ok ? { id: Number(row.id), ...res.rule } : null
}

export interface RuleView {
  id: number
  /** 'issue' (the issue log) or 'ticket' (support requests). */
  applies_to: string
  name: string
  description: string | null
  enabled: boolean
  mode: string
  sort: number
  continue_after: boolean
  connection: number
  match: Row
  threshold: Row
  guards: Row
  action: Row
  last_fired_at: string | null
  fired_count: number
  suppressed_count: number
  paused_reason: string | null
  created_at: string | null
  updated_at: string | null
  /** False when the stored rule no longer passes validation (it never runs then). */
  valid: boolean
  errors?: Array<{ path: string; message: string }>
}

export function ruleView(row: Row): RuleView {
  const res = validateRule(rawRule(row))
  const base = res.ok ? res.rule : (rawRule(row) as unknown as Omit<TrackerRule, 'id'>)
  return {
    id: Number(row.id),
    applies_to: row.applies_to === 'ticket' ? 'ticket' : 'issue',
    name: String(row.name ?? ''),
    description: row.description == null ? null : String(row.description),
    enabled: truthy(row.enabled),
    mode: String(base.mode ?? row.mode ?? 'suggest'),
    sort: Number(row.sort ?? 0),
    continue_after: truthy(row.continue_after),
    connection: Number(row.connection),
    match: base.match as unknown as Row,
    threshold: base.threshold as unknown as Row,
    guards: base.guards as unknown as Row,
    action: base.action as unknown as Row,
    last_fired_at: iso(row.last_fired_at) || null,
    fired_count: Number(row.fired_count ?? 0) || 0,
    suppressed_count: Number(row.suppressed_count ?? 0) || 0,
    paused_reason: row.paused_reason == null ? null : String(row.paused_reason),
    created_at: iso(row.created_at) || null,
    updated_at: iso(row.updated_at) || null,
    valid: res.ok,
    ...(res.ok ? {} : { errors: res.errors })
  }
}

/** A rule about the issue log (a missing applies_to is one). */
export const isIssueRule = (r: TrackerRule) => (r.applies_to ?? 'issue') === 'issue'
export const isTicketRule = (r: TrackerRule) => r.applies_to === 'ticket'

/** Enabled, valid, not paused rules in the order they run (issue and ticket rules). */
export async function enabledRules(): Promise<TrackerRule[]> {
  const rows = (await db(RULES)
    .where({ enabled: true })
    .orderBy('sort', 'asc')
    .orderBy('id', 'asc')) as Row[]
  return rows
    .filter((r) => r.paused_reason == null || r.paused_reason === '')
    .map(ruleFromRow)
    .filter((r): r is TrackerRule => r !== null)
}

// ── Facts ─────────────────────────────────────────────────────────────────────

const HAS_SCREENSHOT = 'CASE WHEN screenshot IS NULL THEN 0 ELSE 1 END AS has_screenshot'
const ISSUE_COLS = [
  'id',
  'title',
  'details',
  'severity',
  'status',
  'source',
  'collection',
  'item',
  'fingerprint',
  'raised_by',
  'assigned_to',
  'created_at',
  'updated_at',
  'last_seen_at',
  'occurrence_count',
  'recording_id',
  'tracker_suggested_rule'
]

interface IssueContext {
  row: Row
  facts: IssueFacts
  /** Connections this issue is already a member of a link on. */
  linkedOn: Set<number>
}

/** The cluster lead of the issue's current group (issue-groups, cached 10 min in-process). */
async function groupLeadOf(issueId: number): Promise<number | null> {
  try {
    const groups = await groupSimilarIssues()
    const g = groups.find((x) => x.lead.id === issueId || x.variants.some((v) => v.id === issueId))
    return g ? g.lead.id : null
  } catch {
    return null
  }
}

/**
 * Where each IssueFacts field comes from:
 * - id, title, details, severity, status, source, collection, item, fingerprint, raised_by,
 *   assigned_to, created_at: the `nivaro_issues` row itself.
 * - route, build: the NEWEST `nivaro_issue_occurrences` row (the table keeps the last 50 hits /
 *   30 days per issue); null when the issue has none (manual reports).
 * - first_build: the OLDEST occurrence row that names a build (oldest still kept, so "new in the
 *   current release" is judged over the last 50 hits / 30 days).
 * - environment: this instance's environment (appEnvironment()) — occurrence rows carry no
 *   environment, and one instance serves one environment.
 * - current_build: this API's version (NIVARO_VERSION); the release image ships API + admin
 *   together, so client builds of the current release carry the same version.
 * - raised_by_role: the role id of the person who raised it (`nivaro_users.role`).
 * - has_screenshot: `screenshot IS NOT NULL`; has_replay: `recording_id` is set.
 * - linked: a member row on ANY connection (evaluateIssue narrows it to the rule's connection).
 * - recurrences: earlier `nivaro_issues` rows (lower id) with the same fingerprint that are
 *   resolved or closed.
 * - total_hits: `occurrence_count`.
 * - group_lead_id: the lead of the issue's group from issue-groups clustering
 *   (groupSimilarIssues, cached 10 min in-process) — read only when asked for (`groupLead`),
 *   which evaluateIssue does only when an enabled rule matches on group leads; else null.
 */
async function loadContext(
  issueId: number,
  opts: { groupLead?: boolean } = {}
): Promise<IssueContext | null> {
  if (!Number.isFinite(issueId)) return null
  const row = (await db('nivaro_issues')
    .where({ id: issueId })
    .select([...ISSUE_COLS, db.raw(HAS_SCREENSHOT)])
    .first()) as Row | undefined
  if (!row) return null

  const newest = (await db('nivaro_issue_occurrences')
    .where({ issue: issueId })
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .first('route', 'build')) as Row | undefined
  const oldest = (await db('nivaro_issue_occurrences')
    .where({ issue: issueId })
    .whereNotNull('build')
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .first('build')) as Row | undefined

  let recurrences = 0
  if (row.fingerprint) {
    const r = (await db('nivaro_issues')
      .where({ fingerprint: row.fingerprint })
      .where('id', '<', issueId)
      .whereIn('status', SKIP_STATUSES)
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    recurrences = Number(r?.n ?? 0) || 0
  }

  let role: string | null = null
  if (row.raised_by) {
    const u = (await db('nivaro_users').where({ id: row.raised_by }).first('role')) as
      | Row
      | undefined
    role = u?.role == null ? null : String(u.role)
  }

  const members = (await db(MEMBERS)
    .where({ source_kind: SOURCE_ISSUE, source_id: String(issueId) })
    .select('connection')) as Row[]
  const linkedOn = new Set(members.map((m) => Number(m.connection)))
  // A create still waiting in the outbox (or dead until an admin retries / discards it) counts as
  // linked: re-evaluating before GitLab answers must not fire again.
  const queued = (await db(OUTBOX)
    .where({ op: 'create', source_kind: SOURCE_ISSUE, source_id: String(issueId) })
    .whereIn('status', ['pending', 'sending', 'dead'])
    .select('connection')) as Row[]
  for (const q of queued) linkedOn.add(Number(q.connection))

  const facts: IssueFacts = {
    id: issueId,
    title: String(row.title ?? ''),
    details: row.details == null ? null : String(row.details),
    severity: String(row.severity ?? ''),
    status: String(row.status ?? 'open'),
    source: String(row.source ?? 'manual'),
    route: newest?.route ? String(newest.route) : null,
    collection: row.collection == null ? null : String(row.collection),
    item: row.item == null ? null : String(row.item),
    environment: appEnvironment(),
    build: newest?.build ? String(newest.build) : null,
    current_build: NIVARO_VERSION,
    first_build: oldest?.build ? String(oldest.build) : null,
    fingerprint: row.fingerprint ? String(row.fingerprint) : null,
    group_lead_id: opts.groupLead ? await groupLeadOf(issueId) : null,
    raised_by: row.raised_by == null ? null : String(row.raised_by),
    raised_by_role: role,
    assigned_to: row.assigned_to == null ? null : String(row.assigned_to),
    has_screenshot: Number(row.has_screenshot) === 1,
    has_replay: !!row.recording_id,
    created_at: toDate(row.created_at) ?? new Date(),
    linked: linkedOn.size > 0,
    recurrences,
    total_hits: Number(row.occurrence_count ?? 1) || 1
  }
  return { row, facts, linkedOn }
}

/** The facts a rule is judged on (see loadContext for where each field comes from). */
export async function loadFacts(
  issueId: number,
  opts: { groupLead?: boolean } = {}
): Promise<IssueFacts | null> {
  return (await loadContext(issueId, opts))?.facts ?? null
}

// ── Counts + guards ───────────────────────────────────────────────────────────

const ZERO_COUNTS: Counts = { hits: () => 0, people: () => 0 }
const ZERO_GUARDS: GuardState = {
  firedLastHour: 0,
  firedLastDay: 0,
  connectionLastHour: 0,
  connectionCap: CONNECTION_CAP_PER_HOUR
}

/** hitCounts per window, read once per window per evaluation. */
class CountCache {
  private byWindow = new Map<number, { hits: number; people: number }>()
  constructor(
    private key: string,
    private now: Date
  ) {}
  async load(rule: TrackerRule): Promise<void> {
    const windows = [rule.threshold.hits?.window_minutes, rule.threshold.people?.window_minutes]
    for (const w of windows) {
      if (w === undefined || this.byWindow.has(w)) continue
      try {
        this.byWindow.set(w, await hitCounts(this.key, new Date(this.now.getTime() - w * 60_000)))
      } catch {
        this.byWindow.set(w, { hits: 0, people: 0 })
      }
    }
  }
  counts(): Counts {
    return {
      hits: (w) => this.byWindow.get(w)?.hits ?? 0,
      people: (w) => this.byWindow.get(w)?.people ?? 0
    }
  }
}

async function guardState(rule: TrackerRule, now: Date): Promise<GuardState> {
  const hourAgo = now.getTime() - HOUR_MS
  const fired = (await db(DECISIONS)
    .where({ rule: rule.id, outcome: 'fired' })
    .where('at', '>=', new Date(now.getTime() - DAY_MS))
    .select('at')) as Row[]
  return {
    firedLastHour: fired.filter((r) => (toDate(r.at)?.getTime() ?? 0) >= hourAgo).length,
    firedLastDay: fired.length,
    connectionLastHour: await connectionFiredSince(db, rule.action.connection, new Date(hourAgo)),
    connectionCap: CONNECTION_CAP_PER_HOUR
  }
}

/** 'fired' decisions of every rule on this connection since `since`. */
async function connectionFiredSince(
  q: typeof db | Knex.Transaction,
  connection: number,
  since: Date
): Promise<number> {
  const flows = (await q(DECISIONS)
    .whereIn('rule', CONNECTION_RULES)
    .where({ connection, outcome: 'fired' })
    .where('at', '>', since)
    .count({ n: '*' })
    .first()) as { n?: number | string } | undefined
  const fromFlows = Number(flows?.n ?? 0) || 0
  const rules = ((await q(RULES).where({ connection }).select('id')) as Row[]).map((r) =>
    Number(r.id)
  )
  if (!rules.length) return fromFlows
  const n = (await whereInList(q(DECISIONS), 'rule', rules)
    .where({ outcome: 'fired' })
    .where('at', '>', since)
    .count({ n: '*' })
    .first()) as { n?: number | string } | undefined
  return (Number(n?.n ?? 0) || 0) + fromFlows
}

// ── Claiming a fire (the caps, atomically) ────────────────────────────────────

export interface ClaimParams {
  rule: number
  issue: number
  connection: number
  at: Date
  perHour: number
  perDay: number
  connectionCap: number
}

/** The placeholder detail of a claimed slot until the fire says what it did. */
export const CLAIM_DETAIL = 'firing'

/**
 * The conditional INSERT that claims a fire: the 'fired' decision row is written only while the
 * rule is under its hourly and daily caps and the rule's connection under its hourly cap
 * ('fired' decisions of every rule on that connection). Every value is bound. On SQL Server the
 * counts take UPDLOCK + HOLDLOCK range locks, so two claimers cannot both read "under the cap";
 * the caller also holds the one global claim app lock (no lock-order deadlocks between rules).
 */
export function claimStatement(
  p: ClaimParams,
  dialect: boolean | 'mssql' | 'pg' | 'mysql'
): { sql: string; bindings: unknown[] } {
  const mssql = dialect === true || dialect === 'mssql'
  const mysql = dialect === 'mysql'
  const hourAgo = new Date(p.at.getTime() - HOUR_MS)
  const dayAgo = new Date(p.at.getTime() - DAY_MS)
  const hint = mssql ? ' WITH (UPDLOCK, HOLDLOCK)' : ''
  const output = mssql ? ' OUTPUT inserted.[id]' : ''
  // RULE is a reserved word in T-SQL: every identifier is quoted.
  const q = (id: string) => (mssql ? `[${id}]` : mysql ? `\`${id}\`` : `"${id}"`)
  const [rule, issue, at, outcome, detail, connection, id] = [
    'rule',
    'issue',
    'at',
    'outcome',
    'detail',
    'connection',
    'id'
  ].map(q)
  const sql = `INSERT INTO ${q(DECISIONS)} (${rule}, ${issue}, ${at}, ${outcome}, ${detail}, ${connection})${output}
SELECT ?, ?, ?, 'fired', ?, ?${mysql ? ' FROM DUAL' : ''}
WHERE (SELECT COUNT(*) FROM ${q(DECISIONS)}${hint} WHERE ${rule} = ? AND ${outcome} = 'fired' AND ${at} > ?) < ?
  AND (SELECT COUNT(*) FROM ${q(DECISIONS)}${hint} WHERE ${rule} = ? AND ${outcome} = 'fired' AND ${at} > ?) < ?
  AND (SELECT COUNT(*) FROM ${q(DECISIONS)} d${hint} LEFT JOIN ${q(RULES)} r ON r.${id} = d.${rule}
       WHERE (r.${connection} = ? OR (d.${rule} IN (?, ?) AND d.${connection} = ?))
         AND d.${outcome} = 'fired' AND d.${at} > ?) < ?`
  return {
    sql,
    bindings: [
      p.rule,
      p.issue,
      p.at,
      CLAIM_DETAIL,
      p.connection,
      p.rule,
      hourAgo,
      p.perHour,
      p.rule,
      dayAgo,
      p.perDay,
      p.connection,
      FLOW_RULE,
      PERSON_RULE,
      p.connection,
      hourAgo,
      p.connectionCap
    ]
  }
}

const CLAIM_LOCK_TIMEOUT_MS = 15_000
/**
 * ONE app lock for every claim (claims are rare): rules on different connections can then never
 * deadlock on the (rule, at) index ranges the counts lock.
 */
export const CLAIM_LOCK = 'nivaro-tracker-claim'

/**
 * Claim one fire of `rule` for `issue` before anything is sent. `ok` → the claimed decision row
 * (outcome 'fired', detail 'firing' until the fire fills it in). Not ok → which cap held. One
 * short transaction: the global claim app lock, then the conditional INSERT.
 */
export async function claimFire(
  rule: TrackerRule,
  issueId: number,
  now: Date
): Promise<{ ok: true; id: number } | { ok: false; detail: string }> {
  return claimSlot({
    rule: rule.id,
    issue: issueId,
    connection: rule.action.connection,
    at: now,
    perHour: rule.guards.per_hour,
    perDay: rule.guards.per_day,
    connectionCap: CONNECTION_CAP_PER_HOUR
  })
}

/** No per-"rule" limit for flows: only the connection cap holds them. */
const FLOW_NO_LIMIT = 2_147_483_647

/**
 * Claim one connection-cap slot for a flow's gitlab.create_issue (rule -1, "Flow"). `issue` = the
 * issue / ticket id (0 for a record). Same SQL and lock as a rule's claim; only the connection's
 * hourly cap can hold it.
 */
export async function claimFlowFire(
  connection: number,
  issue: number,
  now = new Date()
): Promise<{ ok: true; id: number } | { ok: false; detail: string }> {
  return claimSlot({
    rule: FLOW_RULE,
    issue,
    connection,
    at: now,
    perHour: FLOW_NO_LIMIT,
    perDay: FLOW_NO_LIMIT,
    connectionCap: CONNECTION_CAP_PER_HOUR
  })
}

/**
 * Claim one connection-cap slot for a non-admin's create (rule -2, "Person"; final review). Same
 * SQL and lock as a rule's claim; only the connection's hourly cap can hold it.
 */
export async function claimPersonFire(
  connection: number,
  issue: number,
  now = new Date()
): Promise<{ ok: true; id: number } | { ok: false; detail: string }> {
  return claimSlot({
    rule: PERSON_RULE,
    issue,
    connection,
    at: now,
    perHour: FLOW_NO_LIMIT,
    perDay: FLOW_NO_LIMIT,
    connectionCap: CONNECTION_CAP_PER_HOUR
  })
}

/** A claimed slot whose create did not happen: kept as a decision, no longer a fire. */
export async function releaseClaim(id: number, outcome: string, detail: string): Promise<void> {
  await db(DECISIONS)
    .where({ id })
    .update({ outcome, detail: detail.slice(0, DETAIL_MAX) })
}

/** Fill in what a claimed flow fire did. */
export async function settleClaim(id: number, detail: string): Promise<void> {
  await db(DECISIONS)
    .where({ id })
    .update({ detail: detail.slice(0, DETAIL_MAX) })
}

async function claimSlot(
  p: ClaimParams
): Promise<{ ok: true; id: number } | { ok: false; detail: string }> {
  const mssql = isMssql(db)
  const dialect = sqlDialect(db)
  const now = p.at
  return db.transaction(async (trx) => {
    let mysqlLockHeld = false
    try {
      if (dialect === 'pg') {
        // One claimer at a time, like the SQL Server app lock (released at commit / rollback).
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CLAIM_LOCK])
      } else if (dialect === 'mysql') {
        const got = rawRows<Record<string, unknown>>(
          await trx.raw('SELECT GET_LOCK(?, ?) AS r', [
            CLAIM_LOCK,
            Math.ceil(CLAIM_LOCK_TIMEOUT_MS / 1000)
          ])
        )
        if (Number(Object.values(got[0] ?? {})[0] ?? 0) !== 1)
          throw new Error('Another rule on this connection is busy firing — try again shortly')
        mysqlLockHeld = true
      }
      if (mssql) {
        const lock = (await trx.raw(
          `DECLARE @r int;
EXEC @r = sp_getapplock @Resource = ?, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ?;
SELECT @r AS r`,
          [CLAIM_LOCK, CLAIM_LOCK_TIMEOUT_MS]
        )) as Row[]
        if (Number(lock?.[0]?.r ?? -1) < 0)
          throw new Error('Another rule on this connection is busy firing — try again shortly')
      }
      const { sql, bindings } = claimStatement(p, dialect === 'sqlite' ? 'pg' : dialect)
      const res = (await trx.raw(sql, bindings as never[])) as unknown
      let id: number | null = null
      if (mssql) {
        const rows = Array.isArray(res) ? (res as Row[]) : []
        if (rows[0]?.id != null) id = Number(rows[0].id)
      } else {
        const got = (await trx(DECISIONS)
          .where({ rule: p.rule, issue: p.issue, outcome: 'fired', detail: CLAIM_DETAIL })
          .where('at', '=', now)
          .orderBy('id', 'desc')
          .first('id')) as Row | undefined
        if (got) id = Number(got.id)
      }
      if (id !== null) return { ok: true as const, id }

      // Held: say which cap.
      const hourAgo = new Date(now.getTime() - HOUR_MS)
      const count = async (since: Date) =>
        Number(
          (
            (await trx(DECISIONS)
              .where({ rule: p.rule, outcome: 'fired' })
              .where('at', '>', since)
              .count({ n: '*' })
              .first()) as { n?: number | string } | undefined
          )?.n ?? 0
        ) || 0
      const hour = await count(hourAgo)
      if (hour >= p.perHour)
        return {
          ok: false as const,
          detail: `Rule already opened ${hour} in the last hour (limit ${p.perHour})`
        }
      const day = await count(new Date(now.getTime() - DAY_MS))
      if (day >= p.perDay)
        return {
          ok: false as const,
          detail: `Rule already opened ${day} in the last day (limit ${p.perDay})`
        }
      const conn = await connectionFiredSince(trx, p.connection, hourAgo)
      return {
        ok: false as const,
        detail: `Connection already sent ${conn} in the last hour (limit ${p.connectionCap})`
      }
    } finally {
      // MySQL's named lock belongs to the connection, not the transaction.
      if (mysqlLockHeld) await trx.raw('SELECT RELEASE_LOCK(?)', [CLAIM_LOCK]).catch(() => {})
    }
  })
}

/**
 * One rule against one issue. Counts and guards are read only when the cheaper checks pass:
 * match/status/linked need neither; thresholds need counts; caps need the guard state.
 */
async function assess(
  rule: TrackerRule,
  ctx: IssueContext,
  counts: CountCache,
  now: Date
): Promise<Outcome> {
  const facts: IssueFacts = { ...ctx.facts, linked: ctx.linkedOn.has(rule.action.connection) }
  let out = evaluateRule(rule, facts, ZERO_COUNTS, ZERO_GUARDS, now)
  if (out.act === 'skip' && ['no_match', 'status', 'linked'].includes(out.outcome)) return out
  await counts.load(rule)
  out = evaluateRule(rule, facts, counts.counts(), ZERO_GUARDS, now)
  if (out.act === 'skip') return out
  return evaluateRule(rule, facts, counts.counts(), await guardState(rule, now), now)
}

// ── Decisions ─────────────────────────────────────────────────────────────────

type Latest = Map<number, { outcome: string; detail: string }>

async function latestDecisions(issueId: number): Promise<Latest> {
  const rows = (await db(DECISIONS)
    .where({ issue: issueId })
    .orderBy('id', 'desc')
    .limit(500)
    .select('rule', 'outcome', 'detail')) as Row[]
  const out: Latest = new Map()
  for (const r of rows) {
    const rule = Number(r.rule)
    if (!out.has(rule))
      out.set(rule, { outcome: String(r.outcome), detail: String(r.detail ?? '') })
  }
  return out
}

/** Keep the newest KEEP_DECISIONS rows of one rule. */
export async function trimDecisions(ruleId: number, now = new Date()): Promise<void> {
  const cut = (await db(DECISIONS)
    .where({ rule: ruleId })
    .orderBy('id', 'desc')
    .offset(KEEP_DECISIONS)
    .limit(1)
    .select('id')) as Row[]
  if (!cut[0]) return
  // The caps count 'fired' rows of the last day: those are never trimmed (a busy rule's log may
  // run past 200 by at most its daily cap).
  const keepFiredSince = new Date(now.getTime() - FIRED_KEEP_MS)
  await db(DECISIONS)
    .where({ rule: ruleId })
    .where('id', '<=', Number(cut[0].id))
    .where((q) => q.where('outcome', '<>', 'fired').orWhere('at', '<=', keepFiredSince))
    .delete()
}

/**
 * Store one decision (a repeat of the issue's latest decision for the rule — same outcome and
 * detail — is not stored again, so a noisy issue does not wash out the log), bump the rule's
 * counters and trim the rule's log to 200.
 */
async function record(
  ruleId: number,
  issueId: number,
  outcome: string,
  detail: string,
  latest: Latest,
  now: Date
): Promise<void> {
  const text = detail.slice(0, DETAIL_MAX)
  const prev = latest.get(ruleId)
  if (outcome !== 'fired' && prev && prev.outcome === outcome && prev.detail === text) return
  await db(DECISIONS).insert({ rule: ruleId, issue: issueId, at: now, outcome, detail: text })
  latest.set(ruleId, { outcome, detail: text })
  if (outcome === 'fired' || outcome === 'suggested')
    await db(RULES)
      .where({ id: ruleId })
      .update({ fired_count: db.raw('fired_count + 1'), last_fired_at: now })
  else if (HELD_OUTCOMES.has(outcome))
    await db(RULES)
      .where({ id: ruleId })
      .update({ suppressed_count: db.raw('suppressed_count + 1') })
  await trimDecisions(ruleId)
}

/** Outcomes that count as suppressed (matched, but a threshold or guard held it). */
const HELD_OUTCOMES = new Set(['threshold', 'cap', 'quiet', 'linked', 'status'])

// ── Acting ────────────────────────────────────────────────────────────────────

/** Only a plain http(s) URL rides into a template (no Liquid, no markdown breakers). */
function safeWebUrl(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return /^https?:\/\/[^\s<>()[\]{}"'`\\|^%]+$/.test(s) && s.length <= 800 ? s : null
}

/** The rule with one line about the closed GitLab issue this recurrence came back from. */
function withEarlierIssue(rule: TrackerRule, link: Row): TrackerRule {
  const url = safeWebUrl(link.web_url)
  const iid = Number(link.external_iid)
  // never `#<n>` in text for GitLab: it links issue <n> of the NEW issue's project
  const ref = url ? `[issue ${iid}](${url})` : `issue ${iid}`
  const body = rule.action.body_template || defaultBodyTemplate()
  return {
    ...rule,
    action: {
      ...rule.action,
      body_template: `${body}\n\nThis came back after the earlier GitLab issue ${ref} was closed.`
    }
  }
}

// ── Home misses (final review M4) ────────────────────────────────────────────────
// A create rule held by a cap re-runs on every write of its issue. Where findHome found nothing
// for an issue on a connection, the next 15 minutes of capped re-evaluations skip the look
// (fingerprint + group reads). Keyed by tenant like every module-level cache.

const HOME_MISS_MS = 15 * 60_000
const HOME_MISS_MAX = 5000
const homeMisses = registerAppKeyed(new Map<string, number>())
const homeMissKey = (kind: string, id: number | string, connection: number) =>
  `${currentTenantKey()}|${kind}:${id}|${connection}`

function homeMissed(kind: string, id: number | string, connection: number, now: Date): boolean {
  const key = homeMissKey(kind, id, connection)
  const until = homeMisses.get(key)
  if (until === undefined) return false
  if (until > now.getTime()) return true
  homeMisses.delete(key)
  return false
}

function noteHomeMiss(kind: string, id: number | string, connection: number, now: Date): void {
  if (homeMisses.size >= HOME_MISS_MAX) {
    const oldest = homeMisses.keys().next().value
    if (oldest !== undefined) homeMisses.delete(oldest)
  }
  homeMisses.set(homeMissKey(kind, id, connection), now.getTime() + HOME_MISS_MS)
}

/** Tests: forget remembered home misses. */
export function resetHomeMisses(): void {
  homeMisses.clear()
}

type FirePlan =
  | {
      kind: 'join'
      target: { link_id: number } | { project_id: number; iid: number }
      via: 'fingerprint' | 'group' | 'similar'
      score?: number
      iid: number
      /** The home link when it is CLOSED on GitLab and should be reopened after the join. */
      reopen: Row | null
    }
  | { kind: 'create'; rule: TrackerRule; detail: string }

/**
 * What a firing rule would do: join a home (fingerprint always; group only when the rule's group
 * guard is on; similar only when the connection's similar matching is on), else open a new GitLab
 * issue. A home that is CLOSED on GitLab follows the connection's `recur_when_closed`: 'new' opens
 * a new GitLab issue naming the old one (a create); 'reopen' joins it and, when `reopen_on_recur`
 * is on, reopens it. Only creates use cap slots — a join opens nothing on GitLab.
 */
async function planFire(
  rule: TrackerRule,
  issueId: number,
  conn: TrackerConnection,
  capped = false,
  now = new Date()
): Promise<FirePlan> {
  const create: FirePlan = { kind: 'create', rule, detail: 'queued a new GitLab issue' }
  // Held by a cap: no similarity (GitLab searches + embeddings), and a miss is remembered for
  // 15 minutes so a storm of re-evaluations does not look again each time (final review M4).
  if (capped && homeMissed('issue', issueId, conn.id, now)) return create
  const projectId = rule.action.project_id ?? conn.default_project_id ?? 0
  let home = await findHome(issueId, conn.id, projectId, { similar: !capped })
  if (capped && !home) noteHomeMiss('issue', issueId, conn.id, now)
  if (home?.via === 'group' && !rule.guards.group) home = null
  if (home?.via === 'similar' && !conn.sync.similar.enabled) home = null
  if (home && home.link_id == null && !home.candidate) home = null
  if (!home) return create

  const link =
    home.link_id != null
      ? ((await db(LINKS)
          .where({ id: home.link_id })
          .first('id', 'project_id', 'external_iid', 'web_url', 'remote_state', 'created_via')) as
          | Row
          | undefined)
      : undefined
  const closed = link?.remote_state === 'closed'
  if (link && closed && conn.sync.recur_when_closed === 'new')
    return {
      kind: 'create',
      rule: withEarlierIssue(rule, link),
      detail: `queued a new GitLab issue (#${Number(link.external_iid)} is closed)`
    }
  const candidate = home.candidate
  return {
    kind: 'join',
    target:
      home.link_id != null
        ? { link_id: home.link_id }
        : {
            project_id: (candidate as { project_id: number }).project_id,
            iid: (candidate as { iid: number }).iid
          },
    via: home.via,
    score: candidate?.score,
    iid: link ? Number(link.external_iid) : Number(candidate?.iid),
    // a GitLab issue a person wrote is only reopened with push_to_linked
    reopen:
      link &&
      closed &&
      conn.sync.reopen_on_recur &&
      (!personWritten(link.created_via) || conn.sync.push_to_linked === true)
        ? link
        : null
  }
}

/** Join the issue to its home as an example (and reopen a closed home). Returns the detail. */
async function joinHome(
  plan: Extract<FirePlan, { kind: 'join' }>,
  issueId: number,
  conn: TrackerConnection
): Promise<string> {
  const linkId = await joinAsExample(issueId, conn.id, plan.target, plan.via, plan.score)
  let detail = `joined #${plan.iid} via ${plan.via}${
    typeof plan.score === 'number' && Number.isFinite(plan.score)
      ? ` (${plan.score.toFixed(2)})`
      : ''
  }`
  if (plan.reopen) {
    await enqueue({
      connection: conn.id,
      link: linkId,
      source_id: String(issueId),
      op: 'state',
      payload: {
        project_id: Number(plan.reopen.project_id),
        iid: Number(plan.reopen.external_iid),
        state: 'reopen'
      },
      // one reopen per link per hour: a storm of joins reopens once (outbound-sync shares it)
      key: `state:${linkId}:reopen:${new Date().toISOString().slice(0, 13)}`
    })
    detail += ', reopening it'
  }
  return detail
}

// ── Evaluate ──────────────────────────────────────────────────────────────────

export type EvalResult = { rule: number; outcome: string }

/**
 * Run the enabled rules against one issue and act. Returns each rule's outcome (`no_match` is
 * returned but never stored). Off, a missing issue, or an issue GitLab sync raised itself
 * (`source = 'tracker'`) or brought in from GitLab (`'gitlab'`) → [].
 */
export async function evaluateIssue(issueId: number, now = new Date()): Promise<EvalResult[]> {
  if (!(await trackersEnabled())) return []
  const rules = (await enabledRules()).filter(isIssueRule)
  if (!rules.length) return []
  const ctx = await loadContext(issueId, {
    groupLead: rules.some((r) => (r.match.group_lead_ids?.length ?? 0) > 0)
  })
  if (!ctx || isSyncOwnSource(ctx.facts.source)) return []

  const counts = new CountCache(hitKey({ id: issueId, fingerprint: ctx.facts.fingerprint }), now)
  const latest = await latestDecisions(issueId)
  const out: EvalResult[] = []

  const switchedOff = await issueSourceOff(rules)
  for (const rule of rules) {
    // The issue log is switched off on this rule's connection: the rule does not run.
    if (switchedOff.has(rule.action.connection)) {
      out.push({ rule: rule.id, outcome: 'no_match' })
      continue
    }
    const res = await assess(rule, ctx, counts, now)
    // A create rule held only by a cap may still JOIN an existing GitLab issue (caps limit
    // issues opened, so a storm of similar issues keeps joining).
    const capped = res.act === 'skip' && res.outcome === 'cap' && rule.mode === 'create'
    if (res.act === 'skip' && !capped) {
      out.push({ rule: rule.id, outcome: res.outcome })
      if (res.outcome === 'no_match') continue
      let detail = res.detail
      if (res.outcome === 'quiet' && rule.guards.quiet)
        detail = (nextQuietEnd(rule.guards.quiet, now) ?? now).toISOString()
      await record(rule.id, issueId, res.outcome, detail, latest, now)
      continue
    }

    if (res.act === 'suggest') {
      if (Number(ctx.row.tracker_suggested_rule) !== rule.id) {
        await db('nivaro_issues').where({ id: issueId }).update({ tracker_suggested_rule: rule.id })
        ctx.row.tracker_suggested_rule = rule.id
        await record(rule.id, issueId, 'suggested', 'Suggested for GitLab', latest, now)
      }
      out.push({ rule: rule.id, outcome: 'suggested' })
      if (!rule.continue_after) break
      continue
    }

    // fire: a join needs no cap slot; a create claims its slot in SQL first, then acts
    const conn = await getConnection(rule.action.connection)
    if (!conn?.is_active) {
      const why = conn
        ? 'The GitLab connection of this rule is turned off'
        : 'The GitLab connection of this rule no longer exists'
      await record(rule.id, issueId, 'error', `Could not act: ${why}`, latest, now)
      out.push({ rule: rule.id, outcome: 'error' })
      continue
    }
    let plan: FirePlan
    try {
      plan = await planFire(rule, issueId, conn, capped, now)
    } catch (err) {
      await record(rule.id, issueId, 'error', `Could not act: ${errText(err)}`, latest, now)
      out.push({ rule: rule.id, outcome: 'error' })
      continue
    }

    if (plan.kind === 'join') {
      try {
        const detail = await joinHome(plan, issueId, conn)
        ctx.linkedOn.add(rule.action.connection)
        await record(rule.id, issueId, 'joined', detail, latest, now)
        out.push({ rule: rule.id, outcome: 'joined' })
      } catch (err) {
        await record(rule.id, issueId, 'error', `Could not act: ${errText(err)}`, latest, now)
        out.push({ rule: rule.id, outcome: 'error' })
        continue
      }
      if (!rule.continue_after) break
      continue
    }

    if (res.act === 'skip') {
      // capped, and nothing to join: held
      await record(rule.id, issueId, res.outcome, res.detail, latest, now)
      out.push({ rule: rule.id, outcome: res.outcome })
      continue
    }

    let claim: Awaited<ReturnType<typeof claimFire>>
    try {
      claim = await claimFire(rule, issueId, now)
    } catch (err) {
      // app-lock timeout, deadlock victim, …: nothing was claimed or sent
      await record(
        rule.id,
        issueId,
        'error',
        `Could not claim a slot to open a GitLab issue: ${errText(err)}`,
        latest,
        now
      )
      out.push({ rule: rule.id, outcome: 'error' })
      continue
    }
    if (!claim.ok) {
      await record(rule.id, issueId, 'cap', claim.detail, latest, now)
      out.push({ rule: rule.id, outcome: 'cap' })
      continue
    }
    try {
      await requestCreate(issueId, { connection: conn.id, rule: plan.rule, via: 'rule' })
      const detail = plan.detail.slice(0, DETAIL_MAX)
      ctx.linkedOn.add(rule.action.connection)
      await db(DECISIONS).where({ id: claim.id }).update({ detail })
      await db(RULES)
        .where({ id: rule.id })
        .update({ fired_count: db.raw('fired_count + 1'), last_fired_at: now })
      latest.set(rule.id, { outcome: 'fired', detail })
      out.push({ rule: rule.id, outcome: 'fired' })
    } catch (err) {
      const detail = `Could not act: ${errText(err)}`.slice(0, DETAIL_MAX)
      await db(DECISIONS).where({ id: claim.id }).update({ outcome: 'error', detail })
      latest.set(rule.id, { outcome: 'error', detail })
      out.push({ rule: rule.id, outcome: 'error' })
      await trimDecisions(rule.id)
      continue
    }
    await trimDecisions(rule.id)
    if (!rule.continue_after) break
  }
  return out
}

// ── A rule fired by hand (the one-click create on a suggestion, final review X1) ─────────────

export class RuleFireError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
  }
}

/**
 * Open a GitLab issue for this issue-log entry or ticket with a rule's action, as the rule would
 * (via 'rule': its labels, templates, assignees, project, type …). The rule must be valid, on
 * this connection and about this kind of source (400 RULE_MISMATCH otherwise). Counted toward
 * the rule's and the connection's caps through the same claim as a rule's fire: held → 409 CAP
 * with the reason. A create that fails gives its slot back (decision 'error') and rethrows.
 */
export async function fireRuleByHand(
  ruleId: number,
  kind: 'issue' | 'ticket' | 'record',
  sourceId: string,
  connection: number,
  userId?: string,
  now = new Date()
): Promise<{ outboxId: number }> {
  const row = (await db(RULES).where({ id: ruleId }).first()) as Row | undefined
  if (!row) throw new RuleFireError('Rule not found', 404, 'RULE_NOT_FOUND')
  const rule = ruleFromRow(row)
  if (!rule) throw new RuleFireError('This rule is not valid', 400, 'RULE_INVALID')
  const wanted = kind === 'issue' ? 'issue' : kind === 'ticket' ? 'ticket' : null
  const appliesTo = row.applies_to === 'ticket' ? 'ticket' : 'issue'
  if (rule.action.connection !== connection || wanted !== appliesTo)
    throw new RuleFireError(
      'This rule is not about this item on this connection',
      400,
      'RULE_MISMATCH'
    )
  const issue = Number(sourceId)
  const claim = await claimFire(rule, issue, now)
  if (!claim.ok) throw new RuleFireError(claim.detail, 409, 'CAP')
  try {
    const { requestSourceCreate } = await import('./links.js')
    const res =
      kind === 'issue'
        ? await requestCreate(issue, { connection, rule, via: 'rule', userId })
        : await requestSourceCreate(kind, sourceId, { connection, rule, via: 'rule', userId })
    await settleClaim(claim.id, 'queued a new GitLab issue (created by hand from the suggestion)')
    await db(RULES)
      .where({ id: rule.id })
      .update({ fired_count: db.raw('fired_count + 1'), last_fired_at: now })
    await trimDecisions(rule.id)
    return res
  } catch (err) {
    await releaseClaim(claim.id, 'error', `Could not act: ${errText(err)}`).catch(() => {})
    throw err
  }
}

/** Connections of these rules whose issue-log source is switched off. */
async function issueSourceOff(rules: TrackerRule[]): Promise<Set<number>> {
  const off = new Set<number>()
  for (const id of new Set(rules.map((r) => r.action.connection))) {
    const conn = await getConnection(id)
    if (conn && !sourceOn(conn, 'issue')) off.add(id)
  }
  return off
}

// Per app: two apps on one shared deployment may hold the same issue id.
const inFlight = appSet<number>()
const again = appSet<number>()

/** At most one failure line per this long per app; the line carries the count since. */
export const FAILURE_LOG_EVERY_MS = 10 * 60_000
// Per app: on a Hub shared deployment one app's failures never hold back another's first line.
const failureLog = appBox(() => ({ lastAt: 0, since: 0 }))
/** ` (app <id>)` on a Hub shared deployment, '' self-hosted: which app a log line is about. */
const appTag = () => (currentTenantKey() ? ` (app ${currentTenantKey()})` : '')

/**
 * Log an evaluation failure, rate limited (never silenced): the first failure logs at once, later
 * ones at most once per 10 minutes with how many failed since the last line. Console only —
 * never the issue log, which would feed the engine its own failures.
 */
export function noteEvaluationFailure(issueId: number, err: unknown, now = Date.now()): void {
  const log = failureLog.value
  log.since++
  if (log.lastAt && now - log.lastAt < FAILURE_LOG_EVERY_MS) return
  const n = log.since
  log.lastAt = now
  log.since = 0
  // biome-ignore lint/suspicious/noConsole: a broken rule engine must show in the log
  console.warn(
    `[trackers]${appTag()} rule evaluation failed for issue ${issueId} (${n} failure${n === 1 ? '' : 's'} since the last report): ${errText(err)}`.slice(
      0,
      600
    )
  )
}

/** Tests: start the failure log afresh. */
export function resetFailureLog(): void {
  failureLog.reset()
}

/** One guarded run; false when an evaluation of this issue threw. */
async function runQueued(issueId: number): Promise<{ ok: true } | { ok: false; err: unknown }> {
  if (inFlight.has(issueId)) {
    again.add(issueId)
    return { ok: true }
  }
  inFlight.add(issueId)
  let failure: { ok: false; err: unknown } | null = null
  try {
    do {
      again.delete(issueId)
      try {
        await evaluateIssue(issueId)
        failure = null
      } catch (err) {
        failure = { ok: false, err }
        noteEvaluationFailure(issueId, err)
      }
    } while (again.has(issueId))
  } finally {
    inFlight.delete(issueId)
    again.delete(issueId)
  }
  return failure ?? { ok: true }
}

/**
 * evaluateIssue with a per-issue in-flight guard: a burst of writes for one issue runs one
 * evaluation at a time (a write that arrives meanwhile runs once more afterwards), so a burst
 * never fires a rule twice. Never throws.
 */
export async function evaluateQueued(issueId: number): Promise<void> {
  await runQueued(issueId)
}

// ── Support-ticket rules ──────────────────────────────────────────────────────

/** Ids of every rule about support tickets (their decision rows name a ticket). */
async function ticketRuleIds(): Promise<Set<number>> {
  const rows = (await db(RULES).select('id', 'applies_to')) as Row[]
  return new Set(rows.filter((r) => r.applies_to === 'ticket').map((r) => Number(r.id)))
}

/** The facts a ticket rule is judged on, plus the connections it is already linked on. */
export async function loadTicketFacts(
  ticketId: number
): Promise<{ facts: TicketFacts; linkedOn: Set<number> } | null> {
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return null
  const row = (await db('nivaro_tasks').where({ id: ticketId, kind: 'support' }).first()) as
    | Row
    | undefined
  if (!row) return null
  let role: string | null = null
  if (row.created_by) {
    const u = (await db('nivaro_users').where({ id: row.created_by }).first('role')) as
      | Row
      | undefined
    role = u?.role == null ? null : String(u.role)
  }
  const members = (await db(MEMBERS)
    .where({ source_kind: 'ticket', source_id: String(ticketId) })
    .select('connection')) as Row[]
  const linkedOn = new Set(members.map((m) => Number(m.connection)))
  const queued = (await db(OUTBOX)
    .where({ op: 'create', source_kind: 'ticket', source_id: String(ticketId) })
    .whereIn('status', ['pending', 'sending', 'dead'])
    .select('connection')) as Row[]
  for (const q of queued) linkedOn.add(Number(q.connection))
  return {
    facts: {
      id: ticketId,
      title: String(row.title ?? ''),
      description: row.description == null ? null : String(row.description),
      status: String(row.status ?? 'open'),
      priority: String(row.priority ?? 'normal'),
      category_id: row.category_id == null ? null : Number(row.category_id),
      requester: row.created_by == null ? null : String(row.created_by),
      requester_role: role,
      assignee: row.assignee == null ? null : String(row.assignee),
      created_at: toDate(row.created_at) ?? new Date(),
      linked: linkedOn.size > 0
    },
    linkedOn
  }
}

/**
 * Run the enabled support-ticket rules against one ticket and act: a fire joins a similar open
 * GitLab issue (when the connection's similar matching is on), else claims a cap slot and queues
 * a create; a suggest only records the decision (tickets carry no suggestion mark). Same
 * decision log, caps and quiet hours as issue rules; no hit thresholds.
 */
export async function evaluateTicket(ticketId: number, now = new Date()): Promise<EvalResult[]> {
  if (!(await trackersEnabled())) return []
  const rules = (await enabledRules()).filter(isTicketRule)
  if (!rules.length) return []
  const ctx = await loadTicketFacts(ticketId)
  if (!ctx) return []
  const latest = await latestDecisions(ticketId)
  const out: EvalResult[] = []
  const { sourceFor } = await import('./sources/index.js')
  const { findHomeForSource, joinSourceAsExample } = await import('./similar.js')
  const { requestSourceCreate } = await import('./links.js')

  for (const rule of rules) {
    const conn = await getConnection(rule.action.connection)
    if (conn && !sourceOn(conn, 'ticket')) {
      out.push({ rule: rule.id, outcome: 'no_match' })
      continue
    }
    const facts: TicketFacts = { ...ctx.facts, linked: ctx.linkedOn.has(rule.action.connection) }
    let res = evaluateTicketRule(rule, facts, ZERO_GUARDS, now)
    if (res.act !== 'skip') res = evaluateTicketRule(rule, facts, await guardState(rule, now), now)
    const capped = res.act === 'skip' && res.outcome === 'cap' && rule.mode === 'create'
    if (res.act === 'skip' && !capped) {
      out.push({ rule: rule.id, outcome: res.outcome })
      if (res.outcome === 'no_match') continue
      let detail = res.detail
      if (res.outcome === 'quiet' && rule.guards.quiet)
        detail = (nextQuietEnd(rule.guards.quiet, now) ?? now).toISOString()
      await record(rule.id, ticketId, res.outcome, detail, latest, now)
      continue
    }
    if (res.act === 'suggest') {
      if (latest.get(rule.id)?.outcome !== 'suggested')
        await record(rule.id, ticketId, 'suggested', 'Suggested for GitLab', latest, now)
      out.push({ rule: rule.id, outcome: 'suggested' })
      if (!rule.continue_after) break
      continue
    }
    if (!conn?.is_active) {
      const why = conn
        ? 'The GitLab connection of this rule is turned off'
        : 'The GitLab connection of this rule no longer exists'
      await record(rule.id, ticketId, 'error', `Could not act: ${why}`, latest, now)
      out.push({ rule: rule.id, outcome: 'error' })
      continue
    }
    // join a similar open GitLab issue first: joins open nothing, so they use no cap slot. A
    // ticket's only home is a similar issue, and similarity is skipped while a cap holds the
    // rule (final review M4): a capped ticket is held without searching GitLab.
    let view: Awaited<ReturnType<ReturnType<typeof sourceFor>['load']>> = null
    try {
      view = capped ? null : await sourceFor('ticket').load(String(ticketId))
      const projectId = rule.action.project_id ?? conn.default_project_id ?? 0
      const home = view ? await findHomeForSource(view, conn.id, projectId) : null
      const target =
        home?.link_id != null
          ? { link_id: home.link_id }
          : home?.candidate
            ? { project_id: home.candidate.project_id, iid: home.candidate.iid }
            : null
      if (view && home && target) {
        await joinSourceAsExample(view, conn.id, target, 'similar', home.candidate?.score)
        ctx.linkedOn.add(conn.id)
        const iid = home.candidate?.iid
        await record(
          rule.id,
          ticketId,
          'joined',
          `joined ${iid != null ? `#${iid} ` : ''}via similar`.trim(),
          latest,
          now
        )
        out.push({ rule: rule.id, outcome: 'joined' })
        if (!rule.continue_after) break
        continue
      }
    } catch (err) {
      await record(rule.id, ticketId, 'error', `Could not act: ${errText(err)}`, latest, now)
      out.push({ rule: rule.id, outcome: 'error' })
      continue
    }
    if (res.act === 'skip') {
      await record(rule.id, ticketId, res.outcome, res.detail, latest, now)
      out.push({ rule: rule.id, outcome: res.outcome })
      continue
    }
    let claim: Awaited<ReturnType<typeof claimFire>>
    try {
      claim = await claimFire(rule, ticketId, now)
    } catch (err) {
      await record(
        rule.id,
        ticketId,
        'error',
        `Could not claim a slot to open a GitLab issue: ${errText(err)}`,
        latest,
        now
      )
      out.push({ rule: rule.id, outcome: 'error' })
      continue
    }
    if (!claim.ok) {
      await record(rule.id, ticketId, 'cap', claim.detail, latest, now)
      out.push({ rule: rule.id, outcome: 'cap' })
      continue
    }
    try {
      await requestSourceCreate('ticket', String(ticketId), {
        connection: conn.id,
        rule,
        via: 'rule'
      })
      const detail = 'queued a new GitLab issue'
      ctx.linkedOn.add(conn.id)
      await db(DECISIONS).where({ id: claim.id }).update({ detail })
      await db(RULES)
        .where({ id: rule.id })
        .update({ fired_count: db.raw('fired_count + 1'), last_fired_at: now })
      latest.set(rule.id, { outcome: 'fired', detail })
      out.push({ rule: rule.id, outcome: 'fired' })
    } catch (err) {
      const detail = `Could not act: ${errText(err)}`.slice(0, DETAIL_MAX)
      await db(DECISIONS).where({ id: claim.id }).update({ outcome: 'error', detail })
      latest.set(rule.id, { outcome: 'error', detail })
      out.push({ rule: rule.id, outcome: 'error' })
      await trimDecisions(rule.id)
      continue
    }
    await trimDecisions(rule.id)
    if (!rule.continue_after) break
  }
  return out
}

const ticketInFlight = appSet<number>()
const ticketAgain = appSet<number>()

/** evaluateTicket, one at a time per ticket (a write meanwhile runs once more). Never throws. */
export async function evaluateTicketQueued(ticketId: number): Promise<void> {
  if (ticketInFlight.has(ticketId)) {
    ticketAgain.add(ticketId)
    return
  }
  ticketInFlight.add(ticketId)
  try {
    do {
      ticketAgain.delete(ticketId)
      try {
        await evaluateTicket(ticketId)
      } catch (err) {
        noteEvaluationFailure(ticketId, err)
      }
    } while (ticketAgain.has(ticketId))
  } finally {
    ticketInFlight.delete(ticketId)
    ticketAgain.delete(ticketId)
  }
}

/**
 * The sweep's ticket part: tickets changed since the mark (at most 500) and tickets held by
 * quiet hours whose window has ended, when any ticket rule is on.
 */
async function sweepTickets(mark: Date, now: Date): Promise<number> {
  if (!(await enabledRules()).some(isTicketRule)) return 0
  const rows = (await db('nivaro_tasks')
    .where({ kind: 'support' })
    .where('updated_at', '>', mark)
    .orderBy('updated_at', 'asc')
    .limit(SWEEP_CAP)
    .select('id')) as Row[]
  const ids = new Set(rows.map((r) => Number(r.id)))
  for (const q of await quietDue(mark, now, 'ticket')) ids.add(q.issue)
  for (const id of ids) await evaluateTicketQueued(id)
  return ids.size
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

export const SWEEP_EXT = 'nivaro-core'
export const SWEEP_KEY = 'tracker_sweep_mark'
export const SWEEP_CAP = 500
/** First sweep ever (no mark): look back this far, never over the whole history. */
const FIRST_SWEEP_LOOKBACK_MS = 10 * 60_000
const QUIET_LOOKBACK_MS = 2 * DAY_MS
const TOUCHED_SQL =
  'CASE WHEN updated_at IS NULL OR (last_seen_at IS NOT NULL AND last_seen_at > updated_at) THEN last_seen_at ELSE updated_at END'

async function readMark(): Promise<Date | null> {
  const row = (await db('nivaro_extension_settings')
    .where({ extension_id: SWEEP_EXT, key: SWEEP_KEY })
    .first('value')) as Row | undefined
  return toDate(row?.value)
}

/** The mark is the sweep's own cursor, not configuration: writing it must not move the config
 *  epoch (every 5 minutes it made every open browser reload — prod 2026-11-20, issue 1124). */
async function writeMark(mark: Date): Promise<void> {
  const value = mark.toISOString()
  await runBookkeepingWrite(['nivaro_extension_settings'], async () => {
    const existing = (await db('nivaro_extension_settings')
      .where({ extension_id: SWEEP_EXT, key: SWEEP_KEY })
      .first('id')) as Row | undefined
    if (existing)
      await db('nivaro_extension_settings')
        .where({ id: existing.id })
        .update({ value, updated_at: new Date() })
    else
      await db('nivaro_extension_settings').insert({
        extension_id: SWEEP_EXT,
        key: SWEEP_KEY,
        value,
        updated_at: new Date()
      })
  })
}

/** Issues whose latest decision for some rule is 'quiet' and whose quiet end is in (mark, now]. */
async function quietDue(
  mark: Date,
  now: Date,
  kind: 'issue' | 'ticket' = 'issue'
): Promise<Array<{ issue: number; end: number }>> {
  const since = new Date(now.getTime() - QUIET_LOOKBACK_MS)
  const rows = (await db(DECISIONS)
    .where({ outcome: 'quiet' })
    .where('at', '>=', since)
    .select('id', 'rule', 'issue', 'detail')) as Row[]
  const ticketRules = await ticketRuleIds()
  const due = rows.filter((r) => {
    const end = toDate(r.detail)
    return (
      end !== null &&
      end > mark &&
      end <= now &&
      ticketRules.has(Number(r.rule)) === (kind === 'ticket')
    )
  })
  if (!due.length) return []
  const issues = [...new Set(due.map((r) => Number(r.issue)))]
  const recent = await selectInChunks(
    issues,
    500,
    async (chunk) =>
      (await whereInList(db(DECISIONS), 'issue', chunk)
        .where('at', '>=', since)
        .select('id', 'rule', 'issue')) as Row[]
  )
  const newest = new Map<string, number>()
  for (const r of recent) {
    const k = `${r.rule}:${r.issue}`
    newest.set(k, Math.max(newest.get(k) ?? -1, Number(r.id)))
  }
  const out = new Map<number, number>()
  for (const r of due) {
    if (newest.get(`${r.rule}:${r.issue}`) !== Number(r.id)) continue
    const end = (toDate(r.detail) as Date).getTime()
    const issue = Number(r.issue)
    out.set(issue, Math.min(out.get(issue) ?? end, end))
  }
  return [...out].map(([issue, end]) => ({ issue, end }))
}

/** A failing issue holds the sweep mark for at most this many tries or this long. */
export const SWEEP_MAX_TRIES = 3
export const SWEEP_MAX_HOLD_MS = 60 * 60_000
const SWEEP_FAILURES_MAX = 1000
// Per app (issue ids repeat across apps of one shared deployment).
const sweepFailures = appMap<number, { count: number; firstAt: number; skipped: boolean }>()

/** Tests: forget the sweep's failure tally. */
export function resetSweepFailures(): void {
  sweepFailures.clear()
}

/**
 * Whether a failed issue still holds the sweep mark back: yes for its first 3 failed tries within
 * an hour of the first; after that the sweep moves on (one 'error' decision says so — the live
 * listener still re-evaluates the issue on its next write). Per process.
 */
async function stillHoldsMark(issueId: number, err: unknown, now: Date): Promise<boolean> {
  const f = sweepFailures.get(issueId) ?? { count: 0, firstAt: now.getTime(), skipped: false }
  f.count++
  sweepFailures.delete(issueId)
  sweepFailures.set(issueId, f)
  if (sweepFailures.size > SWEEP_FAILURES_MAX) {
    const oldest = sweepFailures.keys().next().value
    if (oldest !== undefined) sweepFailures.delete(oldest)
  }
  if (f.count < SWEEP_MAX_TRIES && now.getTime() - f.firstAt < SWEEP_MAX_HOLD_MS) return true
  if (!f.skipped) {
    f.skipped = true
    try {
      await db(DECISIONS).insert({
        rule: SWEEP_RULE,
        issue: issueId,
        at: now,
        outcome: 'error',
        detail: `evaluation keeps failing — skipped by the sweep: ${errText(err).slice(0, 200)}`
      })
      await trimDecisions(SWEEP_RULE, now)
    } catch {
      // the log line from noteEvaluationFailure still says it
    }
  }
  return false
}

/**
 * Re-evaluate what changed since the stored mark (`updated_at` or `last_seen_at` later than it,
 * oldest first, at most 500 per run) plus issues held by quiet hours whose window has ended. A
 * missed event or a restart never loses an evaluation. The mark moves to this run's start, or —
 * when the 500 cap was hit — to the last issue evaluated, so the next run continues from there.
 */
export async function sweep(now = new Date()): Promise<{ evaluated: number }> {
  if (!(await trackersEnabled())) return { evaluated: 0 }
  const mark = (await readMark()) ?? new Date(now.getTime() - FIRST_SWEEP_LOOKBACK_MS)
  // No issue rule switched on: nothing to re-run, so the issue log is not read at all (ticket
  // rules still sweep). Final review.
  if (!(await enabledRules()).some(isIssueRule)) {
    try {
      await sweepTickets(mark, now)
    } catch (err) {
      noteEvaluationFailure(0, err)
    }
    await writeMark(now)
    return { evaluated: 0 }
  }
  const rows = (await db('nivaro_issues')
    .where((q) => q.where('updated_at', '>', mark).orWhere('last_seen_at', '>', mark))
    .orderByRaw(TOUCHED_SQL)
    .orderBy('id', 'asc')
    .limit(SWEEP_CAP)
    .select('id', 'updated_at', 'last_seen_at')) as Row[]
  const touchedOf = (r: Row): Date | null => {
    const a = toDate(r.updated_at)
    const b = toDate(r.last_seen_at)
    return a && b ? (a > b ? a : b) : (a ?? b)
  }
  // Each issue with the time the mark must stay below for it to be picked up again.
  const due = new Map<number, number>()
  for (const r of rows) due.set(Number(r.id), touchedOf(r)?.getTime() ?? mark.getTime() + 1)
  for (const q of await quietDue(mark, now)) if (!due.has(q.issue)) due.set(q.issue, q.end)

  let failedAt: number | null = null
  for (const [id, at] of due) {
    const res = await runQueued(id)
    if (res.ok) {
      sweepFailures.delete(id)
      continue
    }
    if (await stillHoldsMark(id, res.err, now))
      failedAt = failedAt === null ? at : Math.min(failedAt, at)
  }

  let next = now
  if (rows.length >= SWEEP_CAP) {
    const touched = touchedOf(rows[rows.length - 1])
    if (touched && touched > mark) next = touched
  }
  // A failed issue is picked up again next run: the mark stays just before it.
  if (failedAt !== null)
    next = new Date(Math.max(mark.getTime(), Math.min(next.getTime(), failedAt - 1)))
  // Support tickets (rules with applies_to 'ticket'): best effort, never holds the mark.
  try {
    await sweepTickets(mark, now)
  } catch (err) {
    noteEvaluationFailure(0, err)
  }
  await writeMark(next)
  return { evaluated: due.size }
}

// ── Explain ───────────────────────────────────────────────────────────────────

export interface Explanation {
  rule: number
  name: string
  outcome: string
  detail: string
  at: string
  /** True for the dry run of the rules as they stand now (nothing stored, nothing sent). */
  live?: boolean
}

/** Stored detail as shown to a person. 'joined' rows already read "joined #<iid> via <kind>". */
function describe(outcome: string, detail: string): string {
  if (outcome === 'quiet') {
    const end = toDate(detail)
    return end ? `Held for quiet hours until ${end.toISOString()}` : detail
  }
  return detail
}

/**
 * Why a rule did or did not act on an issue: a dry run of every enabled rule now (`live`,
 * `no_match` reasons included, nothing stored or sent) followed by the stored decisions,
 * newest first.
 */
export async function explainIssue(issueId: number, now = new Date()): Promise<Explanation[]> {
  const out: Explanation[] = []
  const rules = (await enabledRules()).filter(isIssueRule)
  const ctx = await loadContext(issueId, {
    groupLead: rules.some((r) => (r.match.group_lead_ids?.length ?? 0) > 0)
  })
  if (!ctx) return []
  if (isSyncOwnSource(ctx.facts.source)) {
    out.push({
      rule: 0,
      name: '',
      outcome: 'ignored',
      detail: 'Issues raised by GitLab sync itself are never sent to GitLab',
      at: now.toISOString(),
      live: true
    })
  } else {
    const counts = new CountCache(hitKey({ id: issueId, fingerprint: ctx.facts.fingerprint }), now)
    for (const rule of rules) {
      const res = await assess(rule, ctx, counts, now)
      let outcome: string
      let detail: string
      if (res.act === 'skip') {
        outcome = res.outcome
        detail =
          res.outcome === 'quiet' && rule.guards.quiet
            ? describe('quiet', (nextQuietEnd(rule.guards.quiet, now) ?? now).toISOString())
            : res.outcome === 'cap' && rule.mode === 'create'
              ? `${res.detail} — it can still join an existing GitLab issue (joins use no slot)`
              : res.detail
      } else if (res.act === 'fire') {
        outcome = 'would_fire'
        detail = 'Would act now'
      } else {
        outcome = 'would_suggest'
        detail = 'Would suggest it for GitLab now'
      }
      out.push({
        rule: rule.id,
        name: rule.name,
        outcome,
        detail,
        at: now.toISOString(),
        live: true
      })
    }
  }

  // decision rows of ticket rules name a ticket with this number, not this issue
  const ticketRules = await ticketRuleIds()
  const rows = (
    (await db(DECISIONS)
      .where({ issue: issueId })
      .orderBy('id', 'desc')
      .limit(KEEP_DECISIONS)
      .select('rule', 'outcome', 'detail', 'at')) as Row[]
  ).filter((r) => !ticketRules.has(Number(r.rule)))
  const ruleIds = [...new Set(rows.map((r) => Number(r.rule)))]
  const names = new Map<number, string>()
  if (ruleIds.length) {
    const named = (await whereInList(db(RULES), 'id', ruleIds).select('id', 'name')) as Row[]
    for (const r of named) names.set(Number(r.id), String(r.name ?? ''))
  }
  for (const r of rows) {
    const rule = Number(r.rule)
    out.push({
      rule,
      name:
        rule === SWEEP_RULE
          ? 'Sweep'
          : rule === FLOW_RULE
            ? 'Flow'
            : rule === PERSON_RULE
              ? 'Person'
              : (names.get(rule) ?? '(deleted rule)'),
      outcome: String(r.outcome),
      detail: describe(String(r.outcome), String(r.detail ?? '')),
      at: iso(r.at)
    })
  }
  return out
}

// ── Preview ───────────────────────────────────────────────────────────────────

export const PREVIEW_MAX_ISSUES = 2000
const PREVIEW_MAX_EVALS = 100_000

export interface PreviewResult {
  would_open: Array<{ issue: number; at: string; title: string }>
  held: Array<{ issue: number; reason: string }>
  /** Issues read from the log (at most 2000). */
  considered: number
  /** True when the replay stopped at its evaluation budget. */
  truncated: boolean
}

const hourFloor = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS
const dayString = (t: number) => new Date(t).toISOString().slice(0, 10)

/**
 * "Would have opened N GitLab issues in the last 7/30 days". Read-only replay over the issue log
 * + hit counters, in time order: each issue is judged when it was written (created, each hour it
 * had hits, last seen) with the hit / people counts as of that moment; the rule's per-hour,
 * per-day and connection caps are applied to the replayed fires in time order (a capped issue is
 * tried again at its next write); quiet hours move a fire to the window's end.
 *
 * Approximations (the log keeps no history of these): status is today's, except a resolved /
 * closed issue counts as open before its last update; linked = a member row on the rule's
 * connection that joined before that moment; route / build / first build are today's; homes
 * (joining an existing GitLab issue instead of opening one) are not modelled — every replayed fire
 * is counted as an opened issue, so with homes in play the real engine opens fewer (joins use no
 * cap slot). At most 2000 issues are read; nothing is written.
 */
export async function previewRule(
  rule: Omit<TrackerRule, 'id'>,
  days: 7 | 30,
  now = new Date()
): Promise<PreviewResult> {
  const r: TrackerRule = { ...rule, id: 0 }
  if (isTicketRule(r)) return previewTicketRule(r, days, now)
  const nowMs = now.getTime()
  const startMs = nowMs - (days === 30 ? 30 : 7) * DAY_MS
  const start = new Date(startMs)

  const issues = (await db('nivaro_issues')
    .where((q) => q.where('created_at', '>=', start).orWhere('last_seen_at', '>=', start))
    .whereNot({ source: 'tracker' })
    .whereNot({ source: IMPORTED_SOURCE })
    .orderBy('id', 'desc')
    .limit(PREVIEW_MAX_ISSUES)
    .select([...ISSUE_COLS, db.raw(HAS_SCREENSHOT)])) as Row[]
  const result: PreviewResult = {
    would_open: [],
    held: [],
    considered: issues.length,
    truncated: false
  }
  if (!issues.length) return result

  const m = r.match
  const leads = new Map<number, number>()
  if (m.group_lead_ids?.length) {
    try {
      for (const g of await groupSimilarIssues()) {
        leads.set(g.lead.id, g.lead.id)
        for (const v of g.variants) leads.set(v.id, g.lead.id)
      }
    } catch {
      // no groups: nothing matches a group condition
    }
  }
  const roles = new Map<string, string>()
  if (m.raised_by_roles?.length) {
    const people = [
      ...new Set(
        issues
          .map((i) => i.raised_by)
          .filter(Boolean)
          .map(String)
      )
    ]
    const users = await selectInChunks(
      people,
      500,
      async (chunk) =>
        (await whereInList(db('nivaro_users'), 'id', chunk).select('id', 'role')) as Row[]
    )
    for (const u of users) if (u.role != null) roles.set(String(u.id).toLowerCase(), String(u.role))
  }

  const baseFacts = (i: Row): IssueFacts => ({
    id: Number(i.id),
    title: String(i.title ?? ''),
    details: i.details == null ? null : String(i.details),
    severity: String(i.severity ?? ''),
    status: String(i.status ?? 'open'),
    source: String(i.source ?? 'manual'),
    route: null,
    collection: i.collection == null ? null : String(i.collection),
    item: i.item == null ? null : String(i.item),
    environment: appEnvironment(),
    build: null,
    current_build: NIVARO_VERSION,
    first_build: null,
    fingerprint: i.fingerprint ? String(i.fingerprint) : null,
    group_lead_id: leads.get(Number(i.id)) ?? null,
    raised_by: i.raised_by == null ? null : String(i.raised_by),
    raised_by_role: i.raised_by ? (roles.get(String(i.raised_by).toLowerCase()) ?? null) : null,
    assigned_to: i.assigned_to == null ? null : String(i.assigned_to),
    has_screenshot: Number(i.has_screenshot) === 1,
    has_replay: !!i.recording_id,
    created_at: toDate(i.created_at) ?? start,
    linked: false,
    recurrences: 0,
    total_hits: Number(i.occurrence_count ?? 1) || 1
  })

  // Phase 1: drop issues that cannot match whatever the moment (conditions that do not change
  // over time), before reading occurrences and hit counters for the rest.
  const loose: TrackerRule = {
    ...r,
    match: {
      ...m,
      routes: undefined,
      release: undefined,
      statuses: undefined,
      min_age_minutes: undefined,
      max_age_minutes: undefined
    },
    threshold: {},
    guards: { ...r.guards, quiet: undefined, skip_statuses: [] }
  }
  const facts = new Map<number, IssueFacts>()
  const rowOf = new Map<number, Row>()
  for (const i of issues) {
    const f = baseFacts(i)
    const out = evaluateRule(loose, f, ZERO_COUNTS, ZERO_GUARDS, now)
    if (out.act === 'skip' && out.outcome === 'no_match') continue
    facts.set(f.id, f)
    rowOf.set(f.id, i)
  }
  if (!facts.size) return result
  const ids = [...facts.keys()]

  if (m.routes?.length || m.release) {
    const occ = await selectInChunks(
      ids,
      500,
      async (chunk) =>
        (await whereInList(db('nivaro_issue_occurrences'), 'issue', chunk).select(
          'issue',
          'route',
          'build',
          'occurred_at'
        )) as Row[]
    )
    const newest = new Map<number, Row>()
    const oldestBuild = new Map<number, Row>()
    for (const o of occ) {
      const id = Number(o.issue)
      const t = toDate(o.occurred_at)?.getTime() ?? 0
      const n = newest.get(id)
      if (!n || t > (toDate(n.occurred_at)?.getTime() ?? 0)) newest.set(id, o)
      if (o.build) {
        const b = oldestBuild.get(id)
        if (!b || t < (toDate(b.occurred_at)?.getTime() ?? 0)) oldestBuild.set(id, o)
      }
    }
    for (const [id, f] of facts) {
      const n = newest.get(id)
      f.route = n?.route ? String(n.route) : null
      f.build = n?.build ? String(n.build) : null
      const b = oldestBuild.get(id)
      f.first_build = b?.build ? String(b.build) : null
    }
  }

  if (r.threshold.recurrences !== undefined) {
    const fps = [...new Set([...facts.values()].map((f) => f.fingerprint).filter(Boolean))]
    const closed = await selectInChunks(
      fps as string[],
      500,
      async (chunk) =>
        (await whereInList(db('nivaro_issues'), 'fingerprint', chunk)
          .whereIn('status', SKIP_STATUSES)
          .select('id', 'fingerprint')) as Row[]
    )
    for (const f of facts.values()) {
      if (!f.fingerprint) continue
      f.recurrences = closed.filter(
        (c) => String(c.fingerprint) === f.fingerprint && Number(c.id) < f.id
      ).length
    }
  }

  // Joined-at of each issue's member row on the rule's connection.
  const joined = new Map<number, number>()
  const members = await selectInChunks(
    ids.map(String),
    500,
    async (chunk) =>
      (await whereInList(db(MEMBERS), 'source_id', chunk)
        .where({ connection: r.action.connection, source_kind: SOURCE_ISSUE })
        .select('source_id', 'joined_at')) as Row[]
  )
  for (const mm of members)
    joined.set(Number(mm.source_id), toDate(mm.joined_at)?.getTime() ?? Number.NEGATIVE_INFINITY)

  // Hit buckets (also the moments each issue was written) and distinct people per day.
  const windowMs =
    Math.max(r.threshold.hits?.window_minutes ?? 0, r.threshold.people?.window_minutes ?? 0) *
    60_000
  const keyOf = new Map<number, string>()
  for (const f of facts.values()) keyOf.set(f.id, hitKey({ id: f.id, fingerprint: f.fingerprint }))
  const keys = [...new Set(keyOf.values())]
  const hitsByKey = new Map<string, Array<{ hour: number; hits: number }>>()
  const hitRows = await selectInChunks(
    keys,
    500,
    async (chunk) =>
      (await whereInList(db('nivaro_issue_hits'), 'key', chunk)
        .where('hour', '>=', new Date(hourFloor(startMs - windowMs)))
        .select('key', 'hour', 'hits')) as Row[]
  )
  for (const h of hitRows) {
    const list = hitsByKey.get(String(h.key)) ?? []
    list.push({ hour: toDate(h.hour)?.getTime() ?? 0, hits: Number(h.hits) || 0 })
    hitsByKey.set(String(h.key), list)
  }
  const peopleByKey = new Map<string, Array<{ day: string; user: string }>>()
  if (r.threshold.people) {
    const pRows = await selectInChunks(
      keys,
      500,
      async (chunk) =>
        (await whereInList(db('nivaro_issue_hit_people'), 'key', chunk)
          .where('day', '>=', dayString(startMs - windowMs))
          .select('key', 'day', 'user_id')) as Row[]
    )
    for (const p of pRows) {
      const list = peopleByKey.get(String(p.key)) ?? []
      const day =
        p.day instanceof Date ? p.day.toISOString().slice(0, 10) : String(p.day).slice(0, 10)
      list.push({ day, user: String(p.user_id).toLowerCase() })
      peopleByKey.set(String(p.key), list)
    }
  }

  const countsAt = (key: string, t: number): Counts => ({
    hits: (w) => {
      const from = hourFloor(t - w * 60_000)
      let n = 0
      for (const b of hitsByKey.get(key) ?? []) if (b.hour >= from && b.hour <= t) n += b.hits
      return n
    },
    people: (w) => {
      const from = dayString(t - w * 60_000)
      const to = dayString(t)
      const seen = new Set<string>()
      for (const p of peopleByKey.get(key) ?? []) if (p.day >= from && p.day <= to) seen.add(p.user)
      return seen.size
    }
  })

  // The moments each issue was written inside the window, in time order.
  const events: Array<{ t: number; issue: number }> = []
  for (const f of facts.values()) {
    const row = rowOf.get(f.id) as Row
    const created = f.created_at.getTime()
    const times = new Set<number>()
    if (created >= startMs && created <= nowMs) times.add(created)
    for (const b of hitsByKey.get(keyOf.get(f.id) as string) ?? []) {
      const t = Math.min(b.hour + HOUR_MS - 1, nowMs)
      if (t >= startMs && t >= created) times.add(t)
    }
    const seen = toDate(row.last_seen_at)?.getTime()
    if (seen !== undefined && seen >= startMs && seen <= nowMs) times.add(seen)
    for (const t of times) events.push({ t, issue: f.id })
  }
  const byTime = (a: { t: number; issue: number }, b: { t: number; issue: number }) =>
    a.t - b.t || a.issue - b.issue
  events.sort(byTime)
  const insert = (ev: { t: number; issue: number }) => {
    let lo = 0
    let hi = events.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (byTime(events[mid], ev) <= 0) lo = mid + 1
      else hi = mid
    }
    events.splice(lo, 0, ev)
  }

  const fired = new Set<number>()
  const firedAt: number[] = []
  const heldReason = new Map<number, string>()
  const quietScheduled = new Set<string>()
  let evals = 0
  for (let i = 0; i < events.length; i++) {
    const { t, issue } = events[i]
    if (fired.has(issue)) continue
    if (++evals > PREVIEW_MAX_EVALS) {
      result.truncated = true
      break
    }
    const f = facts.get(issue) as IssueFacts
    const row = rowOf.get(issue) as Row
    const updated = toDate(row.updated_at)?.getTime() ?? 0
    const status = SKIP_STATUSES.includes(f.status.toLowerCase()) && updated > t ? 'open' : f.status
    const total = Math.max(
      1,
      f.total_hits -
        (hitsByKey.get(keyOf.get(issue) as string) ?? [])
          .filter((b) => b.hour > t)
          .reduce((s, b) => s + b.hits, 0)
    )
    const at: IssueFacts = {
      ...f,
      status,
      total_hits: total,
      linked: (joined.get(issue) ?? Number.POSITIVE_INFINITY) <= t
    }
    const hour = firedAt.filter((x) => x > t - HOUR_MS).length
    const guards: GuardState = {
      firedLastHour: hour,
      firedLastDay: firedAt.filter((x) => x > t - DAY_MS).length,
      connectionLastHour: hour,
      connectionCap: CONNECTION_CAP_PER_HOUR
    }
    const out = evaluateRule(r, at, countsAt(keyOf.get(issue) as string, t), guards, new Date(t))
    if (out.act !== 'skip') {
      fired.add(issue)
      firedAt.push(t)
      heldReason.delete(issue)
      result.would_open.push({ issue, at: new Date(t).toISOString(), title: f.title })
      continue
    }
    if (out.outcome === 'quiet' && r.guards.quiet) {
      const end = nextQuietEnd(r.guards.quiet, new Date(t))?.getTime()
      if (end !== undefined && end <= nowMs) {
        const k = `${issue}:${end}`
        if (!quietScheduled.has(k)) {
          quietScheduled.add(k)
          insert({ t: end, issue })
        }
        heldReason.set(issue, out.detail)
      } else heldReason.set(issue, `${out.detail} (still quiet now)`)
    } else if (out.outcome === 'cap' || out.outcome === 'linked' || out.outcome === 'status')
      heldReason.set(issue, out.detail)
  }
  for (const [issue, reason] of heldReason)
    if (!fired.has(issue)) result.held.push({ issue, reason })
  return result
}

/**
 * previewRule for a support-ticket rule: each ticket raised in the window is judged once, when it
 * was raised (or once `open_minutes` had passed, if that is still inside the window), with today's
 * status (a done / cancelled ticket counts as open before its last update), linked = a member row
 * on the rule's connection that joined before that moment, and the caps applied in time order.
 * Similar-issue joins are not modelled. At most 2000 tickets; nothing is written.
 */
async function previewTicketRule(r: TrackerRule, days: 7 | 30, now: Date): Promise<PreviewResult> {
  const nowMs = now.getTime()
  const startMs = nowMs - (days === 30 ? 30 : 7) * DAY_MS
  const rows = (await db('nivaro_tasks')
    .where({ kind: 'support' })
    .where('created_at', '>=', new Date(startMs))
    .orderBy('id', 'desc')
    .limit(PREVIEW_MAX_ISSUES)
    .select(
      'id',
      'title',
      'description',
      'status',
      'priority',
      'category_id',
      'created_by',
      'assignee',
      'created_at',
      'updated_at'
    )) as Row[]
  const result: PreviewResult = {
    would_open: [],
    held: [],
    considered: rows.length,
    truncated: false
  }
  if (!rows.length) return result
  const roles = new Map<string, string>()
  if (r.match.raised_by_roles?.length) {
    const people = [
      ...new Set(
        rows
          .map((t) => t.created_by)
          .filter(Boolean)
          .map(String)
      )
    ]
    const users = await selectInChunks(
      people,
      500,
      async (chunk) =>
        (await whereInList(db('nivaro_users'), 'id', chunk).select('id', 'role')) as Row[]
    )
    for (const u of users) if (u.role != null) roles.set(String(u.id).toLowerCase(), String(u.role))
  }
  const joined = new Map<number, number>()
  const members = await selectInChunks(
    rows.map((t) => String(t.id)),
    500,
    async (chunk) =>
      (await whereInList(db(MEMBERS), 'source_id', chunk)
        .where({ connection: r.action.connection, source_kind: 'ticket' })
        .select('source_id', 'joined_at')) as Row[]
  )
  for (const m of members)
    joined.set(Number(m.source_id), toDate(m.joined_at)?.getTime() ?? Number.NEGATIVE_INFINITY)

  const events = rows
    .map((t) => {
      const created = toDate(t.created_at)?.getTime() ?? startMs
      const at = created + (r.threshold.open_minutes ?? 0) * 60_000
      return { t: at, row: t, created }
    })
    .filter((e) => e.t >= startMs && e.t <= nowMs)
    .sort((a, b) => a.t - b.t || Number(a.row.id) - Number(b.row.id))
  const firedAt: number[] = []
  for (const e of events) {
    const t = e.row
    const id = Number(t.id)
    const updated = toDate(t.updated_at)?.getTime() ?? 0
    const status = String(t.status ?? 'open')
    const facts: TicketFacts = {
      id,
      title: String(t.title ?? ''),
      description: t.description == null ? null : String(t.description),
      status: ['done', 'cancelled'].includes(status) && updated > e.t ? 'open' : status,
      priority: String(t.priority ?? 'normal'),
      category_id: t.category_id == null ? null : Number(t.category_id),
      requester: t.created_by == null ? null : String(t.created_by),
      requester_role: t.created_by ? (roles.get(String(t.created_by).toLowerCase()) ?? null) : null,
      assignee: t.assignee == null ? null : String(t.assignee),
      created_at: new Date(e.created),
      linked: (joined.get(id) ?? Number.POSITIVE_INFINITY) <= e.t
    }
    const hour = firedAt.filter((x) => x > e.t - HOUR_MS).length
    const out = evaluateTicketRule(
      r,
      facts,
      {
        firedLastHour: hour,
        firedLastDay: firedAt.filter((x) => x > e.t - DAY_MS).length,
        connectionLastHour: hour,
        connectionCap: CONNECTION_CAP_PER_HOUR
      },
      new Date(e.t)
    )
    if (out.act !== 'skip') {
      firedAt.push(e.t)
      result.would_open.push({ issue: id, at: new Date(e.t).toISOString(), title: facts.title })
    } else if (['cap', 'linked', 'status', 'quiet'].includes(out.outcome))
      result.held.push({ issue: id, reason: out.detail })
  }
  return result
}

// ── Rule CRUD (routes/trackers.ts) ────────────────────────────────────────────

export async function listRules(): Promise<RuleView[]> {
  const rows = (await db(RULES).orderBy('sort', 'asc').orderBy('id', 'asc')) as Row[]
  return rows.map(ruleView)
}

export async function getRule(id: number): Promise<RuleView | null> {
  const row = (await db(RULES).where({ id }).first()) as Row | undefined
  return row ? ruleView(row) : null
}

const ruleColumns = (rule: Omit<TrackerRule, 'id'>): Row => ({
  applies_to: rule.applies_to ?? 'issue',
  name: rule.name,
  enabled: rule.enabled,
  mode: rule.mode,
  sort: rule.sort,
  continue_after: rule.continue_after,
  connection: rule.action.connection,
  match: JSON.stringify(rule.match),
  threshold: JSON.stringify(rule.threshold),
  guards: JSON.stringify(rule.guards),
  action: JSON.stringify(rule.action)
})

const description = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined
  if (v === null) return null
  return typeof v === 'string' ? v.trim().slice(0, 1000) || null : undefined
}

export class RuleInputError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly errors?: Array<{ path: string; message: string }>
  ) {
    super(message)
    this.name = 'RuleInputError'
  }
}

async function assertConnection(id: number): Promise<void> {
  if (!(await getConnection(id)))
    throw new RuleInputError('Choose a GitLab connection that exists', 400, 'INVALID_RULE', [
      { path: 'action.connection', message: 'This connection does not exist.' }
    ])
}

function invalid(res: Extract<ValidateResult, { ok: false }>): RuleInputError {
  return new RuleInputError('The rule is not valid', 400, 'INVALID_RULE', res.errors)
}

export async function createRule(body: unknown, userId: string | null): Promise<RuleView> {
  const res = validateRule(body)
  if (!res.ok) throw invalid(res)
  await assertConnection(res.rule.action.connection)
  const now = new Date()
  const b = (body && typeof body === 'object' ? body : {}) as Row
  const inserted = (await db(RULES)
    .insert({
      ...ruleColumns(res.rule),
      description: description(b.description) ?? null,
      created_by: userId,
      updated_by: userId,
      created_at: now,
      updated_at: now
    })
    .returning('id')) as unknown[]
  const first = inserted[0]
  const id = Number(typeof first === 'object' && first !== null ? (first as Row).id : first)
  return (await getRule(id)) as RuleView
}

const PLAIN_KEYS = new Set(['enabled', 'sort', 'name', 'description'])

/**
 * Change a rule: the body's top-level keys replace the stored ones and the result is validated
 * again. A stored rule that no longer validates can still be switched off, renamed or moved.
 */
export async function updateRule(
  id: number,
  body: unknown,
  userId: string | null
): Promise<RuleView> {
  const row = (await db(RULES).where({ id }).first()) as Row | undefined
  if (!row) throw new RuleInputError('Rule not found', 404, 'NOT_FOUND')
  const patch = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Row
  const merged = { ...rawRule(row), ...patch }
  delete (merged as Row).description
  delete (merged as Row).id
  const res = validateRule(merged)
  const now = new Date()
  const desc = description(patch.description)
  if (res.ok) {
    if (res.rule.action.connection !== Number(row.connection))
      await assertConnection(res.rule.action.connection)
    await db(RULES)
      .where({ id })
      .update({
        ...ruleColumns(res.rule),
        ...(desc !== undefined ? { description: desc } : {}),
        updated_by: userId,
        updated_at: now
      })
  } else {
    const plain = Object.keys(patch).every((k) => PLAIN_KEYS.has(k))
    if (!plain || patch.enabled === true) throw invalid(res)
    const upd: Row = { updated_by: userId, updated_at: now }
    if (typeof patch.enabled === 'boolean') upd.enabled = patch.enabled
    if (typeof patch.sort === 'number' && Number.isFinite(patch.sort))
      upd.sort = Math.trunc(patch.sort)
    if (typeof patch.name === 'string' && patch.name.trim())
      upd.name = patch.name.trim().slice(0, 200)
    if (desc !== undefined) upd.description = desc
    await db(RULES).where({ id }).update(upd)
  }
  return (await getRule(id)) as RuleView
}

/** Delete a rule, its decision log and the "suggested by" marks it left on issues. */
export async function deleteRule(id: number): Promise<boolean> {
  const row = (await db(RULES).where({ id }).first('id')) as Row | undefined
  if (!row) return false
  await db(DECISIONS).where({ rule: id }).delete()
  await db('nivaro_issues')
    .where({ tracker_suggested_rule: id })
    .update({ tracker_suggested_rule: null })
  await db(RULES).where({ id }).delete()
  return true
}

/** Put the named rules in this order (sort 10, 20, …). */
export async function reorderRules(ids: number[], userId: string | null): Promise<void> {
  const now = new Date()
  for (let i = 0; i < ids.length; i++)
    await db(RULES)
      .where({ id: ids[i] })
      .update({ sort: (i + 1) * 10, updated_by: userId, updated_at: now })
}

/** Trim every rule's log to 200 and drop the log of rules that no longer exist. */
export async function trimAllDecisions(): Promise<void> {
  const rows = (await db(DECISIONS).distinct('rule')) as Row[]
  const ruleIds = [...new Set(rows.map((r) => Number(r.rule)))].filter(Number.isFinite)
  if (!ruleIds.length) return
  const existing = new Set(
    ((await whereInList(db(RULES), 'id', ruleIds).select('id')) as Row[]).map((r) => Number(r.id))
  )
  for (const id of ruleIds) {
    if (!existing.has(id) && id !== SWEEP_RULE && !CONNECTION_RULES.includes(id))
      await db(DECISIONS).where({ rule: id }).delete()
    else await trimDecisions(id)
  }
}
