/**
 * "Changed after approval" — the reads, the badge's answer and the approvers' notice
 * (round 7, item 21). The pure rules live in approval-changes-core.ts.
 *
 * The approval moment comes from the latest run's pipeline history (approvalMomentOf). The
 * approved values are the record's revision snapshot as of that moment (plus a short grace for
 * the approving move's own writes); "now" is the record read AS THE VIEWER, so the role's field
 * list, row filter and User Scopes all apply, and only fields the viewer may read are compared.
 * Who changed each field comes from the app's writes since then (revisions + activity); a field
 * that differs with no app write behind it was written outside the app (a procedure, a script).
 *
 * Approvers' notice: ONE quiet notice per change burst (category `approval_changes`, mutable in
 * Profile → Notification rules, FYI lane) through notifyUser, never to the person whose own
 * change it was, only to approvers who can still open the record and read a changed field. A
 * burst = the first change after a quiet window (BURST_WINDOW_S), gathered for GATHER_MS so a
 * save that writes ten fields or a 500-row import is one notice. Across API replicas every
 * process adds its changers to a Redis set, one process opens the burst (SET NX PX) and each
 * approver's notice is claimed per record + approver (SET NX PX) before it is sent; per-process
 * maps stand in only while Redis is down. Engine writes count too (a procedure's announced write, an accepted proposal).
 */

import { db, isMssql } from '../db/index.js'
import type { User } from '../types.js'
import {
  APPROVAL_GRACE_MS,
  type ApprovalChange,
  type ApprovalChangesConfig,
  type ApprovalMoment,
  type AppWrite,
  approvalChangesConfigOf,
  approvalMomentOf,
  diffSinceApproval,
  type HistoryStep,
  trackedFields,
  type Writer,
  writerOf
} from './approval-changes-core.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { isMultiTenant } from './deployment-mode.js'
import { latestRecordRun } from './edit-lock.js'
import { getEncryptedFields } from './encryption.js'
import { isMachineAccount } from './machine-accounts.js'
import { readableFieldSet } from './revision-fields.js'
import { parseSummaryModeRules } from './summary-mode.js'
import { currentTenantKey } from './tenant-rooms.js'

export const APPROVAL_CHANGES_CATEGORY = 'approval_changes' as const
/** A burst ends after this long without a change; the next change is a new one. */
export const BURST_WINDOW_S = 10 * 60
/** How long a burst gathers before its one notice goes out. */
export const GATHER_MS = 20_000
/** Most changed fields the badge lists (the count says the rest). */
export const MAX_LISTED = 25

/** The collection's resolved setting, or null when the badge is off there. */
export async function approvalChangesConfigFor(
  collection: string
): Promise<ApprovalChangesConfig | null> {
  const col = (await getCollection(collection).catch(() => undefined)) as
    | { summary_mode_rules?: unknown }
    | undefined
  if (!col) return null
  return approvalChangesConfigOf(parseSummaryModeRules(col.summary_mode_rules))
}

export interface ApprovalStanding {
  run: { id: string; key: string; label: string | null }
  moment: ApprovalMoment
}

