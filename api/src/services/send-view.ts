import { randomUUID } from 'node:crypto'
import type { NotificationTargetSpec } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import type { User } from '../types.js'
import { canUserReadQueue } from './queue-access.js'
import { collectionTitle } from './record-label-fallback.js'

/**
 * "Send my view to Beth" — a person hands a colleague the screen they are looking at: a
 * record, a list or a queue worklist, with the list's view settings (the same `lv` envelope
 * "Copy link" uses: filters, sort, columns — settings, never rows). The recipient opens it AS
 * THEMSELVES: their own read access decides what the list shows, and a record they cannot
 * read shows the normal no-access page.
 *
 * What travels and what is stored (24 h, Redis; this process alone without Redis):
 *   ids + view settings + the sender's own short words (a filter summary, an optional note).
 *   NEVER a record's field values. The title the recipient sees ("Workflows — CM26-1")
 *   is resolved when THEY read it, as them — a record they cannot read gets the
 *   collection's name only, never a hint of its label.
 *
 * Delivery: when the recipient has the app open they get `view:sent {id}` on their own user
 * room (a poke — no content) and their tab fetches GET /send-view/:id, which marks it
 * delivered. If no tab of theirs fetched it within FALLBACK_MS (app closed, an older build,
 * a phone) it lands as a normal notification in the 'views' category, which they can mute.
 */

export type SentViewKind = 'record' | 'list' | 'queue'

export interface SentView {
  kind: SentViewKind
  collection: string | null
  item: string | null
  queue: string | null
  /** The list's `lv` envelope (base64url) — view settings only. */
  lv: string | null
  /** A record tab to open on (`tab=`). */
  tab: string | null
  /** The sender's words for the filters ("Region NER, PUB'd"). */
  summary: string | null
}

export interface StoredSentView {
  id: string
  from: { id: string; name: string }
  to: string
  view: SentView
  note: string | null
  at: string
  delivered: boolean
  /** The recipient chose "Later": it was put in their notifications (once). */
  kept?: boolean
}

export const SEND_VIEW_TTL_S = 24 * 3600
export const FALLBACK_MS = 8000
/** Per sender: a burst of a few, then a steady trickle. */
export const SEND_VIEW_PER_MINUTE = 6
export const SEND_VIEW_PER_HOUR = 40

const COLLECTION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const LV = /^[A-Za-z0-9_-]{1,7000}$/
const TAB = /^[A-Za-z0-9_-]{1,40}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]+/g

/** Plain one-line text: control characters out, whitespace folded, capped. */
export function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (!v) return null
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

/** Validate what a client says it is looking at. A string = why it was refused. */
export function cleanSentView(input: unknown): SentView | string {
  if (!input || typeof input !== 'object') return 'view is required'
  const v = input as Record<string, unknown>
  const kind = v.kind
  if (kind !== 'record' && kind !== 'list' && kind !== 'queue') return 'view.kind is not valid'
  const str = (x: unknown) => (x == null || x === '' ? null : String(x))
  const collection = str(v.collection)
  const item = str(v.item)
  const queue = str(v.queue)
  const lv = str(v.lv)
  const tab = str(v.tab)
  if (lv && !LV.test(lv)) return 'view.lv is not valid'
  if (tab && !TAB.test(tab)) return 'view.tab is not valid'
  const summary = cleanLine(v.summary, 160)
  if (kind === 'queue') {
    if (!queue || !ID.test(queue)) return 'view.queue is required'
    return { kind, collection: null, item: null, queue, lv, tab: null, summary }
  }
  if (!collection || !COLLECTION.test(collection) || /^(nivaro|directus)_/i.test(collection))
    return 'view.collection is not valid'
  if (kind === 'list') return { kind, collection, item: null, queue: null, lv, tab: null, summary }
  if (!item || !ID.test(item)) return 'view.item is required'
  return { kind, collection, item, queue: null, lv: null, tab, summary: null }
}

