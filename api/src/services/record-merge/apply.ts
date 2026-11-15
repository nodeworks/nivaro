/**
 * Merge records — apply and undo (POST /api/record-merge/:collection/apply, POST
 * /api/record-merge/undo/:mergeId).
 *
 * Everything is judged first and written after: the plan (as the caller) says whether
 * each record may survive or be discarded and whether each relation may move; the
 * survivor's new values are rehearsed through the items service. Only then does the merge
 * write, in this order — survivor fields, relation moves (items service, one row at a time,
 * so permissions, edit locks, revisions and activity apply to every row), comments /
 * tasks / related-record links, open approvals, discarded records (items-service delete:
 * trash, restorable), notes on every record, the undo log.
 *
 * The items service has no shared transaction, so "one transaction" is a unit of work with
 * compensation: every write is logged as it happens, and a failure part-way runs the same
 * undo over what was done, drops the unit's outbound effects (webhooks, flows, live events)
 * and refuses with the plain reason — nothing half-merged stays behind. The same log is
 * the 24-hour Undo.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { type AttachedRow, attachedRows } from './attached.js'
import { buildMergePlan, liveInbound, type MergePlan, MergeRefusal, parseIds } from './plan.js'
import {
  emptyUndoLog,
  type InboundRelation,
  listWords,
  MAX_MERGE_RECORDS,
  type MergeAttachedKind,
  type MergeUndoLog,
  MOVE_ROW_CAP,
  type MoveChoice,
  sameMergeValue,
  survivorPatch,
  UNDO_WINDOW_MS,
  undoRefusal
} from './rules.js'
import { claimUndo, loadUndoLog, releaseUndo, saveUndoLog } from './store.js'

export interface MergeBody {
  survivor?: unknown
  discard?: unknown
  keep?: unknown
  values?: Record<string, unknown> | null
  relations?: Record<string, MoveChoice> | null
  /** Each record's `stamp` from the plan the person merged from: a record changed since
   *  then refuses the merge (409 MERGE_STALE) so they review it again. */
  stamps?: Record<string, string> | null
  /** When that plan was read (ISO): who changed a record since is named in the refusal. */
  opened_at?: string | null
}

export interface MergeResult {
  merge_id: string
  survivor: string
  discarded: string[]
  kept: string[]
  fields_changed: string[]
  moved: number
  undo_until: string
}

export interface UndoResult {
  merge_id: string
  restored: string[]
  /** Survivor fields someone changed after the merge: left as they are now. */
  kept_fields: string[]
  problems: string[]
}

type Row = Record<string, unknown>

