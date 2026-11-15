import { encodeListLink, LIST_LINK_MAX_CHARS } from './list-link'
import type { NotificationTargetSpec } from './notification-target'

/**
 * "Send my view to Beth" (api routes/send-view.ts). What a screen hands over: which record,
 * list or queue, and the list's VIEW SETTINGS (the same `lv` envelope "Copy link" uses —
 * filters, sort, columns, page size). Never rows, never a record's values. The recipient
 * opens it as themselves.
 */

export interface SendViewInput {
  kind: 'record' | 'list' | 'queue'
  collection?: string | null
  item?: string | number | null
  queue?: string | number | null
  /** base64url `lv` envelope (lists and queues). */
  lv?: string | null
  /** A record tab to land on. */
  tab?: string | null
  /** The sender's own words for the filters, e.g. "Region NER, PUB'd". */
  summary?: string | null
}

/** What the recipient's tab reads back (GET /send-view/:id), resolved as them. */
export interface SentViewCard {
  id: string
  from: { id: string; name: string }
  kind: 'record' | 'list' | 'queue'
  title: string
  summary: string | null
  note: string | null
  at: string
  target: NotificationTargetSpec
}

/** A list's view as a send-view body: its `lv` settings, or none when they would not fit. */
export function listViewInput(
  kind: 'list' | 'queue',
  id: string | number,
  listKey: string,
  state: Record<string, unknown>,
  summary?: string | null
): SendViewInput {
  const lv = encodeListLink(listKey, state)
  return {
    kind,
    ...(kind === 'list' ? { collection: String(id) } : { queue: String(id) }),
    lv: lv.length <= LIST_LINK_MAX_CHARS ? lv : null,
    summary: summary ?? null
  }
}

/** The record tab on the address bar (`?tab=`), when it is a plain key. */
export function currentRecordTab(): string | null {
  if (typeof window === 'undefined') return null
  const t = new URLSearchParams(window.location.search).get('tab')
  return t && /^[A-Za-z0-9_-]{1,40}$/.test(t) ? t : null
}

/** "Rob sent you" — first name only, the card's lead. */
export function senderLead(name: string): string {
  return `${name.split(/\s+/)[0] || name} sent you`
}
