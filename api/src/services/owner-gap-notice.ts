import { db } from '../db/index.js'

/**
 * A record that lands in a step nobody can act on must not wait in silence
 * (army 5, 2026-11-06: IR CM26INV-37394 sat in Engineering Review "waiting on"
 * its requester — the queue-only creator fallback — and no approver was ever
 * told). When a transition (or an instance start) enters such a step:
 *
 *  - the owner-gap audience (every active administrator, supportAudience) gets
 *    ONE in-app notice per record and step, in Needs you;
 *  - the record's creator is told no approver is set yet and that an
 *    administrator has been told.
 *
 * "Nobody can act" = no ACTIVE assigned owner (resolved with skipFallback,
 * suspended / redacted left out — the caller passes that set) on a step that
 * needs owners: not initial, not terminal, not flagged owners-not-required,
 * and with no manual way out the creator may take (allow_creator) — an IR at
 * Warehouse Submission is the requester's own move, not a stall.
 *
 * Deduplicated on the notification row itself (collection + item + subject,
 * the indexed pair), so a retried transition or a second replica never tells
 * anyone twice. Best-effort: never throws, never blocks a transition.
 */

export interface GapStateRow {
  id: string
  label?: string | null
  key?: string | null
  template?: string | null
  is_initial?: boolean | number | null
  is_terminal?: boolean | number | null
  owners_not_required?: boolean | number | null
}

export interface GapTransitionRow {
  from_state: string | null
  allow_creator?: boolean | number | null
  auto_trigger?: boolean | number | null
}

const on = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()

/** Pure: can a record parked in `state` stall for want of an owner? */
export function isStallProne(state: GapStateRow, transitions: GapTransitionRow[]): boolean {
  if (on(state.is_initial) || on(state.is_terminal) || on(state.owners_not_required)) return false
  const creatorWayOut = transitions.some(
    (t) =>
      t.from_state != null &&
      sameId(t.from_state, state.id) &&
      !on(t.auto_trigger) &&
      on(t.allow_creator)
  )
  return !creatorWayOut
}

/**
 * Pure: is a record parked in `state` the REQUESTER's move (army 6 M44)? A
 * step past the start, not terminal, whose only manual way out the creator
 * may take (allow_creator) — an IR at Warehouse Submission with no WS owner
 * group: nobody else is assigned, the requester submits it. Only judged when
 * the step has no active assigned owner (the caller checks that).
 */
export function creatorActsIn(state: GapStateRow, transitions: GapTransitionRow[]): boolean {
  if (on(state.is_initial) || on(state.is_terminal)) return false
  return transitions.some(
    (t) =>
      t.from_state != null &&
      sameId(t.from_state, state.id) &&
      !on(t.auto_trigger) &&
      on(t.allow_creator)
  )
}

/** Does the creator act in this state (template transitions read here)? */
export async function creatorActsInState(state: GapStateRow): Promise<boolean> {
  if (!state.template || on(state.is_initial) || on(state.is_terminal)) return false
  try {
    return creatorActsIn(state, await templateTransitions(String(state.template)))
  } catch {
    return false
  }
}

export interface Requester {
  id: string
  name: string
  /** Lower-cased. */
  email: string | null
  /** When the record was created (ISO), when the row says. */
  created_at: string | null
}

/** Pure: the creator uuid + created date off a record row (`creator` on
 *  workflows, `user_created` on Directus-era tables). */
export function creatorOfRow(
  row: Record<string, unknown> | null | undefined
): { id: string; created_at: string | null } | null {
  const id = [row?.creator, row?.user_created].find(
    (v): v is string => typeof v === 'string' && v.length > 20
  )
  if (!id) return null
  const raw = [row?.date_created, row?.created, row?.created_at].find((v) => v != null && v !== '')
  const t = raw != null ? new Date(raw as string | Date) : null
  return { id, created_at: t && Number.isFinite(t.getTime()) ? t.toISOString() : null }
}

/** The record's creator as a person who can act: null when unknown, or
 *  suspended / redacted. Best-effort. */
export async function recordRequester(
  collection: string,
  item: string | number
): Promise<Requester | null> {
  try {
    const row = (await db(collection).where({ id: item }).first()) as
      | Record<string, unknown>
      | undefined
    const c = creatorOfRow(row)
    if (!c) return null
    const u = (await db('nivaro_users')
      .where({ id: c.id })
      .first('id', 'first_name', 'last_name', 'email', 'status', 'is_redacted')) as
      | {
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
          status: string | null
          is_redacted: boolean | number | null
        }
      | undefined
    if (!u) return null
    const { isInactivePerson } = await import('./pipeline-engine.js')
    if (isInactivePerson(u)) return null
    return {
      id: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'the requester',
      email: u.email ? u.email.toLowerCase() : null,
      created_at: c.created_at
    }
  } catch {
    return null
  }
}