/** The writes a merge makes — the real ones by default, fakes in tests. */
export interface MergeDeps {
  plan(req: FastifyRequest, collection: string, ids: string[]): Promise<MergePlan>
  inbound(collection: string): Promise<InboundRelation[]>
  /** Rehearse the survivor's patch: null = it would save, else the reason it would not. */
  rehearse(req: FastifyRequest, collection: string, id: string, patch: Row): Promise<string | null>
  /** Rows of a relation pointing at these ids (as the caller; raw = every row). */
  rows(req: FastifyRequest, r: InboundRelation, ids: string[]): Promise<Row[]>
  update(req: FastifyRequest, collection: string, id: string, patch: Row): Promise<void>
  remove(req: FastifyRequest, collection: string, id: string): Promise<void>
  rawSet(table: string, field: string, id: string, value: string): Promise<void>
  read(req: FastifyRequest, collection: string, id: string): Promise<Row | null>
  /** Put a record deleted since `since` back from the trash. */
  restore(req: FastifyRequest, collection: string, id: string, since: string): Promise<void>
  /** Comments / tasks / related-record links on these records, each judged for this person
   *  (attached.ts). Only `movable` rows are moved; the rest stay where they are. */
  attached(
    req: FastifyRequest,
    kind: MergeAttachedKind,
    collection: string,
    ids: string[]
  ): Promise<AttachedRow[]>
  /** Who last changed this record after `since` (a name), for the stale refusal. */
  changedBy(collection: string, id: string, since: string | null): Promise<string | null>
  moveComments(rows: AttachedRow[], to: string): Promise<Array<{ id: string; from: string }>>
  setCommentItem(id: string, item: string): Promise<void>
  moveTasks(
    rows: AttachedRow[],
    to: string,
    actor: string,
    note: string
  ): Promise<Array<{ id: number; from: string }>>
  setTaskItem(id: number, item: string): Promise<void>
  closeTasks(collection: string, from: string[], actor: string, note: string): Promise<number[]>
  reopenTasks(ids: number[], actor: string): Promise<void>
  moveRecordLinks(
    rows: AttachedRow[],
    to: string
  ): Promise<Array<{ id: number; side: 'from' | 'to'; from: string }>>
  setRecordLink(id: number, side: 'from' | 'to', item: string): Promise<void>
  cancelApprovals(collection: string, from: string[]): Promise<Array<{ id: number; from: string }>>
  setApprovalStatus(id: number, status: string): Promise<void>
  note(
    req: FastifyRequest,
    collection: string,
    id: string,
    action: string,
    text: string
  ): Promise<number | null>
  saveLog(log: MergeUndoLog, activityId: number | null): Promise<void>
  loadLog(mergeId: string): Promise<MergeUndoLog | null>
  /** Atomically claim the undo; false = already undone (or another undo won the race). */
  claimUndo(log: MergeUndoLog, userId: string): Promise<boolean>
  /** Hand a claim back when the undo failed. */
  releaseUndo(log: MergeUndoLog): Promise<void>
  /** Wrap the writes (a unit of work: effects released only when it returns). */
  unit<T>(fn: (discard: () => void) => Promise<T>): Promise<T>
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

const reasonOf = async (err: unknown): Promise<string> => {
  if (err instanceof MergeRefusal) return err.message
  const e = err as { statusCode?: number; message?: string }
  if (typeof e?.statusCode === 'number' && e.statusCode < 500 && e.message) return e.message
  try {
    const { describeWriteRefusal } = await import('../items.js')
    const d = describeWriteRefusal(err)
    if (d.status < 500 && d.error) return String(d.error)
  } catch {
    /* fall through */
  }
  return 'Something went wrong on the server.'
}

function refuse(status: number, message: string, record?: string): never {
  throw new MergeRefusal(status, 'MERGE_REFUSED', message, record)
}

/** Every write of the log, reversed. Never throws: problems are returned. */
export async function runUndo(
  req: FastifyRequest,
  log: MergeUndoLog,
  deps: MergeDeps
): Promise<{ restored: string[]; kept_fields: string[]; problems: string[] }> {
  const problems: string[] = []
  const restored: string[] = []
  const label = (id: string) => log.labels[id] ?? id
  const actor = String(req.user?.id ?? '')
  const tryStep = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      problems.push(`${what}: ${await reasonOf(err)}`)
    }
  }
  // 1. The discarded records come back from the trash (their ids and history with them).
  for (const id of [...log.deleted].reverse())
    await tryStep(`Could not restore ${label(id)}`, async () => {
      await deps.restore(req, log.collection, id, log.at)
      restored.push(id)
    })
  // 2. Junction rows dropped as duplicates come back too.
  for (const j of log.junction_deleted)
    await tryStep('Could not put back a link', () => deps.restore(req, j.collection, j.id, log.at))
  // 3. Rows that moved point back at the record they came from.
  for (const m of [...log.moved].reverse())
    await tryStep(`Could not move a ${m.collection.replace(/_/g, ' ')} row back`, () =>
      m.raw
        ? deps.rawSet(m.collection, m.field, m.id, m.from)
        : deps.update(req, m.collection, m.id, { [m.field]: m.from })
    )
  for (const c of log.comments)
    await tryStep('Could not move a comment back', () => deps.setCommentItem(c.id, c.from))
  for (const t of log.tasks_moved)
    await tryStep('Could not move a task back', () => deps.setTaskItem(t.id, t.from))
  if (log.tasks_closed.length)
    await tryStep('Could not reopen tasks', () => deps.reopenTasks(log.tasks_closed, actor))
  for (const l of log.record_links)
    await tryStep('Could not move a related-record link back', () =>
      deps.setRecordLink(l.id, l.side, l.from)
    )
  for (const a of log.approvals)
    await tryStep('Could not reopen an approval', () => deps.setApprovalStatus(a.id, a.from))
  // 4. The survivor's fields go back — unless someone changed them since.
  const kept_fields: string[] = []
  const fields = Object.keys(log.after)
  if (fields.length) {
    await tryStep(`Could not put back the fields of ${label(log.survivor)}`, async () => {
      const now = (await deps.read(req, log.collection, log.survivor)) ?? {}
      const back: Row = {}
      for (const f of fields) {
        if (f in now && !sameMergeValue(now[f], log.after[f])) kept_fields.push(f)
        else back[f] = log.before[f] ?? null
      }
      if (Object.keys(back).length) await deps.update(req, log.collection, log.survivor, back)
    })
  }
  return { restored, kept_fields, problems }
}

