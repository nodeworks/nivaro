import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { selectInChunks } from './db-batch.js'

/**
 * One notice for a bulk change to your records (rt5, 2026-11-14).
 *
 * When someone else's bulk update, bulk move or import touches several records you own or
 * created, you get ONE notification — "Beth updated 12 of your records (Amount, Status)" —
 * that opens a list of exactly those records, never one notification per record.
 *
 * How it works (no migration):
 *  - logActivity() calls `noteBulkWrite` for every `update` / `pipeline-transition` row that
 *    carries a bulk or import burst key (services/activity-scope.ts: `bulk:`, `import:`,
 *    `import_job:`, `import_run:`). Flows, cron ticks and MCP calls are not bulk bursts.
 *  - A burst is flushed when it has been quiet for IDLE_MS (a request ends, an import
 *    finishes) — or after MAX_HOLD_MS, so a very long import still says something.
 *  - At flush each record's recipients are its creator (`user_created`) and its current
 *    pipeline owners, minus the person who did it. A recipient needs `bulkNoticeMin()` of
 *    their records in the burst (default 5) — fewer stay silent, as they always were.
 *  - Everything is re-read AS THE RECIPIENT: records they cannot see are not counted or
 *    linked, field names they cannot read are not named.
 *  - People with a collection-wide subscription on that collection are skipped: their own
 *    rule already tells them (hooks/notification-subscriptions.ts).
 *  - The notice goes through notifyUser, so the recipient's notification rules, mutes,
 *    quiet hours, role defaults and channel choices apply live, at send time. It is an FYI
 *    in the "Watched records" category and never folds (it names no single record).
 *
 * In-memory per process: a bulk request or import runs in one process, so its burst does
 * too. Losing a pending notice on restart is the accepted cost of a courtesy message.
 */

export const IDLE_MS = 4_000
export const MAX_HOLD_MS = 15 * 60_000
const MAX_IDS_PER_COLLECTION = 5_000
const MAX_BURSTS = 200
/** Most record ids the link carries (the target query is capped at 500 characters). */
const LINK_QUERY_MAX = 460

/** How many of a person's records one burst must touch before they hear about it. */
export function bulkNoticeMin(): number {
  const n = Math.floor(Number(process.env.BULK_NOTICE_MIN))
  return Number.isFinite(n) && n >= 1 ? n : 5
}

/** Pure: does this burst key belong to a bulk action or an import? */
export function isNoticeBurst(groupKey: string | null | undefined): boolean {
  return !!groupKey && /^(bulk|import|import_job|import_run):/.test(groupKey)
}

/** Audit stamps move on every write; they are not what the person means by "changed". */
const STAMP_FIELDS = new Set([
  'updated_at',
  'date_updated',
  'user_updated',
  'changed',
  'modified_at',
  'id'
])

/** Pure: the field names worth naming (stamps, internals and children left out). */
export function noticeFields(fields: Iterable<string>): string[] {
  const out: string[] = []
  for (const f of fields) {
    if (!f || STAMP_FIELDS.has(f) || f.startsWith('_') || f.startsWith('$')) continue
    out.push(f)
  }
  return out
}

/** Pure: "Amount, Status" / "Amount, Status, Zone, +2 more". */
export function fieldPhrase(labels: string[], show = 3): string {
  if (labels.length === 0) return ''
  const head = labels.slice(0, show).join(', ')
  return labels.length > show ? `${head}, +${labels.length - show} more` : head
}

/** Pure: the notification's subject and message. */
export function bulkNoticeText(opts: {
  actor: string | null
  count: number
  /** "workflow" — the collection's singular word, lower-case; blank for a plain "records". */
  word: string
  fieldLabels: string[]
  /** Records beyond the ones the link carries. */
  more?: number
}): { subject: string; message: string } {
  const who = opts.actor?.trim() || 'Someone'
  const what = fieldPhrase(opts.fieldLabels)
  const recs = opts.count === 1 ? 'record' : 'records'
  const subject = `${who} updated ${opts.count} of your ${recs}${what ? ` (${what})` : ''}`
  const kind = opts.word ? ` ${opts.word}` : ''
  const message = `${who} changed ${opts.count} of your${kind} ${recs}${
    what ? `: ${what}` : ''
  }. See what changed.`
  return { subject: subject.slice(0, 255), message: message.slice(0, 500) }
}

/** Pure: the `ids=` query that opens the collection list on exactly these records. */
export function idsQuery(ids: string[]): { query: string; carried: number } {
  const kept: string[] = []
  let len = 'ids='.length
  for (const id of ids) {
    const add = encodeURIComponent(id).length + (kept.length ? 1 : 0)
    if (len + add > LINK_QUERY_MAX) break
    kept.push(id)
    len += add
  }
  return {
    query: kept.length ? `ids=${kept.map((i) => encodeURIComponent(i)).join(',')}` : '',
    carried: kept.length
  }
}

// ── The collector ──────────────────────────────────────────────────────────

interface Touch {
  ids: Set<string>
  fields: Set<string>
}

interface Burst {
  key: string
  actor: string | null
  touches: Map<string, Touch>
  timer: ReturnType<typeof setTimeout> | null
  firstAt: number
}

