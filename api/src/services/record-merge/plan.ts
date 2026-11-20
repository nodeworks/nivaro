/**
 * Merge records — what the merge screen shows (GET /api/record-merge/:collection/plan).
 * Everything is read AS THE CALLER: the records (a record they cannot read is "gone"),
 * the fields (only fields they may read; `writable` only where they may update), the
 * relation counts (a row they cannot see is counted as hidden and stops a move), and per
 * record whether it may survive (they may change it) and whether it may be discarded
 * (they may delete it; edit locks, post-approval locks and partner ids judged).
 */

import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { inboundForeignKeysSql } from '../../db/dialect/items-query.js'
import { db } from '../../db/index.js'
import { rawRows } from '../../db/raw-rows.js'
import type { User } from '../../types.js'
import { getCollection, getFields, getRelations } from '../collections.js'
import { can, getAllowedFields, isAdminRole } from '../permissions.js'
import {
  ATTACHED_KINDS,
  fieldTitle,
  type InboundRelation,
  inboundRelations,
  isMergeField,
  MAX_MERGE_RECORDS,
  type MergeAttachedKind,
  type MergeRelationKind,
  MOVE_ROW_CAP,
  type MoveChoice,
  mergeSettingOf,
  SYSTEM_COLLECTION,
  singularOf,
  UNDO_WINDOW_MS
} from './rules.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export class MergeRefusal extends Error {
  statusCode: number
  code: string
  record?: string
  /** MERGE_STALE: who changed the record (a name), for the screen to set off. */
  changedBy?: string | null
  constructor(
    status: number,
    code: string,
    message: string,
    record?: string,
    changedBy?: string | null
  ) {
    super(message)
    this.statusCode = status
    this.code = code
    this.record = record
    this.changedBy = changedBy
  }
}

export interface MergePlanRecord {
  id: string
  label: string
  /** The record as the person read it, hashed: a merge sent with an older stamp is
   *  refused (409 MERGE_STALE) — someone changed the record since. */
  stamp: string
  /** How people tell the records apart: the friendly id (when set and readable), else #id. */
  ref: string
  /** When the record was created (the collection's created stamp), when known. */
  created_at: string | null
  values: Record<string, unknown>
  state: { key: string; label: string; color: string | null } | null
  can_survive: boolean
  survive_reason: string | null
  can_discard: boolean
  discard_reason: string | null
  /** Sent to a partner (an id the partner holds): admins may still discard, with a warning. */
  partner: { sent: number; partners: string[]; warning: string } | null
  open_tasks: number
  open_approvals: number
}

export interface MergePlanField {
  field: string
  label: string
  type: string
  interface: string | null
  writable: boolean
  /** M2O: the collection the value points at (labels in `labels[field]`). */
  relation: string | null
  choices: Array<{ value: unknown; text: string }> | null
}

export interface MergePlanRelation {
  key: string
  kind: MergeRelationKind | MergeAttachedKind
  label: string
  collection: string
  field: string
  /** Rows per record id (what the caller can see). */
  counts: Record<string, number>
  /** Rows per record id the caller cannot see (stop a move). */
  hidden: Record<string, number>
  movable: boolean
  reason: string | null
  default: MoveChoice
  /** What "move" means here, in a few words. */
  move_word: string
  leave_word: string
}

export interface MergePlan {
  collection: string
  noun: string
  plural: string
  is_admin: boolean
  records: MergePlanRecord[]
  fields: MergePlanField[]
  relations: MergePlanRelation[]
  labels: Record<string, Record<string, string>>
  undo_hours: number
  max_records: number
  /** When this plan was read (the merge sends it back as `opened_at`). */
  read_at: string
}

export function parseIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const out: string[] = []
  for (const v of list) {
    const s = String(v ?? '').trim()
    if (!s || s.length > 64) continue
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

/** A short hash of a record as read (keys sorted; the pipeline step included). */
export function recordStamp(row: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString()
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, norm(o[k])])
      )
    }
    return v ?? null
  }
  const state = row.$state as { key?: unknown } | null | undefined
  const { $state: _s, ...rest } = row
  return createHash('sha1')
    .update(JSON.stringify([norm(rest), state?.key ?? null]))
    .digest('base64url')
    .slice(0, 16)
}

const readable = (allowed: string[] | null, f: string) =>
  allowed == null || allowed.includes('*') || allowed.includes(f)

