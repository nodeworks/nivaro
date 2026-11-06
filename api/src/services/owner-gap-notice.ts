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
    const already = await db('nivaro_notifications')
      .where({ collection: args.subjectCollection, item: String(args.subjectItem) })
      .where('subject', subject)
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