/** Where the record stands: approved since when, by whom — or null (not in an approved stretch). */
export async function approvalStandingOf(
  collection: string,
  item: string,
  cfg: ApprovalChangesConfig
): Promise<ApprovalStanding | null> {
  const run = await latestRecordRun(collection, item)
  if (!run || !cfg.states.includes(run.key)) return null
  const rows = (await db('nivaro_workflow_history as h')
    .leftJoin('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
    .join('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
    .where('h.instance', run.id)
    .orderBy([
      { column: 'h.timestamp', order: 'asc' },
      { column: 'h.id', order: 'asc' }
    ])
    .limit(500)
    .select('h.user', 'h.timestamp', 'fs.key as from_key', 'ts.key as to_key')) as Array<{
    user: string | null
    timestamp: Date | string
    from_key: string | null
    to_key: string
  }>
  const steps: HistoryStep[] = rows.map((r) => ({
    user: r.user ? String(r.user) : null,
    at: new Date(r.timestamp),
    from_key: r.from_key ?? null,
    to_key: String(r.to_key)
  }))
  let startedAt: Date | null = null
  if (!steps.some((s) => cfg.states.includes(s.to_key))) {
    const inst = (await db('nivaro_workflow_instances')
      .where({ id: run.id })
      .first('started_at')) as { started_at?: Date | string | null } | undefined
    startedAt = inst?.started_at ? new Date(inst.started_at) : null
  }
  const moment = approvalMomentOf(steps, run.key, cfg, startedAt)
  return moment ? { run: { id: run.id, key: run.key, label: run.label }, moment } : null
}

/** The record's own fields that count, before the viewer's read cut. */
async function candidateFields(collection: string, cfg: ApprovalChangesConfig) {
  const [fields, encrypted, bindings] = await Promise.all([
    getFields(collection),
    getEncryptedFields(collection).catch((): string[] => []),
    db('nivaro_workflow_bindings')
      .where({ collection })
      .select('state_field')
      .catch((): Array<{ state_field: string | null }> => []) as Promise<
      Array<{ state_field: string | null }>
    >
  ])
  const skip = [
    ...cfg.ignore,
    ...encrypted,
    ...bindings.map((b) => String(b.state_field ?? '')).filter(Boolean)
  ]
  return { fields, tracked: trackedFields(fields, skip) }
}

/**
 * Run a per-record read with its own plan on SQL Server (`OPTION (RECOMPILE)`).
 *
 * Prod 2026-11-19 (issue #1116): the `after` read's cached plan was compiled for a record
 * approved hours earlier — a `since` past the end of the statistics, estimated 4 rows — so it
 * drove from `ix_nivaro_activity_timestamp`. Reused for inventory_request 29362 (approved in
 * June) it walked ~5.1M activity rows and timed out at 15 s; a plan that seeks the record's own
 * revisions (`ix_nivaro_revisions_collection_item`) reads 50-200 pages in under 10 ms. A record
 * has a handful of revisions, so compiling per call costs less than one bad cached plan.
 */
async function ownPlan<T>(q: { toSQL: () => { sql: string; bindings: readonly unknown[] } }) {
  if (!isMssql()) return (await (q as unknown as Promise<T>)) as T
  const { sql, bindings } = q.toSQL()
  // Compiled SQL carries one `?` per binding: anything else would be misread — run as built.
  if (/\boption\s*\(/i.test(sql) || (sql.match(/\?/g) ?? []).length !== bindings.length)
    return (await (q as unknown as Promise<T>)) as T
  const rows = (await db.raw(`${sql} OPTION (RECOMPILE)`, [...bindings] as never)) as unknown
  return rows as T
}

/** The app's writes since `since` (newest first) and the snapshot as of it. */
async function revisionsAround(collection: string, item: string, since: Date) {
  const [after, beforeRows] = await Promise.all([
    ownPlan<Array<Record<string, unknown>>>(
      db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'r.activity', 'a.id')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where('r.collection', collection)
        .where('r.item', item)
        .whereNotNull('r.delta')
        .where('a.timestamp', '>', since)
        .orderBy('r.id', 'desc')
        .limit(300)
        .select(
          'r.delta',
          'a.timestamp',
          'a.comment',
          'a.user as user_id',
          'u.first_name',
          'u.last_name',
          'u.email',
          'u.account_kind'
        )
    ),
    // The same shape the other way (`<=`): one cached plan could fail it in reverse.
    ownPlan<Array<{ data?: unknown }>>(
      db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'r.activity', 'a.id')
        .where('r.collection', collection)
        .where('r.item', item)
        .where('a.timestamp', '<=', since)
        .orderBy('r.id', 'desc')
        .limit(1)
        .select('r.data')
    )
  ])
  const before = Array.isArray(beforeRows) ? beforeRows[0] : undefined
  const writes: AppWrite[] = []
  for (const row of after) {
    const delta = parseObject(row.delta)
    if (!delta || Object.keys(delta).length === 0) continue
    writes.push({
      at: new Date(row.timestamp as string),
      delta,
      by: writerOf({
        user_id: (row.user_id as string | null) ?? null,
        first_name: row.first_name as string | null,
        last_name: row.last_name as string | null,
        email: row.email as string | null,
        comment: row.comment as string | null,
        machine: isMachineAccount({
          account_kind: row.account_kind as string | null,
          email: String(row.email ?? '')
        })
      })
    })
  }
  return { writes, approved: before ? parseObject(before.data) : null }
}

function parseObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  try {
    const o = JSON.parse(String(v))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

export interface ApprovalChangeView extends ApprovalChange {
  label: string
  type: string | null
  /** Display text where the raw value means nothing to a reader (a link, a choice). */
  before_text?: string | null
  after_text?: string | null
}

export interface ApprovalChangesAnswer {
  enabled: boolean
  /** Null while the record is not in an approved stretch. */
  approved: {
    at: string
    state: string
    state_label: string | null
    by: Array<{ id: string; name: string }>
  } | null
  changes: ApprovalChangeView[]
  /** Changed fields in all (the list stops at MAX_LISTED). */
  total: number
  /** Line (child row) changes made from the record page since approval. */
  lines: { count: number; at: string | null; by: string | null } | null
}

const OFF: ApprovalChangesAnswer = {
  enabled: false,
  approved: null,
  changes: [],
  total: 0,
  lines: null
}

/**
 * The badge's answer for `viewer`: what changed since approval in the fields they may read.
 * `current` = the record as the viewer reads it (the caller already judged visibility).
 */
export async function approvalChangesFor(
  viewer: User,
  collection: string,
  item: string,
  current: Record<string, unknown>,
  opts: { labels?: boolean } = {}
): Promise<ApprovalChangesAnswer> {
  const cfg = await approvalChangesConfigFor(collection)
  if (!cfg) return OFF
  const standing = await approvalStandingOf(collection, item, cfg)
  if (!standing) return { ...OFF, enabled: true }
  const since = new Date(standing.moment.at.getTime() + APPROVAL_GRACE_MS)
  const [{ fields, tracked }, readable, around, lines, approverNames] = await Promise.all([
    candidateFields(collection, cfg),
    readableFieldSet(viewer, collection),
    revisionsAround(collection, item, since),
    lineChangesSince(collection, item, since),
    peopleNames(standing.moment.approvers)
  ])
  const visible = readable ? tracked.filter((f) => readable.has(f)) : tracked
  const changes = diffSinceApproval({
    approved: around.approved,
    current,
    fields: visible,
    writes: around.writes
  })
  const listed = changes.slice(0, MAX_LISTED)
  const views =
    opts.labels === false
      ? decorate(listed, fields)
      : await label(viewer, collection, listed, fields)
  return {
    enabled: true,
    approved: {
      at: standing.moment.at.toISOString(),
      state: standing.moment.state,
      state_label: await stateLabelOf(standing.run.id, standing.moment.state, standing.run),
      by: standing.moment.approvers
        .map((id) => ({ id, name: approverNames.get(id) ?? '' }))
        .filter((p) => p.name)
    },
    changes: views,
    total: changes.length,
    lines
  }
}

async function stateLabelOf(
  _instance: string,
  key: string,
  run: { key: string; label: string | null }
): Promise<string | null> {
  if (key === run.key) return run.label ?? key
  const row = (await db('nivaro_workflow_instances as i')
    .join('nivaro_workflow_states as s', 's.template', 'i.template')
    .where('i.id', _instance)
    .where('s.key', key)
    .first('s.label')
    .catch(() => undefined)) as { label?: string | null } | undefined
  return row?.label ?? key
}

async function peopleNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', ids)
    .select('id', 'first_name', 'last_name', 'is_redacted')
    .catch(() => [])) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    is_redacted?: boolean | number | null
  }>
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.is_redacted === true || r.is_redacted === 1) continue
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    if (name) out.set(String(r.id).toLowerCase(), name)
  }
  const named = new Map<string, string>()
  for (const id of ids) {
    const n = out.get(id.toLowerCase())
    if (n) named.set(id, n)
  }
  return named
}