/** The collection's merge switch + names; refuses a collection that does not merge. */
export async function mergeCollection(collection: string): Promise<{
  noun: string
  plural: string
  allowed: boolean
  friendlyField: string | null
}> {
  if (!IDENT.test(collection) || SYSTEM_COLLECTION.test(collection))
    throw new MergeRefusal(400, 'MERGE_NOT_HERE', 'These records cannot be merged.')
  const col = (await getCollection(collection).catch(() => undefined)) as
    | (Record<string, unknown> & { browser_config?: unknown })
    | undefined
  if (!col) throw new MergeRefusal(404, 'NOT_FOUND', 'This list does not exist.')
  const words = collection.replace(/_/g, ' ')
  // One record of the list: the configured singular, else the list's name made singular.
  const noun = (
    String(col.singular ?? '').trim() || singularOf(String(col.display_name ?? '').trim() || words)
  ).toLowerCase()
  const plural = (
    String(col.plural ?? '').trim() ||
    String(col.display_name ?? '').trim() ||
    words
  ).toLowerCase()
  const friendly = String(col.friendly_id_field ?? '').trim()
  return {
    noun,
    plural,
    allowed: mergeSettingOf(collection, col.browser_config).allowed,
    friendlyField: IDENT.test(friendly) ? friendly : null
  }
}

async function readRecords(
  user: User,
  collection: string,
  ids: string[],
  req: FastifyRequest
): Promise<Array<Record<string, unknown>>> {
  const { readItems } = await import('../items.js')
  const res = (await readItems(
    user,
    collection,
    { filter: { id: { _in: ids } }, fields: ['*'], limit: ids.length, count: false },
    req,
    req.workspaceId ?? undefined
  )) as { data?: Array<Record<string, unknown>> }
  const rows = res.data ?? []
  try {
    const { attachRecordState } = await import('../record-state.js')
    await attachRecordState(collection, rows)
  } catch {
    /* no pipeline facts — the merge does not depend on them */
  }
  return rows
}

/** Physical foreign keys into the collection (every dialect: db/dialect/items-query.ts). */
async function physicalKeys(collection: string): Promise<Array<{ table: string; column: string }>> {
  try {
    const rows = rawRows<{ table_name: string; column_name: string }>(
      await db.raw(inboundForeignKeysSql(), [collection])
    )
    return rows.map((r) => ({ table: String(r.table_name), column: String(r.column_name) }))
  } catch {
    return []
  }
}

/** Relations whose table and column exist (relations are claims, not truth). */
export async function liveInbound(collection: string): Promise<InboundRelation[]> {
  const [relations, physical] = await Promise.all([
    getRelations().catch(() => []),
    physicalKeys(collection)
  ])
  const all = inboundRelations(collection, relations as never, physical)
  const { getActualColumns } = await import('../items.js')
  const out: InboundRelation[] = []
  for (const r of all) {
    const cols = await getActualColumns(r.collection).catch(() => new Set<string>())
    if (cols.has(r.field)) out.push(r)
  }
  return out
}

/** Rows of `table.field` pointing at each id (raw count, every row; behind the read gate). */
async function rawCounts(table: string, field: string, ids: string[], who: string) {
  const out: Record<string, number> = {}
  const { withReadGate } = await import('../read-gate.js')
  const rows = (await withReadGate(
    who,
    () => db(table).whereIn(field, ids).groupBy(field).select(field).count({ n: '*' }),
    { label: 'record-merge:counts' }
  )) as Array<Record<string, unknown>>
  for (const r of rows) {
    const id = ids.find((x) => sameId(x, r[field]))
    if (id) out[id] = (out[id] ?? 0) + Number(r.n ?? 0)
  }
  return out
}

/** Rows of `table.field` pointing at each id that the caller can read. */
export async function visibleRows(
  user: User,
  table: string,
  field: string,
  ids: string[],
  req: FastifyRequest,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const { readItems } = await import('../items.js')
  const res = (await readItems(
    user,
    table,
    { filter: { [field]: { _in: ids } }, fields: ['id', field], limit, count: false },
    req,
    req.workspaceId ?? undefined
  )) as { data?: Array<Record<string, unknown>> }
  return res.data ?? []
}

function relationLabel(r: InboundRelation, titles: Map<string, string>): string {
  const coll = titles.get(r.collection) ?? fieldTitle(r.collection)
  if (r.alias && (r.kind === 'lines' || r.kind === 'm2m' || r.kind === 'files'))
    return fieldTitle(r.alias)
  return `${coll} (${fieldTitle(r.field).toLowerCase()})`
}

