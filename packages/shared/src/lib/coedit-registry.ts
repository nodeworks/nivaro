/**
 * Co-editing long text (realtime round 3, item 8) — what the record form needs to know about a
 * field people are writing in together.
 *
 * The rule (agreed with the per-field merge, realtime round 2 item 1): a co-edited field never
 * produces a save conflict with itself. When someone in the same writing session saves, the
 * value that lands is a state of the shared document this browser has already seen — its
 * draft already holds that text (and maybe more typed since). The form asks `coeditCovers`
 * before it raises Keep mine / Take theirs; a covered value is no conflict and no "changed by"
 * note. A value the session never held (someone saved from elsewhere) still is.
 *
 * Pure leaf module: the editor binding (components/item-edit/coedit) writes, the form reads.
 */

const SEEN_MAX = 400
/** Fields remembered at once (one per long-text field of the records opened this visit). */
const FIELDS_MAX = 200

interface FieldSession {
  /** Hashes of every document state (as saved HTML) the session confirmed while open here. */
  seen: Set<string>
  /** Insertion order, to forget the oldest past SEEN_MAX. */
  order: string[]
  live: boolean
}

const sessions = new Map<string, FieldSession>()

const keyOf = (collection: string, item: string | number, field: string) =>
  `${collection}\u0001${String(item)}\u0001${field}`

/** FNV-1a over the string, two lanes (collisions across a few hundred states are moot). */
export function coeditHash(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return `${a.toString(36)}.${b.toString(36)}.${s.length}`
}

function entry(collection: string, item: string | number, field: string): FieldSession {
  const k = keyOf(collection, item, field)
  let e = sessions.get(k)
  if (!e) {
    if (sessions.size >= FIELDS_MAX) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
    e = { seen: new Set(), order: [], live: false }
    sessions.set(k, e)
  }
  return e
}

/** The binding joined (true) or left (false) the field's writing session. */
export function noteCoeditLive(
  collection: string,
  item: string | number,
  field: string,
  live: boolean
): void {
  const e = entry(collection, item, field)
  e.live = live
}

/** A confirmed document state of the session, as the HTML a save of it would store. */
export function noteCoeditState(
  collection: string,
  item: string | number,
  field: string,
  html: string
): void {
  const e = entry(collection, item, field)
  const h = coeditHash(html)
  if (e.seen.has(h)) return
  e.seen.add(h)
  e.order.push(h)
  while (e.order.length > SEEN_MAX) {
    const old = e.order.shift()
    if (old) e.seen.delete(old)
  }
}

/** Forget a field (the editor unmounted). */
export function forgetCoedit(collection: string, item: string | number, field: string): void {
  sessions.delete(keyOf(collection, item, field))
}

/**
 * Is `value` (someone's save of this field) a state of a writing session this browser took
 * part in? Then the person's draft already holds it: no conflict, no note.
 */
export function coeditCovers(
  collection: string,
  item: string | number,
  field: string,
  value: unknown
): boolean {
  if (typeof value !== 'string') return false
  const e = sessions.get(keyOf(collection, item, field))
  return !!e && e.seen.has(coeditHash(value))
}

/** Is a writing session on this field open in this browser right now? */
export function coeditLive(collection: string, item: string | number, field: string): boolean {
  return !!sessions.get(keyOf(collection, item, field))?.live
}

/** Tests only. */
export function __resetCoeditRegistry(): void {
  sessions.clear()
}