/** o2m-* activity rows (lines changed from the record page) since `since`. */
async function lineChangesSince(
  collection: string,
  item: string,
  since: Date
): Promise<ApprovalChangesAnswer['lines']> {
  const rows = (await db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'a.user', 'u.id')
    .where('a.collection', collection)
    .where('a.item', item)
    .whereIn('a.action', ['o2m-create', 'o2m-update', 'o2m-delete'])
    .where('a.timestamp', '>', since)
    .orderBy('a.id', 'desc')
    .limit(200)
    .select('a.timestamp', 'u.first_name', 'u.last_name')
    .catch(() => [])) as Array<{
    timestamp: Date | string
    first_name: string | null
    last_name: string | null
  }>
  if (rows.length === 0) return null
  const top = rows[0]
  return {
    count: rows.length,
    at: new Date(top.timestamp).toISOString(),
    by: [top.first_name, top.last_name].filter(Boolean).join(' ').trim() || null
  }
}

type FieldRow = Awaited<ReturnType<typeof getFields>>[number] & { label?: string | null }

function decorate(changes: ApprovalChange[], fields: FieldRow[]): ApprovalChangeView[] {
  const byName = new Map(fields.map((f) => [f.field, f]))
  return changes.map((c) => {
    const f = byName.get(c.field)
    return {
      ...c,
      label: String(f?.label ?? '').trim() || titleWords(c.field),
      type: f?.type ?? null
    }
  })
}