const HIDDEN_SOME: Record<MergeAttachedKind, string> = {
  comments: 'are on fields you cannot see',
  tasks: 'are other people’s tasks you cannot manage',
  record_links: 'link to records you cannot see'
}
const HIDDEN_ALL: Record<MergeAttachedKind, string> = {
  comments: 'They are on fields you cannot see, so they stay with the discarded record.',
  tasks: 'They are other people’s tasks you cannot manage, so they stay with the discarded record.',
  record_links: 'They link to records you cannot see, so they stay with the discarded record.'
}

const MOVE_WORDS: Record<string, [string, string]> = {
  lines: ['Move to the kept record', 'Leave on the discarded record'],
  links: ['Point them at the kept record', 'Leave pointing at the discarded record'],
  m2m: ['Add to the kept record', 'Keep only the kept record’s'],
  files: ['Add to the kept record', 'Keep only the kept record’s'],
  comments: ['Move to the kept record', 'Leave with the discarded record'],
  tasks: ['Move to the kept record', 'Close them with a merge note'],
  record_links: ['Move to the kept record', 'Leave with the discarded record']
}

/** Partner sends per record (a landed push = an id a partner holds). */
async function partnerSends(collection: string, ids: string[]) {
  const out = new Map<string, { sent: number; partners: Set<string> }>()
  try {
    const rows = (await db('nivaro_erp_submissions as s')
      .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
      .where('s.collection', collection)
      .whereIn('s.item', ids)
      .where((q) => q.whereNot('s.status', 'failed').orWhereNotNull('s.external_ref'))
      .select('s.item', 'a.name as api')) as Array<{ item: string; api: string | null }>
    for (const r of rows) {
      const id = ids.find((x) => sameId(x, r.item))
      if (!id) continue
      const e = out.get(id) ?? { sent: 0, partners: new Set<string>() }
      e.sent++
      if (r.api) e.partners.add(String(r.api))
      out.set(id, e)
    }
  } catch {
    /* no submissions table here */
  }
  return out
}

/** Open tasks and pending approvals per record (shown on the record headers). */
async function attachedCounts(collection: string, ids: string[]) {
  const openTasks: Record<string, number> = {}
  const openApprovals: Record<string, number> = {}
  const bump = (m: Record<string, number>, raw: unknown) => {
    const id = ids.find((x) => sameId(x, raw))
    if (id) m[id] = (m[id] ?? 0) + 1
  }
  await Promise.all([
    db('nivaro_tasks')
      .where({ collection })
      .whereIn('item', ids)
      .whereIn('status', ['open', 'in_progress'])
      .select('item')
      .then((rows) => {
        for (const r of rows as Array<{ item: string }>) bump(openTasks, r.item)
      })
      .catch(() => undefined),
    db('nivaro_approval_instances')
      .where({ collection, status: 'pending' })
      .whereIn('item', ids)
      .select('item')
      .then((rows) => {
        for (const r of rows as Array<{ item: string }>) bump(openApprovals, r.item)
      })
      .catch(() => undefined)
  ])
  return { openTasks, openApprovals }
}

/** Why the caller may not keep (survive) / discard this record; null = they may. */
export async function recordVerdicts(
  req: FastifyRequest,
  collection: string,
  id: string,
  plural: string,
  mayDelete: boolean,
  isAdmin: boolean
): Promise<{ survive: string | null; discard: string | null }> {
  const { recordWriteRefusal } = await import('../edit-lock.js')
  let survive: string | null = null
  try {
    const refused = await recordWriteRefusal(req, collection, id)
    if (refused)
      survive =
        refused.status === 404
          ? 'You cannot see this record.'
          : String(refused.body.error || 'You cannot change this record.')
  } catch {
    survive = 'Could not confirm you may change this record. Try again.'
  }
  let discard: string | null = null
  if (!mayDelete) discard = `You cannot delete ${plural}, so you cannot discard this one.`
  else if (survive) discard = survive
  else {
    try {
      const { assertDeletableByPerson } = await import('../delete-in-flight.js')
      await assertDeletableByPerson(collection, id, isAdmin)
    } catch (err) {
      discard = (err as Error)?.message || 'This record cannot be deleted.'
    }
  }
  return { survive, discard }
}