const bursts = new Map<string, Burst>()

/** A write that belongs to a bulk action or import. Cheap; no I/O. */
export function noteBulkWrite(w: {
  groupKey: string | null | undefined
  action: string
  user: string | null | undefined
  collection: string | null | undefined
  item: string | null | undefined
  fields?: string[]
}): void {
  if (!isNoticeBurst(w.groupKey) || !w.collection || w.item == null || w.item === '') return
  if (w.action !== 'update' && w.action !== 'pipeline-transition') return
  if (/^(nivaro_|directus_|__)/i.test(w.collection)) return
  const key = String(w.groupKey)
  let burst = bursts.get(key)
  if (!burst) {
    if (bursts.size >= MAX_BURSTS) return
    burst = { key, actor: w.user ?? null, touches: new Map(), timer: null, firstAt: Date.now() }
    bursts.set(key, burst)
  }
  let t = burst.touches.get(w.collection)
  if (!t) {
    t = { ids: new Set(), fields: new Set() }
    burst.touches.set(w.collection, t)
  }
  if (t.ids.size < MAX_IDS_PER_COLLECTION) t.ids.add(String(w.item))
  // A move says "Step"; an update says the fields it changed.
  if (w.action === 'pipeline-transition') t.fields.add('__step')
  else for (const f of noticeFields(w.fields ?? [])) t.fields.add(f)
  schedule(burst)
}

function schedule(burst: Burst): void {
  if (burst.timer) clearTimeout(burst.timer)
  const held = Date.now() - burst.firstAt
  const wait = held >= MAX_HOLD_MS ? 0 : IDLE_MS
  burst.timer = setTimeout(() => {
    void flushBulkNotices(burst.key)
  }, wait)
  burst.timer.unref?.()
}

/** Settle one burst now: send what it owes. Never throws. Exported for tests + shutdown. */
export async function flushBulkNotices(key: string, deps: FlushDeps = realDeps): Promise<number> {
  const burst = bursts.get(key)
  if (!burst) return 0
  bursts.delete(key)
  if (burst.timer) clearTimeout(burst.timer)
  let sent = 0
  try {
    for (const [collection, touch] of burst.touches) {
      sent += await noticeCollection(burst.actor, collection, touch, deps)
    }
  } catch {
    /* a courtesy notice never breaks the write that caused it */
  }
  return sent
}

/** Drop every pending burst (tests). */
export function resetBulkNotices(): void {
  for (const b of bursts.values()) if (b.timer) clearTimeout(b.timer)
  bursts.clear()
}

// ── Who is told, and what they may see ─────────────────────────────────────

export interface FlushDeps {
  /** record id → creator user id */
  creators(collection: string, ids: string[]): Promise<Map<string, string>>
  /** record id → current owners */
  owners(collection: string, ids: string[]): Promise<Map<string, Set<string>>>
  /** Has an active collection-wide subscription on this collection. */
  subscribed(userId: string, collection: string): Promise<boolean>
  /** The recipient's own view: which of these records they may read, which fields, labels. */
  view(
    userId: string,
    collection: string,
    ids: string[]
  ): Promise<{ ids: string[]; fields: string[] | null } | null>
  fieldLabels(collection: string, fields: string[]): Promise<string[]>
  actorName(userId: string | null): Promise<string | null>
  word(collection: string): Promise<string>
  send(
    userId: string,
    n: {
      subject: string
      message: string
      collection: string
      query: string
      why: string
      senderId: string | null
    }
  ): Promise<void>
}

/** Pure: recipient → their records, from the two relationships, the actor left out. */
export function recipientsOf(
  creators: Map<string, string>,
  owners: Map<string, Set<string>>,
  actor: string | null
): Map<string, { ids: Set<string>; created: boolean; owned: boolean }> {
  const out = new Map<string, { ids: Set<string>; created: boolean; owned: boolean }>()
  const slot = (u: string) => {
    let s = out.get(u)
    if (!s) {
      s = { ids: new Set(), created: false, owned: false }
      out.set(u, s)
    }
    return s
  }
  const me = actor ? actor.toLowerCase() : null
  for (const [id, u] of creators) {
    if (!u || u.toLowerCase() === me) continue
    const s = slot(u)
    s.ids.add(id)
    s.created = true
  }
  for (const [id, set] of owners) {
    for (const u of set) {
      if (!u || u.toLowerCase() === me) continue
      const s = slot(u)
      s.ids.add(id)
      s.owned = true
    }
  }
  return out
}

/** Pure: why the person is told. */
export function whyText(created: boolean, owned: boolean): string {
  if (created && owned) return 'You created or own these records.'
  return created ? 'You created these records.' : 'You own these records.'
}