/** Field labels, choice labels and link labels — read as the viewer. */
async function label(
  viewer: User,
  collection: string,
  changes: ApprovalChange[],
  fields: FieldRow[]
): Promise<ApprovalChangeView[]> {
  const views = decorate(changes, fields)
  if (views.length === 0) return views
  const byName = new Map(fields.map((f) => [f.field, f]))
  // Choices (filter-check imports the items service: loaded on use, never at module load)
  const { choicesOf } = await import('./filter-check.js')
  for (const v of views) {
    const choices = byName.get(v.field) ? choicesOf(byName.get(v.field) as FieldRow) : null
    if (!choices) continue
    const text = (x: unknown) =>
      x == null || x === '' ? null : (choices.find((c) => c.value === String(x))?.label ?? null)
    v.before_text = text(v.before)
    v.after_text = text(v.after)
  }
  // Links (many-to-one)
  const rels = (await getRelations(collection).catch(() => [])) as Array<{
    many_collection: string
    many_field: string
    one_collection: string | null
  }>
  const target = new Map<string, string>()
  for (const r of rels)
    if (r.many_collection === collection && r.one_collection)
      target.set(r.many_field, r.one_collection)
  const asks = new Map<string, Set<string>>()
  for (const v of views) {
    const t = target.get(v.field)
    if (!t) continue
    const set = asks.get(t) ?? new Set<string>()
    for (const x of [v.before, v.after]) if (x != null && x !== '') set.add(String(x))
    asks.set(t, set)
  }
  if (asks.size > 0) {
    const { linkLabelsAsUser, linkLabelKey } = await import('./ai-link-labels.js')
    const labels = await linkLabelsAsUser(viewer, asks).catch(() => ({}) as Record<string, string>)
    for (const v of views) {
      const t = target.get(v.field)
      if (!t) continue
      const text = (x: unknown) =>
        x == null || x === '' ? null : (labels[linkLabelKey(t, String(x))] ?? `#${String(x)}`)
      v.before_text = text(v.before)
      v.after_text = text(v.after)
    }
  }
  return views
}