export async function applyMerge(
  req: FastifyRequest,
  collection: string,
  body: MergeBody,
  deps: MergeDeps = defaultMergeDeps
): Promise<MergeResult> {
  const user = req.user as User
  const survivor = parseIds([body.survivor])[0]
  if (!survivor) refuse(400, 'Choose the record to keep.')
  const discard = parseIds(body.discard).filter((x) => !sameId(x, survivor))
  const keep = parseIds(body.keep).filter(
    (x) => !sameId(x, survivor) && !discard.some((d) => sameId(d, x))
  )
  if (discard.length === 0) refuse(400, 'Choose at least one record to discard.')
  const all = [survivor, ...discard, ...keep]
  if (all.length > MAX_MERGE_RECORDS)
    refuse(400, `Merge at most ${MAX_MERGE_RECORDS} records at once.`)

  // ── Judge everything first ──
  const plan = await deps.plan(req, collection, all)
  const rec = (id: string) => plan.records.find((r) => sameId(r.id, id))
  // A record that changed since the person opened the merge: they review it again first.
  if (body.stamps && typeof body.stamps === 'object') {
    for (const r of plan.records) {
      const sent = Object.entries(body.stamps).find(([id]) => sameId(id, r.id))?.[1]
      if (sent == null || sent === r.stamp) continue
      const opened = typeof body.opened_at === 'string' ? body.opened_at : null
      const who = await deps.changedBy(collection, r.id, opened).catch(() => null)
      throw new MergeRefusal(
        409,
        'MERGE_STALE',
        `${who ?? 'Someone'} changed ${r.ref ?? r.label}${r.ref && r.ref !== r.label ? ` (${r.label})` : ''} while you were merging — review it again.`,
        r.id,
        who
      )
    }
  }
  const s = rec(survivor)
  if (!s) refuse(404, 'The record to keep is gone, or you cannot see it.')
  if (!s.can_survive) refuse(403, `You cannot keep ${s.label}: ${s.survive_reason}`, s.id)
  for (const id of discard) {
    const r = rec(id)
    if (!r) refuse(404, 'One of these records is gone, or you cannot see it.', id)
    if (!r.can_discard) refuse(403, `You cannot discard ${r.label}: ${r.discard_reason}`, r.id)
  }
  const mergeFields = new Set(plan.fields.map((f) => f.field))
  const writable = new Set(plan.fields.filter((f) => f.writable).map((f) => f.field))
  const verdict = survivorPatch(s.values, body.values, mergeFields, writable)
  if (verdict.refused.length) {
    const names = verdict.refused.map((f) => plan.fields.find((x) => x.field === f)?.label ?? f)
    refuse(
      403,
      `You cannot change ${listWords(names)}, so ${names.length === 1 ? 'it keeps' : 'they keep'} the kept record’s value.`
    )
  }
  const choices = new Map<string, MoveChoice>()
  for (const rel of plan.relations) {
    const onDiscarded = discard.reduce(
      (n, id) => n + (rel.counts[id] ?? 0) + (rel.hidden[id] ?? 0),
      0
    )
    if (onDiscarded === 0) continue
    const want =
      body.relations?.[rel.key] === 'leave'
        ? 'leave'
        : body.relations?.[rel.key] === 'move'
          ? 'move'
          : rel.default
    if (want === 'move' && !rel.movable) refuse(403, `${rel.label}: ${rel.reason}`)
    choices.set(rel.key, want)
  }
  if (Object.keys(verdict.patch).length) {
    const why = await deps.rehearse(req, collection, survivor, verdict.patch)
    if (why) refuse(422, `The kept record would not save: ${why}`, survivor)
  }

  // ── Write, logging every step ──
  const log = emptyUndoLog({
    merge_id: randomUUID(),
    collection,
    survivor,
    discarded: discard,
    kept: keep,
    user: String(user.id)
  })
  for (const r of plan.records) log.labels[r.id] = r.label
  const survivorLabel = s.label
  const discardLabels = discard.map((id) => rec(id)?.label ?? id)
  const note = `Merged into ${survivorLabel}`
  const inbound = await deps.inbound(collection)

  return deps.unit(async (discardEffects) => {
    try {
      // Survivor fields.
      if (Object.keys(verdict.patch).length) {
        for (const f of Object.keys(verdict.patch)) log.before[f] = s.values[f] ?? null
        await deps.update(req, collection, survivor, verdict.patch)
        log.after = { ...verdict.patch }
      }
      // Relations.
      for (const r of inbound) {
        if (choices.get(r.key) !== 'move') continue
        const rows = await deps.rows(req, r, discard)
        if (rows.length > MOVE_ROW_CAP * discard.length)
          refuse(409, `${r.collection.replace(/_/g, ' ')}: too many rows to move in one merge.`)
        // m2m / files: the pairs the kept record already has (a second one is dropped).
        const pairs: unknown[] =
          r.other_field && !r.raw
            ? (await deps.rows(req, r, [survivor])).map((x) => x[r.other_field as string])
            : []
        for (const row of rows) {
          const rowId = String(row.id ?? '')
          if (!rowId) continue
          // A record of this collection pointing at another merged record: a self-link
          // would point the survivor at itself.
          if (r.collection === collection && all.some((x) => sameId(x, rowId))) continue
          const from = String(row[r.field] ?? '')
          if (r.other_field && !r.raw) {
            const other = row[r.other_field]
            if (pairs.some((p) => sameMergeValue(p, other))) {
              await deps.remove(req, r.collection, rowId)
              log.junction_deleted.push({ collection: r.collection, id: rowId })
              continue
            }
          }
          if (r.other_field) pairs.push(row[r.other_field])
          if (r.raw) await deps.rawSet(r.collection, r.field, rowId, survivor)
          else await deps.update(req, r.collection, rowId, { [r.field]: survivor })
          log.moved.push({
            collection: r.collection,
            field: r.field,
            id: rowId,
            from,
            ...(r.raw ? { raw: true } : {})
          })
        }
      }
      const actor = String(user.id)
      // Attached rows are judged again here (never trusted from the plan): only rows this
      // person may see and manage move; the rest stay with the discarded record.
      const movable = async (kind: MergeAttachedKind) =>
        (await deps.attached(req, kind, collection, discard)).filter(
          (r) =>
            r.movable &&
            // A link between two of the merged records would point the survivor at itself.
            !(
              r.other &&
              r.other.collection === collection &&
              all.some((x) => sameId(x, r.other?.item))
            )
        )
      if (choices.get('comments') === 'move')
        log.comments = await deps.moveComments(await movable('comments'), survivor)
      if (choices.get('tasks') === 'move')
        log.tasks_moved = await deps.moveTasks(
          await movable('tasks'),
          survivor,
          actor,
          `Moved here — the record was merged into ${survivorLabel}`
        )
      log.tasks_closed = await deps.closeTasks(
        collection,
        discard,
        actor,
        `Closed — the record was merged into ${survivorLabel}`
      )
      if (choices.get('record_links') === 'move')
        log.record_links = await deps.moveRecordLinks(await movable('record_links'), survivor)
      log.approvals = await deps.cancelApprovals(collection, discard)
      // Discarded records: the items-service delete (trash, restorable).
      for (const id of discard) {
        await deps.remove(req, collection, id)
        log.deleted.push(id)
      }
      // Notes on every record.
      const activityId = await deps.note(
        req,
        collection,
        survivor,
        'record-merge',
        `Merged ${listWords(discardLabels)} into this record${log.moved.length ? ` (${log.moved.length} linked row${log.moved.length === 1 ? '' : 's'} moved here)` : ''}`
      )
      for (const id of discard) await deps.note(req, collection, id, 'record-merged-into', note)
      await deps.saveLog(log, activityId)
    } catch (err) {
      const said = await reasonOf(err)
      const reason = /[.!?]$/.test(said) ? said : `${said}.`
      const back = await runUndo(req, log, deps)
      discardEffects()
      const tail = back.problems.length
        ? ` Some of it could not be put back: ${back.problems.slice(0, 3).join('; ')}.`
        : ' Nothing was merged.'
      throw new MergeRefusal(
        err instanceof MergeRefusal ? err.statusCode : 409,
        'MERGE_FAILED',
        `${reason}${tail}`
      )
    }
    return {
      merge_id: log.merge_id,
      survivor,
      discarded: discard,
      kept: keep,
      fields_changed: Object.keys(log.after),
      moved:
        log.moved.length + log.comments.length + log.tasks_moved.length + log.record_links.length,
      undo_until: new Date(Date.parse(log.at) + UNDO_WINDOW_MS).toISOString()
    }
  })
}