/** Where a click takes the recipient — the notification target spec every app resolves. */
export function sentViewTarget(view: SentView): NotificationTargetSpec {
  const lv = view.lv ? `lv=${view.lv}` : null
  if (view.kind === 'queue') return { kind: 'queue', id: view.queue, query: lv, action: 'open' }
  if (view.kind === 'list')
    return { kind: 'record', collection: view.collection, query: lv, action: 'open' }
  return {
    kind: 'record',
    collection: view.collection,
    id: view.item,
    tab: view.tab,
    action: 'open'
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface SendViewRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
  get(key: string): Promise<string | null>
}

const memory = new Map<string, { value: StoredSentView; until: number }>()

function storeKey(id: string): string {
  return `nvr:sentview:${getTenantId() ?? ''}:${id}`
}

export async function saveSentView(
  redis: SendViewRedis | null | undefined,
  row: StoredSentView
): Promise<void> {
  const key = storeKey(row.id)
  try {
    if (!redis) throw new Error('no redis')
    await redis.set(key, JSON.stringify(row), 'EX', SEND_VIEW_TTL_S)
  } catch {
    if (memory.size > 2000) memory.clear()
    memory.set(key, { value: row, until: Date.now() + SEND_VIEW_TTL_S * 1000 })
  }
}

export async function loadSentView(
  redis: SendViewRedis | null | undefined,
  id: string
): Promise<StoredSentView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const key = storeKey(id)
  const hit = memory.get(key)
  if (hit && hit.until > Date.now()) return hit.value
  try {
    if (!redis) return null
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as StoredSentView) : null
  } catch {
    return null
  }
}

/** Tests only. */
export function resetSentViewMemory(): void {
  memory.clear()
}

export function newSentView(
  from: { id: string; name: string },
  to: string,
  view: SentView,
  note: string | null,
  now = new Date()
): StoredSentView {
  return { id: randomUUID(), from, to, view, note, at: now.toISOString(), delivered: false }
}

// ── What the recipient reads ────────────────────────────────────────────────

export interface SentViewForRecipient {
  id: string
  from: { id: string; name: string }
  kind: SentViewKind
  /** "Workflows — CM26-1" / "Workflows" / "Approvals queue" — resolved as the recipient. */
  title: string
  summary: string | null
  note: string | null
  at: string
  target: NotificationTargetSpec
}

export interface RecipientDeps {
  collectionName(collection: string): Promise<string>
  /** The record's label read AS THE RECIPIENT (the collection's name when they cannot read it). */
  recordLabel(user: User, collection: string, id: string): Promise<string | null>
  queue(id: string): Promise<{
    name: string
    owner?: string | null
    is_shared?: unknown
    role_id?: string | null
  } | null>
  isAdmin(user: User): Promise<boolean>
}

export const defaultRecipientDeps: RecipientDeps = {
  async collectionName(collection) {
    const row = (await db('nivaro_collections')
      .where({ collection })
      .first('display_name')
      .catch(() => null)) as { display_name?: string | null } | null | undefined
    return collectionTitle(collection, row?.display_name ?? null)
  },
  async recordLabel(user, collection, id) {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    const labels = await recordLabelsAsViewer(user, [{ collection, id }])
    return labels[`${collection}:${id}`] ?? null
  },
  async queue(id) {
    try {
      return ((await db('nivaro_queues')
        .where({ id })
        .first('name', 'owner', 'is_shared', 'role_id')) ?? null) as never
    } catch {
      return null
    }
  },
  async isAdmin(user) {
    if (!user.role) return false
    const role = (await db('nivaro_roles').where({ id: user.role }).first('admin_access')) as
      | { admin_access?: boolean | number }
      | undefined
    return !!role?.admin_access
  }
}

/** The sent view as the recipient may see it — everything resolved with their access. */
export async function describeForRecipient(
  row: StoredSentView,
  recipient: User,
  deps: RecipientDeps = defaultRecipientDeps
): Promise<SentViewForRecipient> {
  const v = row.view
  let title: string
  if (v.kind === 'queue') {
    const q = v.queue ? await deps.queue(v.queue) : null
    const may =
      q &&
      canUserReadQueue(
        { owner: q.owner, is_shared: q.is_shared as never, role_id: q.role_id ?? null },
        recipient,
        await deps.isAdmin(recipient)
      )
    title = may && q?.name ? `${q.name} queue` : 'A queue'
  } else {
    const name = await deps.collectionName(String(v.collection))
    if (v.kind === 'list') title = name
    else {
      const label = await deps.recordLabel(recipient, String(v.collection), String(v.item))
      // recordLabelsAsViewer answers the collection's name for a record they cannot read.
      title = label && label !== name ? `${name} — ${label}` : `${name} record`
    }
  }
  return {
    id: row.id,
    from: row.from,
    kind: v.kind,
    title,
    summary: v.summary,
    note: row.note,
    at: row.at,
    target: sentViewTarget(v)
  }
}

/** "Rob sent you: Workflows — Region NER" — the one line both the card and the notification use. */
export function sentViewLine(d: Pick<SentViewForRecipient, 'from' | 'title' | 'summary'>): string {
  const first = d.from.name.split(/\s+/)[0] || d.from.name
  return `${first} sent you: ${d.title}${d.summary ? ` — ${d.summary}` : ''}`
}