async function templateTransitions(templateId: string): Promise<GapTransitionRow[]> {
  return (await db('nivaro_workflow_transitions')
    .where({ template: templateId })
    .select('from_state', 'allow_creator', 'auto_trigger')) as GapTransitionRow[]
}

/** The template's stall-prone states (upper-cased ids) — the mail chain marks
 *  a current step there with no acting owner as "no approver set yet". */
export async function stalledStates(states: GapStateRow[]): Promise<Set<string>> {
  const templateId = states.find((s) => s.template)?.template
  if (!templateId) return new Set()
  const transitions = await templateTransitions(String(templateId))
  return new Set(
    states.filter((s) => isStallProne(s, transitions)).map((s) => String(s.id).toUpperCase())
  )
}

/** Subject of the administrators' notice — also the dedupe key. */
export function gapSubject(friendlyId: string, stateLabel: string): string {
  return `No approver: ${friendlyId} in ${stateLabel}`.slice(0, 255)
}

/** Subject of the creator's notice. */
export function creatorGapSubject(friendlyId: string, stateLabel: string): string {
  return `No approver yet: ${friendlyId} in ${stateLabel}`.slice(0, 255)
}

/** Pure: the administrators' message. `dims` = "Zone 3 / PNR / Commercial". */
export function gapMessage(friendlyId: string, stateLabel: string, dims: string | null): string {
  return (
    `${friendlyId} is waiting in ${stateLabel} and nobody owns that step` +
    `${dims ? ` for ${dims}` : ' for this record'}. ` +
    'Add an owner group for it (or assign an owner on the record) so someone can approve it.'
  ).slice(0, 500)
}

export function creatorGapMessage(friendlyId: string, stateLabel: string): string {
  return (
    `${friendlyId} is waiting in ${stateLabel}. No approver is set for this step yet, ` +
    'an administrator has been told.'
  ).slice(0, 500)
}

/** "Zone 3 / PNR / Commercial" — the record's values on the pipeline's owner
 *  dimensions, as the matrix shows them. Best-effort; null when unknown. */
async function dimensionWords(collection: string, itemId: string): Promise<string | null> {
  try {
    const dims = (await db('nivaro_pipeline_owner_dimensions as d')
      .join('nivaro_workflow_bindings as b', 'b.id', 'd.binding')
      .where('b.collection', collection)
      .orderBy('d.sort')
      .select('d.field')) as Array<{ field: string }>
    if (dims.length === 0) return null
    const record = (await db(collection).where({ id: itemId }).first()) as
      | Record<string, unknown>
      | undefined
    if (!record) return null
    const fields = [...new Set(dims.map((d) => d.field))]
    const dotted = fields.filter((f) => f.includes('.'))
    const { resolveFilterValues } = await import('./pipeline-engine.js')
    const resolved = dotted.length
      ? ((await resolveFilterValues(collection, new Map([[itemId, record]]), dotted, db)).get(
          itemId
        ) ?? new Map())
      : new Map()
    const words: string[] = []
    for (const f of fields) {
      if (f.includes('.')) {
        const v = resolved.get(f) as { display?: unknown } | undefined
        const d = v?.display instanceof Set ? [...v.display] : v?.display != null ? [v.display] : []
        if (d.length) words.push(d.map(String).join(', '))
      } else {
        const v = record[f]
        if (v != null && v !== '' && typeof v !== 'object') words.push(String(v))
      }
    }
    return words.length ? words.join(' / ') : null
  } catch {
    return null
  }
}

/** Keys being told right now in this process (a burst of the same move). */
const inFlight = new Set<string>()