/**
 * What the merge dialog may say about one inbound relation's rows. Pure. Only
 * administrators get counts of rows the caller cannot see (raw tables, hidden
 * rows): a non-admin gets their visible counts and a reason without numbers, so
 * the plan never tells them how many hidden rows point at a record.
 */
export function judgeRelationCounts(input: {
  raw: boolean
  isAdmin: boolean
  /** Every row, as counted in the table. */
  counts: Record<string, number>
  /** Rows the caller can read. */
  visible: Record<string, number>
  /** The caller may change the relation field on that collection. */
  mayUpdate: boolean
}): {
  counts: Record<string, number>
  hidden: Record<string, number>
  movable: boolean
  reason: string | null
} {
  const { raw, isAdmin, counts, visible, mayUpdate } = input
  const tooMany = `More than ${MOVE_ROW_CAP} on one record — too many to move in one merge.`
  if (raw) {
    if (!isAdmin)
      return {
        counts: {},
        hidden: {},
        movable: false,
        reason: 'Only an administrator can move these (the table is not set up as a list).'
      }
    const big = Object.values(counts).some((n) => n > MOVE_ROW_CAP)
    return { counts: { ...counts }, hidden: {}, movable: !big, reason: big ? tooMany : null }
  }
  const hiddenAll: Record<string, number> = {}
  for (const [id, n] of Object.entries(counts)) {
    const h = n - (visible[id] ?? 0)
    if (h > 0) hiddenAll[id] = h
  }
  const anyHidden = Object.keys(hiddenAll).length > 0
  const hidden = isAdmin ? hiddenAll : {}
  const shown = { ...visible }
  if (!mayUpdate)
    return {
      counts: shown,
      hidden,
      movable: false,
      reason: 'You cannot change these, so they stay where they are.'
    }
  if (anyHidden) {
    const n = Object.values(hiddenAll).reduce((x, y) => x + y, 0)
    return {
      counts: shown,
      hidden,
      movable: false,
      reason: isAdmin
        ? `${n} of them you cannot see, so they cannot be moved by you.`
        : 'Some of them you cannot see, so they cannot be moved by you. Ask an administrator.'
    }
  }
  if (Object.values(shown).some((n) => n > MOVE_ROW_CAP))
    return { counts: shown, hidden, movable: false, reason: tooMany }
  return { counts: shown, hidden, movable: true, reason: null }
}

