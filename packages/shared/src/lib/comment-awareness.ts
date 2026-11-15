import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { whoText } from './presence-signals'
import { formatDateTime, getDisplayTimezone } from './utils'

/**
 * Comment awareness (realtime round 7, items 14–16), shared by the record's Comments panel and
 * a field's comment popover:
 *
 *  - "2 new replies since you started typing": comments other people post while you have an
 *    unsent draft are named above your box before you post, so nobody answers past them. The
 *    thread itself never scrolls; the strip goes when you post, clear the box or dismiss it.
 *  - "Seen by Beth, Mark": who has opened the record since a comment was written (the server
 *    judges who may be named; View-as never counts).
 *  - Mention delivery for the comment's author: seen in app / in their inbox / alert sent /
 *    emailed / bounced / muted.
 */

// ── Replies while typing ──────────────────────────────────────────────────

export interface ThreadComment {
  id: string
  user?: { id?: string | null } | null
  deleted?: boolean
  created_at?: string
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

/**
 * The comments that arrived after the draft started (pure): not in the baseline taken when the
 * box went from empty to typed, not written by me, not deleted. Oldest first.
 */
export function newRepliesSince<T extends ThreadComment>(
  baseline: ReadonlySet<string> | null,
  comments: readonly T[] | null | undefined,
  me: string | null | undefined
): T[] {
  if (!baseline || !comments) return []
  return comments
    .filter((c) => !c.deleted && !baseline.has(String(c.id)) && !sameId(c.user?.id, me))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
}

/** "1 new reply since you started typing" / "3 new replies …". */
export function repliesWhileTypingText(n: number): string {
  return `${n} new ${n === 1 ? 'reply' : 'replies'} since you started typing`
}

/**
 * Track replies that land while `draft` holds unsent text. The baseline is taken when the draft
 * stops being empty (or when the thread first loads, if typing started before it did) and is
 * dropped when the draft empties again (posted or cleared). `dismiss()` folds the current
 * replies into the baseline, so the strip returns only for newer ones.
 */
export function useRepliesWhileTyping<T extends ThreadComment>(
  draft: string,
  comments: readonly T[] | null | undefined,
  me: string | null | undefined
): { replies: T[]; dismiss: () => void } {
  const typing = draft.trim() !== ''
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null)
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const loaded = comments != null
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` re-runs it when the thread first arrives after typing started
  useEffect(() => {
    if (!typing) {
      setBaseline(null)
      return
    }
    setBaseline((prev) => {
      if (prev) return prev
      const cur = commentsRef.current
      return cur ? new Set(cur.map((c) => String(c.id))) : null
    })
  }, [typing, loaded])
  const replies = useMemo(() => newRepliesSince(baseline, comments, me), [baseline, comments, me])
  const dismiss = useCallback(() => {
    setBaseline((prev) => {
      const next = new Set(prev ?? [])
      for (const c of commentsRef.current ?? []) next.add(String(c.id))
      return next
    })
  }, [])
  return { replies, dismiss }
}

// ── Seen by ───────────────────────────────────────────────────────────────

export interface SeenPerson {
  id: string
  name: string
  seen_at: string
}

/**
 * Full names, the way the receipt line names people: up to three listed in full ("Seen by Beth
 * Ames, Jo Park and Kim Lowe"), more than three as the first two and "+N" (pure).
 */
export function seenByText(people: readonly SeenPerson[], prefix = 'Seen by'): string | null {
  const names = people.map((p) => p.name)
  if (names.length === 0) return null
  if (names.length > 3) return `${prefix} ${names[0]}, ${names[1]} +${names.length - 2}`
  if (names.length === 3) return `${prefix} ${names[0]}, ${names[1]} and ${names[2]}`
  return `${prefix} ${whoText(names)}`
}

// ── Mention receipts (the line under a comment) ───────────────────────────

export interface MentionReceipt {
  id?: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  seen_at?: string | null
  /** From the server only for the comment's author and administrators. */
  status?: 'seen' | 'in_inbox' | 'not_told' | 'muted'
  /** Administrators only: why a muted person will not be told. */
  reason?: string | null
}

export type ReceiptTone = 'ok' | 'neutral' | 'warn'

/** The name a receipt shows. */
export function receiptName(m: MentionReceipt): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'Someone'
}

/**
 * One person's receipt sentence (pure). With a server status (author / admin) it says the same
 * as the Delivery panel: seen, not seen yet, won't be told, or (administrators) muted and why.
 * Without one it promises nothing about delivery: seen, or just "not seen yet".
 */
export function mentionReceiptLine(
  m: MentionReceipt,
  relative: (iso: string) => string
): { text: string; tone: ReceiptTone } {
  const name = receiptName(m)
  if (m.seen_at || m.status === 'seen')
    return { text: `${name} saw this${m.seen_at ? ` ${relative(m.seen_at)}` : ''}`, tone: 'ok' }
  if (m.status === 'muted')
    return { text: `${name}: muted — ${m.reason || 'won’t be told'}`, tone: 'warn' }
  if (m.status === 'not_told') return { text: `${name} won’t be told`, tone: 'warn' }
  if (m.status === 'in_inbox') return { text: `${name} has not seen this yet`, tone: 'neutral' }
  return { text: `${name} · not seen yet`, tone: 'neutral' }
}

/** Calm / Off: one summary instead of a sentence per person — "3 mentioned · 1 seen" (pure). */
export function mentionReceiptSummary(people: readonly MentionReceipt[]): {
  text: string
  tone: ReceiptTone
} {
  const seen = people.filter((m) => m.seen_at || m.status === 'seen').length
  const silent = people.filter((m) => m.status === 'not_told' || m.status === 'muted').length
  const parts = [`${people.length} mentioned`, `${seen} seen`]
  if (silent) parts.push(`${silent} won’t be told`)
  return {
    text: parts.join(' · '),
    tone: silent ? 'warn' : seen === people.length ? 'ok' : 'neutral'
  }
}

// ── Mention delivery ──────────────────────────────────────────────────────

export type MentionHeadline = 'seen' | 'in_inbox' | 'muted' | 'not_told'

export interface MentionChannel {
  key: 'push' | 'email' | 'teams'
  status: 'sent' | 'deferred' | 'bounced' | 'failed' | 'not_sent'
  at: string | null
}

export interface MentionDelivery {
  id: string
  name: string
  headline: MentionHeadline
  seen_at: string | null
  delivered_at: string | null
  channels: MentionChannel[]
  reason: string | null
}

export type DeliveryTone = 'ok' | 'pending' | 'warn' | 'muted'

/** "10:42 AM" today, else the full date and time (the viewer's display zone). */
export function deliveryWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const tz = getDisplayTimezone()
  const day = (x: Date) =>
    new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(x)
  if (day(d) !== day(now)) return formatDateTime(d)
  return new Intl.DateTimeFormat('en-US', {
    ...(tz ? { timeZone: tz } : {}),
    hour: 'numeric',
    minute: '2-digit'
  }).format(d)
}

/** The headline for one person, e.g. "Seen in app 10:42 AM" (pure). */
export function mentionHeadline(
  p: MentionDelivery,
  now?: Date
): { text: string; tone: DeliveryTone } {
  switch (p.headline) {
    case 'seen':
      return { text: `Seen in app ${deliveryWhen(p.seen_at, now)}`.trim(), tone: 'ok' }
    case 'in_inbox':
      return { text: 'In their notifications, not seen yet', tone: 'pending' }
    case 'muted':
      // Administrators only (the server sends `muted` to no one else), with why in plain words.
      return { text: `Muted — ${p.reason || 'won’t be told'}`, tone: 'warn' }
    default:
      return { text: 'Won’t be told', tone: 'warn' }
  }
}

/** The channel lines under a person: "Phone alert sent 10:42 AM", "Email bounced" (pure). */
export function mentionChannelText(c: MentionChannel, now?: Date): string {
  const when = c.at ? ` ${deliveryWhen(c.at, now)}` : ''
  if (c.key === 'push') {
    return c.status === 'sent' ? `Phone or browser alert sent${when}` : 'Alert failed'
  }
  if (c.key === 'teams') return c.status === 'sent' ? `Teams message sent${when}` : 'Teams failed'
  switch (c.status) {
    case 'sent':
      return `Emailed${when}`
    case 'deferred':
      return 'Email waits for their daily summary'
    case 'bounced':
      return 'Email bounced'
    case 'failed':
      return 'Email failed'
    default:
      return 'Email not sent'
  }
}

export function channelTone(c: MentionChannel): DeliveryTone {
  if (c.status === 'bounced' || c.status === 'failed') return 'warn'
  if (c.status === 'deferred' || c.status === 'not_sent') return 'muted'
  return 'ok'
}

/** The panel's summary, the outcomes that need attention first: "1 won't be told · 1 seen" (pure). */
export function deliverySummary(people: readonly MentionDelivery[]): string {
  const seen = people.filter((p) => p.headline === 'seen').length
  const waiting = people.filter((p) => p.headline === 'in_inbox').length
  const silent = people.filter((p) => p.headline === 'muted' || p.headline === 'not_told').length
  const bounced = people.filter((p) =>
    p.channels.some((c) => c.key === 'email' && c.status === 'bounced')
  ).length
  const parts: string[] = []
  if (silent) parts.push(`${silent} won’t be told`)
  if (bounced) parts.push(`${bounced} bounced`)
  if (seen) parts.push(`${seen} seen`)
  if (waiting) parts.push(`${waiting} not seen yet`)
  return parts.join(' · ')
}
