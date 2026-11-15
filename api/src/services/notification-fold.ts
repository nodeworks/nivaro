import { db } from '../db/index.js'
import { parseDetail } from './notification-resolve.js'

/**
 * Updates on one record fold into one notification as they arrive (no
 * migration — the fold lives in the row's `detail` JSON). While the newest
 * unread FYI row about a record is younger than FOLD_WINDOW_MS, the next FYI
 * update about the same record for the same person, in the same family,
 * rewrites that row instead of adding one:
 *
 *   "3 updates on CM26-79704: moved to PUB'd, 2 comments"
 *
 * The row moves to the top (its time is the newest update's), the badge
 * still counts one, and `detail.fold.items` keeps every update newest first
 * so the bell can expand them. Only FYI rows fold: anything that asks the
 * person to act (needs-you, critical, an acknowledgement, a settle key) and
 * mentions always stay their own row.
 */

export const FOLD_WINDOW_MS = 10 * 60_000
export const FOLD_MAX_ITEMS = 20
export const FOLD_MAX_COUNT = 99

export interface FoldItem {
  subject: string
  message: string | null
  at: string
  sender: string | null
  category: string | null
}

export interface FoldDetail {
  count: number
  items: FoldItem[]
}

const FAMILIES: Record<string, string> = {
  workflow: 'activity',
  watch: 'activity',
  other: 'activity'
}

/** Pure: the fold family of a row, or null when it never folds. */
export function foldFamily(row: {
  category?: string | null
  lane?: string | null
  collection?: string | null
  item?: string | number | null
  ackRequired?: boolean
  resolveKey?: string | null
}): string | null {
  if (row.ackRequired || row.resolveKey) return null
  if (row.lane !== 'fyi') return null
  const c = String(row.collection ?? '')
  if (!c || row.item == null || String(row.item) === '') return null
  if (/^(nivaro_|directus_|__)/i.test(c)) return null
  return FAMILIES[String(row.category ?? '')] ?? null
}

export type FoldKind = 'move' | 'comment' | 'change' | 'file' | 'update'

/** Pure: what one update was, for the summary. */
export function foldKind(item: Pick<FoldItem, 'subject' | 'message' | 'category'>): {
  kind: FoldKind
  label?: string
} {
  const text = `${item.subject ?? ''} ${item.message ?? ''}`
  // The subject names the step best; the message is read on its own after it.
  for (const part of [item.subject, item.message]) {
    const moved = String(part ?? '').match(/\bmoved to ([^.;:\n—]+?)(?:\s+by\s+|\s*[.;\n—]|$)/i)
    if (moved) return { kind: 'move', label: moved[1].trim() }
  }
  if (/\b(comment|note|repl(y|ied))\b/i.test(text)) return { kind: 'comment' }
  if (/\b(file|attachment|uploaded)\b/i.test(text)) return { kind: 'file' }
  if (item.category === 'watch' || /\bchang(e|ed|es)\b/i.test(text)) return { kind: 'change' }
  return { kind: 'update' }
}

const NOUN: Record<Exclude<FoldKind, 'move'>, [string, string]> = {
  comment: ['comment', 'comments'],
  change: ['change', 'changes'],
  file: ['file', 'files'],
  update: ['update', 'updates']
}

/** Pure: "moved to PUB'd, 2 comments" — the newest move first, then counts. */
export function foldSummary(items: FoldItem[]): string {
  const parts: string[] = []
  const counts: Record<string, number> = {}
  let move: string | null = null
  for (const it of items) {
    const k = foldKind(it)
    if (k.kind === 'move') {
      if (move == null) move = k.label ?? null
      continue
    }
    counts[k.kind] = (counts[k.kind] ?? 0) + 1
  }
  if (move) parts.push(`moved to ${move}`)
  for (const kind of ['comment', 'change', 'file', 'update'] as const) {
    const n = counts[kind]
    if (!n) continue
    parts.push(`${n} ${NOUN[kind][n === 1 ? 0 : 1]}`)
  }
  return parts.join(', ')
}

/** Pure: the folded row's subject. */
export function foldSubject(label: string, fold: FoldDetail): string {
  const summary = foldSummary(fold.items)
  const n = Math.min(fold.count, FOLD_MAX_COUNT)
  return `${n} updates on ${label}${summary ? `: ${summary}` : ''}`.slice(0, 255)
}