export async function buildMergePlan(
  req: FastifyRequest,
  collection: string,
  rawIds: unknown,
  opts: { draft?: boolean } = {}
): Promise<MergePlan> {
  const user = req.user as User
  const { noun, plural, allowed, friendlyField } = await mergeCollection(collection)
  if (!allowed)
    throw new MergeRefusal(
      403,
      'MERGE_OFF',
      `Merging is turned off for ${plural}. An administrator can turn it on in the Data Model.`
    )
  const ids = parseIds(rawIds)
  // A create form's unsaved record (the duplicate notice) is the second column: one id.
  if (ids.length < (opts.draft ? 1 : 2))
    throw new MergeRefusal(400, 'MERGE_IDS', 'Pick at least two records to merge.')
  if (ids.length > MAX_MERGE_RECORDS)
    throw new MergeRefusal(400, 'MERGE_IDS', `Merge at most ${MAX_MERGE_RECORDS} records at once.`)
  const isAdmin = req.isAdmin === true || (await isAdminRole(user).catch(() => false))

  const readAt = new Date().toISOString()
  const rows = await readRecords(user, collection, ids, req)
  const byId = new Map<string, Record<string, unknown>>()
  for (const id of ids) {
    const row = rows.find((r) => sameId(r.id, id))
    if (!row)
      throw new MergeRefusal(
        404,
        'NOT_FOUND',
        'One of these records is gone, or you cannot see it.',
        id
      )
    byId.set(id, row)
  }

  // ── Fields ──
  const [fields, relations, allowedRead, allowedUpdate, mayDelete] = await Promise.all([
    getFields(collection),
    getRelations(collection).catch(() => []),
    getAllowedFields(user, 'read', collection).catch((): string[] => []),
    getAllowedFields(user, 'update', collection).catch((): string[] => []),
    can(user, 'delete', collection).catch(() => false)
  ])
  const aliases = new Set<string>()
  const m2oTarget = new Map<string, string>()
  for (const r of relations as Array<Record<string, string | null>>) {
    if (r.one_collection === collection && r.one_field) aliases.add(String(r.one_field))
    if (r.many_collection === collection && r.many_field && r.one_collection && !r.junction_field)
      m2oTarget.set(String(r.many_field), String(r.one_collection))
  }
  const first = byId.get(ids[0]) ?? {}
  // Records that look alike are told apart by number and created date.
  const createdField =
    fields.find((f) => (f.special ?? []).includes('date-created') && f.field in first)?.field ??
    ['date_created', 'created_at', 'created'].find((f) => f in first) ??
    null
  const refOf = (id: string, row: Record<string, unknown>) => {
    const v = friendlyField ? row[friendlyField] : null
    return v != null && v !== '' && typeof v !== 'object' ? String(v) : `#${id}`
  }
  const createdOf = (row: Record<string, unknown>) => {
    const v = createdField ? row[createdField] : null
    if (v == null || v === '') return null
    const d = v instanceof Date ? v : new Date(String(v))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const planFields: MergePlanField[] = []
  for (const f of fields) {
    if (f.hidden) continue
    if (!isMergeField(f as never, aliases)) continue
    if (!readable(allowedRead, f.field) || !(f.field in first)) continue
    const opts = (f.options ?? {}) as { choices?: unknown }
    const choices = Array.isArray(opts.choices)
      ? (opts.choices as Array<Record<string, unknown>>)
          .filter((c) => c && typeof c === 'object')
          .map((c) => ({ value: c.value, text: String(c.text ?? c.value ?? '') }))
      : null
    planFields.push({
      field: f.field,
      label: fieldTitle(f.field, f as { name?: string | null }),
      type: String(f.type ?? ''),
      interface: f.interface ?? null,
      writable: !f.readonly && readable(allowedUpdate, f.field),
      relation: m2oTarget.get(f.field) ?? null,
      choices
    })
  }

  // Labels for link values, read as the caller.
  const { recordLabelsAsViewer } = await import('../record-labels-as-viewer.js')
  const refs: Array<{ collection: string; id: string }> = ids.map((id) => ({ collection, id }))
  for (const f of planFields) {
    if (!f.relation) continue
    for (const row of byId.values()) {
      const v = row[f.field]
      const id = v && typeof v === 'object' ? (v as { id?: unknown }).id : v
      if (id != null && id !== '') refs.push({ collection: f.relation, id: String(id) })
    }
  }
  const labelMap = await recordLabelsAsViewer(user, refs).catch(
    () => ({}) as Record<string, string>
  )
  const labels: Record<string, Record<string, string>> = {}
  for (const f of planFields) {
    if (!f.relation) continue
    const m: Record<string, string> = {}
    for (const row of byId.values()) {
      const v = row[f.field]
      const id = v && typeof v === 'object' ? (v as { id?: unknown }).id : v
      if (id == null || id === '') continue
      m[String(id)] = labelMap[`${f.relation}:${String(id)}`] ?? String(id)
    }
    labels[f.field] = m
  }

  // ── Records ──
  const [partners, attached] = await Promise.all([
    partnerSends(collection, ids),
    attachedCounts(collection, ids)
  ])
  const records: MergePlanRecord[] = []
  for (const id of ids) {
    const row = byId.get(id) as Record<string, unknown>
    const verdict = await recordVerdicts(req, collection, id, plural, mayDelete, isAdmin)
    const sent = partners.get(id)
    let partner: MergePlanRecord['partner'] = null
    let discardReason = verdict.discard
    if (sent) {
      const names = [...sent.partners]
      const who = names.length ? names.join(', ') : 'a partner'
      partner = {
        sent: sent.sent,
        partners: names,
        warning: `This record was sent to ${who}. Discarding it leaves ${names.length === 1 ? 'that partner' : 'them'} holding an id for a record that is gone.`
      }
      if (!isAdmin && !discardReason)
        discardReason = `This record was sent to ${who} — only an administrator can discard it.`
    }
    const st = row.$state as { key?: string; label?: string; color?: string | null } | null
    const values: Record<string, unknown> = {}
    for (const f of planFields) values[f.field] = row[f.field] ?? null
    records.push({
      id,
      label: labelMap[`${collection}:${id}`] ?? id,
      stamp: recordStamp(row),
      ref: refOf(id, row),
      created_at: createdOf(row),
      values,
      state: st?.key
        ? { key: st.key, label: String(st.label ?? st.key), color: st.color ?? null }
        : null,
      can_survive: !verdict.survive,
      survive_reason: verdict.survive,
      can_discard: !discardReason,
      discard_reason: discardReason,
      partner,
      open_tasks: attached.openTasks[id] ?? 0,
      open_approvals: attached.openApprovals[id] ?? 0
    })
  }

  // ── Relations ──
  const inbound = await liveInbound(collection)
  const titles = new Map<string, string>()
  {
    const names = (await db('nivaro_collections')
      .whereIn('collection', [...new Set(inbound.map((r) => r.collection))].slice(0, 500))
      .select('collection', 'display_name')
      .catch(() => [])) as Array<{ collection: string; display_name: string | null }>
    for (const n of names) if (n.display_name) titles.set(n.collection, n.display_name)
  }
  const planRelations: MergePlanRelation[] = []
  for (const r of inbound) {
    let counts: Record<string, number>
    try {
      counts = await rawCounts(r.collection, r.field, ids, String(user.id))
    } catch {
      continue
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (total === 0) continue
    const visible: Record<string, number> = {}
    let mayUpdate = isAdmin
    if (!r.raw) {
      try {
        const rowsSeen = await visibleRows(
          user,
          r.collection,
          r.field,
          ids,
          req,
          MOVE_ROW_CAP * ids.length + 1
        )
        for (const row of rowsSeen) {
          const id = ids.find((x) => sameId(x, row[r.field]))
          if (id) visible[id] = (visible[id] ?? 0) + 1
        }
      } catch {
        /* the caller cannot read this collection at all: everything is hidden */
      }
      const [mayUpd, upd] = await Promise.all([
        can(user, 'update', r.collection).catch(() => false),
        getAllowedFields(user, 'update', r.collection).catch((): string[] => [])
      ])
      mayUpdate = !!mayUpd && readable(upd, r.field)
    }
    const judged = judgeRelationCounts({ raw: !!r.raw, isAdmin, counts, visible, mayUpdate })
    const [move_word, leave_word] = MOVE_WORDS[r.kind]
    planRelations.push({
      key: r.key,
      kind: r.kind,
      label: relationLabel(r, titles),
      collection: r.collection,
      field: r.field,
      counts: judged.counts,
      hidden: judged.hidden,
      movable: judged.movable,
      reason: judged.reason,
      default: judged.movable ? 'move' : 'leave',
      move_word,
      leave_word
    })
  }
  const attachedLabels: Record<MergeAttachedKind, string> = {
    comments: 'Comments',
    tasks: 'Tasks',
    record_links: 'Related records'
  }
  // Comments, tasks, related-record links: only rows this person may see and manage move;
  // the rest stay with the discarded record (attached.ts — the merge judges them again).
  const { attachedRows } = await import('./attached.js')
  for (const kind of ATTACHED_KINDS) {
    const rows = await attachedRows(req, kind, collection, ids).catch(() => [])
    if (rows.length === 0) continue
    const counts: Record<string, number> = {}
    const hidden: Record<string, number> = {}
    for (const r of rows) {
      const m = r.movable ? counts : hidden
      m[r.item] = (m[r.item] ?? 0) + 1
    }
    const nHidden = Object.values(hidden).reduce((a, b) => a + b, 0)
    const nMovable = rows.length - nHidden
    const [move_word, leave_word] = MOVE_WORDS[kind]
    planRelations.push({
      key: kind,
      kind,
      label: attachedLabels[kind],
      collection:
        kind === 'comments'
          ? 'nivaro_comments'
          : kind === 'tasks'
            ? 'nivaro_tasks'
            : 'nivaro_record_links',
      field: 'item',
      counts,
      hidden,
      movable: nMovable > 0,
      reason:
        nHidden === 0
          ? null
          : nMovable === 0
            ? HIDDEN_ALL[kind]
            : `${nHidden} of them ${HIDDEN_SOME[kind]} — ${nHidden === 1 ? 'it stays' : 'they stay'} with the discarded record.`,
      default: nMovable > 0 ? 'move' : 'leave',
      move_word,
      leave_word
    })
  }

  return {
    collection,
    noun,
    plural,
    is_admin: isAdmin,
    records,
    fields: planFields,
    relations: planRelations,
    labels,
    undo_hours: UNDO_WINDOW_MS / 3_600_000,
    max_records: MAX_MERGE_RECORDS,
    read_at: readAt
  }
}