function titleWords(field: string): string {
  const s = field.replace(/_/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : field
}

// ── Lists: the `$approval_changed` condition ──────────────────────────────────────────────

export const APPROVAL_CHANGED_FIELD = '$approval_changed'
/** Most revision rows one list filter reads. */
export const LIST_ROW_CAP = 20_000

/**
 * The records of `collection` that sit in an approved stretch and have an app write since the
 * approval moment touching a field `readable` lets the reader see (null = every field). Outside
 * writes leave no trace a list can read cheaply, so a list finds app writes only — the record
 * badge finds both. One bounded read behind the read gate, newest writes first (a cut keeps
 * the most recent changes, the same ones every time); ids as text. `partial` = more rows than
 * LIST_ROW_CAP matched, so older changes may be missing from `ids`.
 */
export async function approvalChangedIds(
  collection: string,
  readable: Set<string> | null,
  who: string | null = null
): Promise<{ ids: string[]; partial: boolean }> {
  const none = { ids: [] as string[], partial: false }
  const cfg = await approvalChangesConfigFor(collection)
  if (!cfg) return none
  const bindings = (await db('nivaro_workflow_bindings')
    .where({ collection })
    .select('template')) as Array<{ template: string }>
  if (bindings.length === 0) return none
  const stateRows = (await db('nivaro_workflow_states')
    .whereIn(
      'template',
      bindings.map((b) => b.template)
    )
    .whereIn('key', cfg.states)
    .select('id')) as Array<{ id: string }>
  const approvedIds = stateRows.map((s) => String(s.id))
  if (approvedIds.length === 0) return none
  const moments = db('nivaro_workflow_instances as i')
    .join('nivaro_workflow_history as h', 'h.instance', 'i.id')
    .where('i.collection', collection)
    .whereIn('i.current_state', approvedIds)
    .whereIn('h.to_state', approvedIds)
    .where((b) => b.whereNull('h.from_state').orWhereNotIn('h.from_state', approvedIds))
    .groupBy('i.item')
    .select('i.item')
    .max({ moment: 'h.timestamp' })
    .as('m')
  const { withReadGate } = await import('./read-gate.js')
  const read = (await withReadGate(
    who,
    () =>
      db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'r.activity', 'a.id')
        .join(moments, 'm.item', 'r.item')
        .where('r.collection', collection)
        .whereNotNull('r.delta')
        .whereRaw('a.timestamp > m.moment')
        .orderBy('a.timestamp', 'desc')
        .orderBy('r.id', 'desc')
        .limit(LIST_ROW_CAP + 1)
        .select('r.item', 'r.delta', 'a.timestamp', 'm.moment'),
    { label: 'approval-changed-filter' }
  )) as Array<{
    item: unknown
    delta: unknown
    timestamp: Date | string
    moment: Date | string
  }>
  const partial = read.length > LIST_ROW_CAP
  const rows = partial ? read.slice(0, LIST_ROW_CAP) : read
  if (rows.length === 0) return none
  const { tracked } = await candidateFields(collection, cfg)
  const counted = new Set(readable ? tracked.filter((f) => readable.has(f)) : tracked)
  const out = new Set<string>()
  for (const r of rows) {
    const id = String(r.item)
    if (out.has(id)) continue
    if (new Date(r.timestamp).getTime() <= new Date(r.moment).getTime() + APPROVAL_GRACE_MS)
      continue
    const delta = parseObject(r.delta)
    if (delta && Object.keys(delta).some((k) => counted.has(k))) out.add(id)
  }
  return { ids: [...out], partial }
}

/** Is the condition asking for records changed after approval (true) or the rest (false)? */
export function approvalChangedWanted(cond: { op?: string; value?: unknown }): boolean {
  const negated = cond.op === '_neq' || cond.op === '_nin'
  const off = cond.value === false || cond.value === 'false' || cond.value === 0
  return negated ? off : !off
}

/** The page and its total compile the same condition object: read once for both. */
const resolvedIds = new WeakMap<object, Promise<string[] | null>>()

/** The condition's ids for this reader; null = the read failed (the filter answers nothing). */
export function resolveApprovalChangedCondition(
  cond: object,
  collection: string,
  userId: string | null
): Promise<string[] | null> {
  let hit = resolvedIds.get(cond)
  if (!hit) {
    hit = (async () => {
      if (!userId) return null
      const { getUser } = await import('./users.js')
      const user = await getUser(userId)
      if (!user) return null
      const { ids, partial } = await approvalChangedIds(
        collection,
        await readableFieldSet(user, collection),
        userId
      )
      // Said honestly: the list names the filter in meta.partial (services/partial-reads.ts).
      if (partial) {
        const { notePartialRead } = await import('./partial-reads.js')
        notePartialRead(APPROVAL_CHANGED_FIELD)
      }
      return ids
    })().catch(() => null)
    resolvedIds.set(cond, hit)
  }
  return hit
}