export interface FoldCandidate {
  id: number | string
  subject: string | null
  message: string | null
  timestamp: Date | string | null
  sender: string | null
  category: string | null
  lane: string | null
  status: string | null
  detail: unknown
}

/**
 * Pure: may `incoming` fold into `existing`? Same family, still unread,
 * inside the window, neither asks anything, and not past the cap.
 */
export function canFold(
  existing: FoldCandidate | null | undefined,
  incoming: { family: string; now: Date }
): boolean {
  if (!existing) return false
  if (existing.status !== 'inbox') return false
  const t = existing.timestamp ? new Date(existing.timestamp).getTime() : Number.NaN
  if (!Number.isFinite(t) || incoming.now.getTime() - t > FOLD_WINDOW_MS) return false
  if (incoming.now.getTime() < t) return false
  const d = parseDetail(existing.detail)
  if (d?.ack_required || d?.resolve_key || d?.resolved) return false
  const fam = foldFamily({
    category: existing.category,
    lane: existing.lane,
    collection: 'x',
    item: 'x'
  })
  if (fam !== incoming.family) return false
  const fold = d?.fold as FoldDetail | undefined
  return !fold || fold.count < FOLD_MAX_COUNT
}

/** Pure: the existing row's fold with `item` added (newest first, capped). */
export function addToFold(existing: FoldCandidate, item: FoldItem): FoldDetail {
  const d = parseDetail(existing.detail)
  const prior = d?.fold as FoldDetail | undefined
  const base: FoldDetail = prior?.items?.length
    ? prior
    : {
        count: 1,
        items: [
          {
            subject: String(existing.subject ?? ''),
            message: existing.message ?? null,
            at: new Date(existing.timestamp ?? Date.now()).toISOString(),
            sender: existing.sender ?? null,
            category: existing.category ?? null
          }
        ]
      }
  return {
    count: base.count + 1,
    items: [item, ...base.items].slice(0, FOLD_MAX_ITEMS)
  }
}

/**
 * Fold an incoming FYI update into the recipient's newest open row about the
 * record, when one is inside the window. Returns the folded row's id, or null
 * when the caller should insert a row of its own. Best-effort: any failure
 * answers null (the update then lands as its own row).
 */
export async function foldIntoRecent(opts: {
  recipient: string
  collection: string | null | undefined
  item: string | number | null | undefined
  category: string | null | undefined
  lane: string | null | undefined
  subject: string
  message: string | null
  sender: string | null | undefined
  now: Date
  ackRequired?: boolean
  resolveKey?: string | null
  /** The record as the recipient names it ("CM26-79704"). */
  label: () => Promise<string>
}): Promise<number | null> {
  const family = foldFamily({
    category: opts.category,
    lane: opts.lane,
    collection: opts.collection,
    item: opts.item,
    ackRequired: opts.ackRequired,
    resolveKey: opts.resolveKey
  })
  if (!family) return null
  try {
    const existing = (await db('nivaro_notifications')
      .where({
        recipient: opts.recipient,
        status: 'inbox',
        collection: opts.collection,
        item: String(opts.item)
      })
      .where('timestamp', '>', new Date(opts.now.getTime() - FOLD_WINDOW_MS))
      .orderBy('timestamp', 'desc')
      .first(
        'id',
        'subject',
        'message',
        'timestamp',
        'sender',
        'category',
        'lane',
        'status',
        'detail'
      )) as FoldCandidate | undefined
    if (!existing || !canFold(existing, { family, now: opts.now })) return null
    const fold = addToFold(existing, {
      subject: opts.subject.slice(0, 255),
      message: opts.message ? opts.message.slice(0, 500) : null,
      at: opts.now.toISOString(),
      sender: opts.sender ?? null,
      category: opts.category ?? null
    })
    const d = parseDetail(existing.detail) ?? {}
    const label = await opts.label().catch(() => String(opts.item))
    const updated = await db('nivaro_notifications')
      .where({ id: existing.id, status: 'inbox' })
      .update({
        subject: foldSubject(label, fold),
        message: (opts.message ?? '').slice(0, 500),
        sender: opts.sender ?? null,
        timestamp: opts.now,
        detail: JSON.stringify({ ...d, fold })
      })
    // Read in the meantime: the update gets its own row.
    if (!updated) return null
    return Number(existing.id)
  } catch {
    return null
  }
}