export async function noticeOwnerGap(args: {
  state: GapStateRow
  /** ACTIVE assigned owners of the entered state (skipFallback). */
  actingOwners: Array<{ id: string }>
  friendlyId: string
  /** The subject record (an addendum's parent) — where the notice links. */
  subjectCollection: string
  subjectItem: string
}): Promise<{ told: number } | null> {
  const { state } = args
  if (args.actingOwners.length > 0) return null
  const key = `${args.subjectCollection}:${String(args.subjectItem).toUpperCase()}:${String(state.id).toUpperCase()}`
  if (inFlight.has(key)) return null
  inFlight.add(key)
  try {
    if (!state.template) return null
    if (!isStallProne(state, await templateTransitions(String(state.template)))) return null
    const label = state.label || state.key || 'this step'
    const subject = gapSubject(args.friendlyId, label)
    // An OPEN notice dedupes; one retired because the record moved on
    // (retireGapNotices) does not — a record sent back into the gap is new news.
    const already = await db('nivaro_notifications')
      .where({ collection: args.subjectCollection, item: String(args.subjectItem) })
      .where('subject', subject)
      .whereNot('status', 'archived')
      .first('id')
    if (already) return { told: 0 }

    const [{ supportAudience }, { notifyUser }, { getApp, getIo }] = await Promise.all([
      import('./support-tickets.js'),
      import('./notification-channels.js'),
      import('./io-holder.js')
    ])
    const app = (getApp() ?? { io: getIo() ?? undefined }) as Parameters<typeof notifyUser>[0]
    const audience = await supportAudience(null)
    const dims = await dimensionWords(args.subjectCollection, String(args.subjectItem))
    let told = 0
    for (const uid of audience) {
      try {
        await notifyUser(app, uid, {
          subject,
          message: gapMessage(args.friendlyId, label, dims),
          collection: args.subjectCollection,
          item: String(args.subjectItem),
          category: 'workflow',
          always_inbox: true,
          ack_required: true,
          why: 'You are an administrator, and nobody can approve this step for this record.',
          channels: { inapp: true, email: false }
        })
        told++
      } catch {
        /* one recipient failing never stops the rest */
      }
    }

    // The creator: told once that it is waiting on nobody yet.
    try {
      const rec = (await db(args.subjectCollection).where({ id: args.subjectItem }).first()) as
        | Record<string, unknown>
        | undefined
      const creator = [rec?.creator, rec?.user_created].find(
        (v): v is string => typeof v === 'string' && v.length > 20
      )
      if (creator && !audience.some((a) => sameId(a, creator))) {
        await notifyUser(app, creator, {
          subject: creatorGapSubject(args.friendlyId, label),
          message: creatorGapMessage(args.friendlyId, label),
          collection: args.subjectCollection,
          item: String(args.subjectItem),
          category: 'workflow',
          always_inbox: true,
          why: 'You created this record.',
          channels: { inapp: true, email: false }
        })
      }
    } catch {
      /* the creator line is a courtesy */
    }
    return { told }
  } catch {
    return null
  } finally {
    inFlight.delete(key)
  }
}

/** Pure: is this subject an owner-gap notice about `friendlyId` — and not
 *  about the step it waits in now (`currentLabel`)? */
export function isStaleGapSubject(
  subject: string | null | undefined,
  friendlyId: string,
  currentLabel: string | null
): boolean {
  const s = String(subject ?? '')
  if (!friendlyId) return false
  const about =
    s.startsWith(`No approver: ${friendlyId} in `) ||
    s.startsWith(`No approver yet: ${friendlyId} in `)
  if (!about) return false
  if (!currentLabel) return true
  return (
    s !== gapSubject(friendlyId, currentLabel) && s !== creatorGapSubject(friendlyId, currentLabel)
  )
}

/**
 * The record moved on from a step nobody owned (army 6 L31: the admins' "No
 * approver: CM26INV-37423 in Engineering Review" stayed in Needs you,
 * ack_required, while the IR sat at Warehouse Submission). Archive the open
 * notices about any OTHER step — administrators' and the creator's — and tell
 * open bells. Best-effort; returns how many rows were retired.
 */
export async function retireGapNotices(opts: {
  collection: string
  item: string
  friendlyId: string
  /** Label of the state the record is in NOW (its notices stay). */
  currentLabel: string | null
}): Promise<number> {
  if (!opts.friendlyId) return 0
  try {
    const rows = (
      (await db('nivaro_notifications')
        .where({ collection: opts.collection, item: String(opts.item) })
        .where('subject', 'like', 'No approver%')
        .whereNot('status', 'archived')
        .select('id', 'recipient', 'subject')
        .limit(500)) as Array<{ id: number; recipient: string; subject: string | null }>
    ).filter((r) => isStaleGapSubject(r.subject, opts.friendlyId, opts.currentLabel))
    if (rows.length === 0) return 0
    const ids = rows.map((r) => Number(r.id))
    await db('nivaro_notifications').whereIn('id', ids).update({ status: 'archived' })
    await db('nivaro_notifications')
      .whereIn('id', ids)
      .whereNull('read_at')
      .update({ read_at: new Date() })
      .catch(() => {})
    try {
      const { getIo } = await import('./io-holder.js')
      const io = getIo()
      const byRecipient = new Map<string, { recipient: string; ids: number[] }>()
      for (const r of rows) {
        const key = String(r.recipient).toUpperCase()
        const cur = byRecipient.get(key) ?? { recipient: r.recipient, ids: [] }
        cur.ids.push(Number(r.id))
        byRecipient.set(key, cur)
      }
      for (const { recipient, ids: rowIds } of byRecipient.values())
        io?.to(`user:${recipient}`).emit('notification:retired', {
          ids: rowIds,
          collection: opts.collection,
          item: String(opts.item)
        })
    } catch {
      /* live refresh is a courtesy */
    }
    return rows.length
  } catch {
    return 0
  }
}