export async function undoMerge(
  req: FastifyRequest,
  mergeId: string,
  deps: MergeDeps = defaultMergeDeps
): Promise<UndoResult> {
  const user = req.user as User
  const log = await deps.loadLog(mergeId)
  const { isAdminRole } = await import('../permissions.js')
  const isAdmin = req.isAdmin === true || (await isAdminRole(user).catch(() => false))
  const why = undoRefusal(log, { id: String(user.id), isAdmin })
  if (why || !log) throw new MergeRefusal(log ? 409 : 404, 'UNDO_REFUSED', why ?? 'Not found.')
  // Claim first, so an undo can only ever run once (two clicks, two tabs, two people).
  if (!(await deps.claimUndo(log, String(user.id))))
    throw new MergeRefusal(409, 'UNDO_REFUSED', 'This merge was already undone.')
  let back: Awaited<ReturnType<typeof runUndo>>
  try {
    back = await deps.unit(() => runUndo(req, log, deps))
  } catch (err) {
    await deps.releaseUndo(log).catch(() => undefined)
    throw err
  }
  const label = (id: string) => log.labels[id] ?? id
  await deps
    .note(
      req,
      log.collection,
      log.survivor,
      'record-merge-undo',
      `Undid the merge of ${listWords(log.discarded.map(label))} into this record`
    )
    .catch(() => null)
  for (const id of back.restored)
    await deps
      .note(
        req,
        log.collection,
        id,
        'record-merge-undo',
        `Merge into ${label(log.survivor)} undone`
      )
      .catch(() => null)
  return { merge_id: log.merge_id, ...back }
}