// ── Approvers' notice: one per change burst ──────────────────────────────────────────────

interface Burst {
  changers: Set<string | null>
  startedAt: Date
  timer: ReturnType<typeof setTimeout>
}
const bursts = new Map<string, Burst>()
/** Fallback gates while Redis is down: key -> expiry (ms). This process decides alone then. */
const localGate = new Map<string, number>()
const NOBODY = '~'
const BURST_MS = BURST_WINDOW_S * 1000

/** Pure: who gets this burst's notice — approvers other than the people who made it. */
export function noticeRecipients(approvers: string[], changers: Iterable<string | null>): string[] {
  const made = [...changers]
  // A burst made only by the approver themself is never news to them.
  return approvers.filter((a) => made.some((c) => c == null || c.toLowerCase() !== a.toLowerCase()))
}

interface BurstRedis {
  set(...args: unknown[]): Promise<unknown>
  sadd?(key: string, ...members: string[]): Promise<unknown>
  pexpire?(key: string, ms: number): Promise<unknown>
  smembers?(key: string): Promise<string[]>
}

async function burstRedis(): Promise<BurstRedis | null> {
  const app = (await import('./io-holder.js')).getApp() as { redis?: BurstRedis } | null
  return app?.redis?.set ? app.redis : null
}

/**
 * Claim `key` for `ms` across every API process (SET NX PX). True = this caller holds it.
 * Redis down or absent: a per-process gate stands in (each process then decides alone).
 */
export async function claimOnce(key: string, ms: number): Promise<boolean> {
  const redis = await burstRedis()
  if (redis) {
    try {
      return (await redis.set(`nvr:cab:${key}`, '1', 'PX', ms, 'NX')) === 'OK'
    } catch {
      /* fall through to the local gate */
    }
  }
  const now = Date.now()
  if ((localGate.get(key) ?? 0) > now) return false
  localGate.set(key, now + ms)
  if (localGate.size > 5000) for (const [k, t] of localGate) if (t <= now) localGate.delete(k)
  return true
}

/** Remember who changed the record in this burst, on every process (Redis set). */
async function addChanger(key: string, changer: string | null): Promise<void> {
  const redis = await burstRedis()
  if (!redis?.sadd || !redis.pexpire) return
  try {
    const k = `nvr:cab:chg:${key}`
    await redis.sadd(k, changer ?? NOBODY)
    await redis.pexpire(k, BURST_MS + GATHER_MS)
  } catch {
    /* the local set still has this process's changers */
  }
}

/** Every process's changers for the burst, merged with this process's own. */
export async function burstChangers(
  key: string,
  local: Set<string | null>
): Promise<Set<string | null>> {
  const out = new Set(local)
  const redis = await burstRedis()
  if (redis?.smembers) {
    try {
      for (const m of await redis.smembers(`nvr:cab:chg:${key}`)) out.add(m === NOBODY ? null : m)
    } catch {
      /* local only */
    }
  }
  return out
}

/**
 * A write landed on records of `collection` (after-update hook, an announced outside write).
 * `changer` = the person who made it, null for a procedure / script / engine write. Every
 * process records the changer; ONE process (the one whose SET NX won) gathers and sends.
 */