async function noticeCollection(
  actor: string | null,
  collection: string,
  touch: Touch,
  deps: FlushDeps
): Promise<number> {
  const min = bulkNoticeMin()
  if (touch.ids.size < min) return 0
  const ids = [...touch.ids]
  const [creators, owners] = await Promise.all([
    deps.creators(collection, ids).catch(() => new Map<string, string>()),
    deps.owners(collection, ids).catch(() => new Map<string, Set<string>>())
  ])
  const recipients = recipientsOf(creators, owners, actor)
  const name = await deps.actorName(actor).catch(() => null)
  const word = (await deps.word(collection).catch(() => '')).toLowerCase()
  let sent = 0
  for (const [userId, mine] of recipients) {
    if (mine.ids.size < min) continue
    if (await deps.subscribed(userId, collection).catch(() => false)) continue
    // As the recipient: records they cannot read are not counted, fields they cannot read
    // are not named — the notice tells them nothing they could not open themselves.
    const view = await deps.view(userId, collection, [...mine.ids]).catch(() => null)
    if (!view || view.ids.length < min) continue
    const changed = noticeFields(touch.fields).filter(
      (f) => view.fields === null || view.fields.includes(f)
    )
    const labels = [
      ...(touch.fields.has('__step') ? ['Step'] : []),
      ...(await deps.fieldLabels(collection, changed).catch(() => changed))
    ]
    const text = bulkNoticeText({ actor: name, count: view.ids.length, word, fieldLabels: labels })
    const q = idsQuery(view.ids)
    await deps
      .send(userId, {
        ...text,
        collection,
        query: q.query,
        why: whyText(mine.created, mine.owned),
        senderId: actor
      })
      .then(() => {
        sent++
      })
      .catch(() => {})
  }
  return sent
}

// ── The real dependencies (dynamic imports keep activity.ts free of import cycles) ─────────

const CHUNK = 500

const realDeps: FlushDeps = {
  async creators(collection, ids) {
    const out = new Map<string, string>()
    if (!(await hasColumn(collection, 'user_created'))) return out
    const rows = (await selectInChunks(ids, CHUNK, (chunk) =>
      db(collection).whereIn('id', chunk).whereNotNull('user_created').select('id', 'user_created')
    )) as Array<{ id: string | number; user_created: string }>
    for (const r of rows) out.set(String(r.id), String(r.user_created))
    return out
  },
  async owners(collection, ids) {
    const out = new Map<string, Set<string>>()
    const rows = (await selectInChunks(ids, CHUNK, (chunk) =>
      db('nivaro_workflow_instances as i')
        .join('nivaro_pipeline_instance_owners as o', 'o.instance', 'i.id')
        .where('i.collection', collection)
        .whereIn('i.item', chunk)
        .where((qb) => qb.whereRaw('o.state = i.current_state').orWhereNull('o.state'))
        .select('i.item', 'o.user')
    )) as Array<{ item: string; user: string }>
    for (const r of rows) {
      const set = out.get(String(r.item)) ?? new Set<string>()
      set.add(String(r.user))
      out.set(String(r.item), set)
    }
    return out
  },
  async subscribed(userId, collection) {
    const { isCollectionWideSubscription } = await import('../hooks/notification-subscriptions.js')
    const rows = (await db('nivaro_notification_subscriptions')
      .where({ user: userId, collection, is_active: true })
      .whereIn('event_type', ['update', 'all'])
      .select('filter_field', 'filters')) as Array<{
      filter_field?: string | null
      filters?: unknown
    }>
    return rows.some((r) => isCollectionWideSubscription(r))
  },
  async view(userId, collection, ids) {
    const { getUser } = await import('./users.js')
    const user = await getUser(userId)
    if (!user) return null
    const { getAllowedFields } = await import('./permissions.js')
    const { readItems } = await import('./items.js')
    const visible: string[] = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const res = await readItems(user, collection, {
        fields: ['id'],
        filter: { id: { _in: chunk } },
        limit: chunk.length
      })
      for (const r of (res.data ?? []) as Array<{ id: string | number }>) visible.push(String(r.id))
    }
    const fields = await getAllowedFields(user, 'read', collection).catch(() => [] as string[])
    return { ids: visible, fields }
  },
  async fieldLabels(collection, fields) {
    if (fields.length === 0) return []
    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereIn('field', fields.slice(0, 50))
      .select('field', 'label')) as Array<{ field: string; label: string | null }>
    const byField = new Map(rows.map((r) => [r.field, r.label?.trim() || null]))
    const { fallbackFieldLabel } = await import('./seat-labels.js')
    return fields.map((f) => byField.get(f) ?? fallbackFieldLabel(f))
  },
  async actorName(userId) {
    if (!userId) return null
    const { getUser } = await import('./users.js')
    const u = await getUser(userId)
    if (!u) return null
    return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null
  },
  async word(collection) {
    const { collectionWord } = await import('./event-path/record-labels.js')
    return collectionWord(collection)
  },
  async send(userId, n) {
    const { pulseApp } = await import('./activity.js')
    const app = pulseApp()
    if (!app) return
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, userId, {
      subject: n.subject,
      message: n.message,
      collection: n.collection,
      item: null,
      sender: n.senderId,
      category: 'watch',
      lane: 'fyi',
      why: n.why,
      target: { kind: 'record', collection: n.collection, query: n.query || null, action: 'open' },
      source: { kind: 'bulk_change', label: 'Bulk change to your records' }
    })
  }
}