// ─── The real writes ────────────────────────────────────────────────────────

const ws = (req: FastifyRequest) => req.workspaceId ?? undefined

export const defaultMergeDeps: MergeDeps = {
  plan: (req, collection, ids) => buildMergePlan(req, collection, ids),
  inbound: (collection) => liveInbound(collection),
  async rehearse(req, collection, id, patch) {
    const { rehearseUpdate } = await import('../items.js')
    const r = (await rehearseUpdate(req.user as User, collection, id, patch, req, ws(req))) as {
      ok?: boolean
      error?: string
    }
    return r.ok === false ? String(r.error ?? 'it was refused') : null
  },
  async rows(req, r, ids) {
    const fields = ['id', r.field, ...(r.other_field ? [r.other_field] : [])]
    if (r.raw) {
      return (await db(r.collection)
        .whereIn(r.field, ids)
        .select(fields)
        .limit(MOVE_ROW_CAP * ids.length + 1)) as Row[]
    }
    const { readItems } = await import('../items.js')
    const res = (await readItems(
      req.user as User,
      r.collection,
      {
        filter: { [r.field]: { _in: ids } },
        fields,
        limit: MOVE_ROW_CAP * ids.length + 1,
        count: false
      },
      req,
      ws(req)
    )) as { data?: Row[] }
    return (res.data ?? []).map((row) => {
      // The items service may expand a link into an object: keep the id.
      const out: Row = { ...row }
      for (const f of fields) {
        const v = out[f]
        if (v && typeof v === 'object' && !Array.isArray(v) && 'id' in v) out[f] = (v as Row).id
      }
      return out
    })
  },
  async update(req, collection, id, patch) {
    const { updateOne } = await import('../items.js')
    await updateOne(req.user as User, collection, id, { ...patch }, req, ws(req), {
      callerPayload: true
    })
  },
  async remove(req, collection, id) {
    const { deleteOne } = await import('../items.js')
    await deleteOne(req.user as User, collection, id, req, ws(req))
  },
  async rawSet(table, field, id, value) {
    await db(table)
      .where({ id })
      .update({ [field]: value })
  },
  async read(req, collection, id) {
    const { readOne } = await import('../items.js')
    return ((await readOne(req.user as User, collection, id, ws(req))) as Row | null) ?? null
  },
  async restore(req, collection, id, since) {
    // deleteOne writes its trash row without waiting: give a just-deleted one a moment.
    let row: { id: number } | undefined
    for (let i = 0; i < 10 && !row; i++) {
      row = (await db('nivaro_trash')
        .where({ collection, item_id: String(id) })
        .where('deleted_at', '>=', new Date(Date.parse(since) - 5_000))
        .orderBy('id', 'desc')
        .first('id')) as { id: number } | undefined
      if (!row) await new Promise((r) => setTimeout(r, 150))
    }
    if (!row) throw new MergeRefusal(404, 'NOT_IN_TRASH', 'It is no longer in the trash.')
    const { restoreTrashRow } = await import('../trash.js')
    await restoreTrashRow(req.user as User, row.id, req)
  },
  attached: (req, kind, collection, ids) => attachedRows(req, kind, collection, ids),
  async changedBy(collection, id, since) {
    const q = db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where({ 'a.collection': collection, 'a.item': String(id) })
      .whereIn('a.action', ['update', 'create', 'delete', 'restore', 'record-merge'])
      .orderBy('a.id', 'desc')
      .first('u.first_name', 'u.last_name')
    if (since && !Number.isNaN(Date.parse(since))) q.where('a.timestamp', '>=', new Date(since))
    const row = (await q) as { first_name?: string | null; last_name?: string | null } | undefined
    const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim()
    return name || null
  },
  async moveComments(rows, to) {
    if (rows.length)
      await db('nivaro_comments')
        .whereIn(
          'id',
          rows.map((r) => r.id)
        )
        .whereNull('deleted_at')
        .update({ item: to })
    return rows.map((r) => ({ id: r.id, from: r.item }))
  },
  async setCommentItem(id, item) {
    await db('nivaro_comments').where({ id }).update({ item })
  },
  async moveTasks(rows, to, actor, note) {
    if (rows.length) {
      await db('nivaro_tasks')
        .whereIn(
          'id',
          rows.map((r) => Number(r.id))
        )
        .update({ item: to, updated_at: new Date() })
      const { logTaskEvent } = await import('../tasks.js')
      for (const r of rows) await logTaskEvent(Number(r.id), actor, note)
    }
    return rows.map((r) => ({ id: Number(r.id), from: r.item }))
  },
  async setTaskItem(id, item) {
    await db('nivaro_tasks').where({ id }).update({ item, updated_at: new Date() })
  },
  async closeTasks(collection, from, actor, note) {
    // `record-deleted`: a restore from the trash opens them again (tasks.ts onRecordRestored).
    const rows = (await db('nivaro_tasks')
      .where({ collection })
      .whereIn('item', from)
      .whereIn('status', ['open', 'in_progress'])
      .select('id')) as Array<{ id: number }>
    if (!rows.length) return []
    const ids = rows.map((r) => Number(r.id))
    await db('nivaro_tasks')
      .whereIn('id', ids)
      .update({ status: 'cancelled', auto_closed: 'record-deleted', updated_at: new Date() })
    const { logTaskEvent } = await import('../tasks.js')
    for (const id of ids) await logTaskEvent(id, actor, note)
    return ids
  },
  async reopenTasks(ids, actor) {
    const open = (await db('nivaro_tasks')
      .whereIn('id', ids)
      .where({ status: 'cancelled', auto_closed: 'record-deleted' })
      .select('id')) as Array<{ id: number }>
    if (!open.length) return
    await db('nivaro_tasks')
      .whereIn(
        'id',
        open.map((r) => r.id)
      )
      .update({ status: 'open', auto_closed: null, updated_at: new Date() })
    const { logTaskEvent } = await import('../tasks.js')
    for (const r of open) await logTaskEvent(r.id, actor, 'Reopened — the merge was undone')
  },
  async moveRecordLinks(rows, to) {
    const out: Array<{ id: number; side: 'from' | 'to'; from: string }> = []
    for (const r of rows) {
      const side = r.side ?? 'from'
      try {
        await db('nivaro_record_links')
          .where({ id: Number(r.id) })
          .update({ [`${side}_item`]: to })
        out.push({ id: Number(r.id), side, from: r.item })
      } catch {
        /* the kept record already has this link: the duplicate stays with the discarded one */
      }
    }
    return out
  },
  async setRecordLink(id, side, item) {
    await db('nivaro_record_links')
      .where({ id })
      .update({ [`${side}_item`]: item })
  },
  async cancelApprovals(collection, from) {
    const rows = (await db('nivaro_approval_instances')
      .where({ collection, status: 'pending' })
      .whereIn('item', from)
      .select('id', 'status')
      .catch(() => [])) as Array<{ id: number; status: string }>
    if (rows.length)
      await db('nivaro_approval_instances')
        .whereIn(
          'id',
          rows.map((r) => r.id)
        )
        .update({ status: 'cancelled' })
    return rows.map((r) => ({ id: Number(r.id), from: String(r.status) }))
  },
  async setApprovalStatus(id, status) {
    await db('nivaro_approval_instances').where({ id }).update({ status })
  },
  async note(req, collection, id, action, text) {
    const { logActivity } = await import('../activity.js')
    return logActivity({
      action,
      user: req.user?.id ?? null,
      collection,
      item: String(id),
      comment: text,
      req
    })
  },
  saveLog: (log, activityId) => saveUndoLog(log, activityId),
  loadLog: (id) => loadUndoLog(id),
  claimUndo: (log, userId) => claimUndo(log.merge_id, userId),
  releaseUndo: (log) => releaseUndo(log),
  async unit(fn) {
    const { runUnit } = await import('../unit-of-work.js')
    return runUnit('record-merge', (unit) => fn(() => unit.discard()))
  }
}