export async function noteApprovalWrite(
  collection: string,
  ids: Array<string | number>,
  changer: string | null
): Promise<void> {
  if (isMultiTenant()) return
  if (!ids.length || ids.length > 20) return
  if (!(await approvalChangesConfigFor(collection))) return
  for (const raw of ids) {
    const item = String(raw)
    const key = `${currentTenantKey() || '-'}:${collection}:${item}`
    await addChanger(key, changer)
    const open = bursts.get(key)
    if (open) {
      open.changers.add(changer)
      continue
    }
    if (!(await claimOnce(`open:${key}`, BURST_MS))) continue
    const burst: Burst = {
      changers: new Set([changer]),
      startedAt: new Date(),
      timer: setTimeout(() => {
        bursts.delete(key)
        void burstChangers(key, burst.changers)
          .then((all) => sendApprovalNotices(collection, item, all, burst.startedAt, key))
          .catch(() => {})
      }, GATHER_MS)
    }
    burst.timer.unref?.()
    bursts.set(key, burst)
  }
}

/** The burst's notices. Exported for tests (the deps are the database and notifyUser). */
export async function sendApprovalNotices(
  collection: string,
  item: string,
  changers: Set<string | null>,
  burstStart: Date = new Date(Date.now() - GATHER_MS),
  burstKey = `${currentTenantKey() || '-'}:${collection}:${item}`
): Promise<number> {
  const cfg = await approvalChangesConfigFor(collection)
  if (!cfg) return 0
  const standing = await approvalStandingOf(collection, item, cfg)
  if (!standing) return 0
  // The burst must have changed something after approval: an empty burst (a write before the
  // grace ended, a value put back) tells nobody. A little slack for clocks between processes.
  const since = burstStart.getTime() - 5_000
  const recipients = noticeRecipients(standing.moment.approvers, changers)
  if (recipients.length === 0) return 0
  const app = (await import('./io-holder.js')).getApp() as any
  if (!app) return 0
  const [{ getUser }, { notifyUser }, { recordDisplayRef }, { readOne }] = await Promise.all([
    import('./users.js'),
    import('./notification-channels.js'),
    import('./record-display-ref.js'),
    import('./items.js')
  ])
  const changerNames = await peopleNames([...changers].filter((c): c is string => !!c).map(String))
  let sent = 0
  for (const rid of recipients) {
    try {
      const user = await getUser(rid)
      if (!user) continue
      const u = user as User & { status?: string; is_redacted?: unknown; account_kind?: string }
      if (u.status === 'suspended' || u.status === 'inactive' || u.is_redacted) continue
      if (isMachineAccount(u as never)) continue
      const row = (await readOne(user, collection, item).catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (!row) continue
      const answer = await approvalChangesFor(user, collection, item, row, { labels: false })
      // Only what changed in this burst's window — and only fields this approver may read.
      const fresh = answer.changes.filter((c) => c.at == null || new Date(c.at).getTime() >= since)
      const linesFresh = !!answer.lines?.at && new Date(answer.lines.at).getTime() >= since
      if (fresh.length === 0 && !linesFresh) continue
      const others = [...changers]
        .filter((c) => c == null || c.toLowerCase() !== rid.toLowerCase())
        .map((c) => (c ? changerNames.get(c) : null) ?? 'A process outside the app')
      const who = [...new Set(others)].slice(0, 2).join(' and ') || 'Someone'
      const fieldNames = fresh.map((c) => c.label)
      const what =
        fieldNames.length === 0
          ? 'its lines'
          : fieldNames.length <= 3
            ? fieldNames.join(', ')
            : `${fieldNames.slice(0, 2).join(', ')} and ${fieldNames.length - 2} more fields`
      const ref = await recordDisplayRef(collection, item, { recipient: user }).catch(
        () => `#${item}`
      )
      // One notice per approver per burst window across every API process (Redis SET NX PX on
      // record + approver; the per-process gate only while Redis is down).
      if (!(await claimOnce(`sent:${burstKey}:${rid.toLowerCase()}`, BURST_MS))) continue
      await notifyUser(app, rid, {
        subject: `Changed after approval: ${ref}`,
        message: `${who} changed ${what} after it was approved. Open the record to see the approved value next to the value now.`,
        category: APPROVAL_CHANGES_CATEGORY,
        collection,
        item,
        lane: 'fyi'
      })
      sent++
    } catch {
      /* one approver's notice never stops the next */
    }
  }
  return sent
}

/** Writers the badge names, for tests and the docs. */
export type { Writer }
