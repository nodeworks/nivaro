import { useSyncExternalStore } from 'react'
import { useLivePreference } from './live-preference'

/**
 * Co-editing on a record page (realtime round 7, items 3 and 4) — who is in which field, and
 * pointing a co-viewer at one field.
 *
 * Each host already owns the socket that sits in the record's room (admin
 * `use-record-presence`, efp-new `record-presence`). It hands that socket to
 * `bindRecordCoEdit(socket, collection, item, selfId)` once; this module then keeps, per
 * record, the people viewing it and the field (or grid row / cell) each one is in, and carries
 * "Point Beth to this field" both ways. The shared form reads it with `useCoViewers`,
 * `useFieldEditors` and `useFieldPointer` without knowing the host's transport.
 *
 * Names only, never values. Calm and Off (live-preference) hide the presence marks; a nudge
 * still arrives (a person asked for it) but never moves the page in Calm/Off.
 */

export interface CoViewer {
  id: string
  name: string
}

/** A nudge someone sent this person: look at `field`. */
export interface FieldPointer {
  collection: string
  item: string
  field: string
  user: CoViewer
  at: number
}

/** What the server said about a nudge THIS tab sent. */
export interface FieldPointResult {
  collection: string
  item: string
  field: string
  to: string
  ok: boolean
  reason?: 'rate' | 'self' | 'gone' | 'field'
}

/** The socket calls this module needs (socket.io's Socket and the worker facade both fit). */
export interface CoEditSocket {
  on(event: string, cb: (payload: any) => void): unknown
  off(event: string, cb: (payload: any) => void): unknown
  emit(event: string, payload: unknown): unknown
}

interface RecordState {
  viewers: CoViewer[]
  editing: Record<string, CoViewer>
  pointer: FieldPointer | null
  result: (FieldPointResult & { seq: number }) | null
}

const EMPTY: RecordState = { viewers: [], editing: {}, pointer: null, result: null }
const states = new Map<string, RecordState>()
const listeners = new Set<() => void>()
/** Refs of nudges this tab sent (a shared socket hands results to every tab on the record). */
const myRefs = new Set<string>()
let resultSeq = 0

const keyOf = (collection: string, item: string | number) => `${collection}\u0001${String(item)}`

function emitChange(): void {
  for (const l of listeners) l()
}

function update(collection: string, item: string, f: (s: RecordState) => RecordState): void {
  const k = keyOf(collection, item)
  const cur = states.get(k) ?? EMPTY
  const next = f(cur)
  if (next === cur) return
  states.set(k, next)
  emitChange()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && String(a).toUpperCase() === String(b).toUpperCase()
}

/** A presence event for this record (an older server names no record: accept it). */
function forRecord(p: any, collection: string, item: string): boolean {
  if (p?.collection == null || p?.item == null) return true
  return p.collection === collection && String(p.item) === item
}

// ── Pure helpers (exported for tests) ──────────────────────────────────────

/** Fold one `field:editing` event into the editing map. */
export function applyFieldEditing(
  editing: Record<string, CoViewer>,
  payload: { field?: unknown; user?: { id?: unknown; name?: unknown } | null },
  selfId: string | null
): Record<string, CoViewer> {
  const field = typeof payload?.field === 'string' ? payload.field : ''
  if (!field) return editing
  const u = payload.user
  if (u?.id != null && !same(String(u.id), selfId)) {
    const cur = editing[field]
    const name = String(u.name || 'Someone')
    if (cur && same(cur.id, String(u.id)) && cur.name === name) return editing
    return { ...editing, [field]: { id: String(u.id), name } }
  }
  if (!(field in editing)) return editing
  const next = { ...editing }
  delete next[field]
  return next
}

/** The people in a section: whose focus is on one of its fields, or a grid row/cell of one of
 *  its line collections. Only fields the viewer's form has (so only readable ones) count. */
export function sectionPresence(
  editing: Record<string, CoViewer>,
  fields: ReadonlySet<string>,
  lineCollections: ReadonlySet<string> = new Set()
): CoViewer[] {
  const out: CoViewer[] = []
  for (const [key, who] of Object.entries(editing)) {
    let inside = false
    if (key.startsWith('row:') || key.startsWith('cell:')) {
      const coll = key.slice(key.indexOf(':') + 1).split(':')[0]
      inside = !!coll && lineCollections.has(coll)
    } else inside = fields.has(key)
    if (inside && !out.some((p) => same(p.id, who.id))) out.push(who)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** "Beth is in Shipping", "Beth and Kim are in Shipping", "Beth, Kim and 2 others are in …". */
export function sectionPresenceText(people: CoViewer[], section: string): string | null {
  if (people.length === 0) return null
  const names = people.map((p) => p.name)
  const who =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length === 3 ? '' : 's'}`
  return `${who} ${names.length === 1 ? 'is' : 'are'} in ${section}`
}

/** How long without keys, pointer or wheel counts as idle for a nudge. */
export const POINT_IDLE_MS = 8_000

/**
 * May a nudge scroll the page to the field? Only when the person is idle there: Normal mode,
 * tab visible, nothing being typed in, no open menu or popover, no input for a while.
 */
export function pointMayScroll(s: {
  quiet: boolean
  visible: boolean
  editingSomething: boolean
  popoverOpen: boolean
  lastInputAt: number
  now: number
}): boolean {
  if (s.quiet || !s.visible || s.editingSomething || s.popoverOpen) return false
  return s.now - s.lastInputAt >= POINT_IDLE_MS
}

/** The sender's words for a refused nudge. */
export function pointRefusalText(r: FieldPointResult['reason'], name: string): string {
  switch (r) {
    case 'rate':
      return `You pointed ${name} a moment ago — give it a few seconds`
    case 'gone':
      return `${name} is no longer on this record`
    case 'field':
      return `${name} can't see this field`
    case 'self':
      return 'That is you'
    default:
      return `Could not point ${name} there`
  }
}

// ── Host side ──────────────────────────────────────────────────────────────

export const FIELD_POINT_OUT = 'nvr:field-point-out'
/** Window event a folded section listens for: `{field}` or `{key}` → it opens. */
export const OPEN_SECTION_EVENT = 'nvr:open-section'

/** Open the folded section (if any) that holds `field`, so it can be scrolled to. */
export function openSectionOf(field: string): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(OPEN_SECTION_EVENT, { detail: { field } }))
}

/**
 * Wire the host's record-room socket to this module for one record. Returns the cleanup. The
 * host still joins/leaves the room and paints its own field outlines; this only listens.
 */
export function bindRecordCoEdit(
  socket: CoEditSocket,
  collection: string,
  item: string | number,
  selfId: string | null | undefined
): () => void {
  const id = String(item)
  const me = selfId ? String(selfId) : null
  const onViewers = (p: any) => {
    if (!forRecord(p, collection, id) || !Array.isArray(p?.viewers)) return
    const seen = new Set<string>()
    const viewers: CoViewer[] = []
    for (const v of p.viewers as Array<{ id?: unknown; name?: unknown }>) {
      if (v?.id == null || same(String(v.id), me)) continue
      const k = String(v.id).toUpperCase()
      if (seen.has(k)) continue
      seen.add(k)
      viewers.push({ id: String(v.id), name: String(v.name || 'Someone') })
    }
    update(collection, id, (s) => {
      // Someone who left is not in any field any more.
      const here = new Set(viewers.map((v) => v.id.toUpperCase()))
      const kept = Object.entries(s.editing).filter(([, w]) => here.has(w.id.toUpperCase()))
      const editing =
        kept.length === Object.keys(s.editing).length ? s.editing : Object.fromEntries(kept)
      const sameViewers =
        viewers.length === s.viewers.length &&
        viewers.every((v, i) => v.id === s.viewers[i].id && v.name === s.viewers[i].name)
      if (sameViewers && editing === s.editing) return s
      return { ...s, viewers: sameViewers ? s.viewers : viewers, editing }
    })
  }
  const onEditing = (p: any) => {
    if (!forRecord(p, collection, id)) return
    update(collection, id, (s) => {
      const editing = applyFieldEditing(s.editing, p, me)
      return editing === s.editing ? s : { ...s, editing }
    })
  }
  const onPointed = (p: any) => {
    if (p?.collection !== collection || String(p?.item) !== id) return
    if (typeof p.field !== 'string' || !p.user?.id || same(String(p.user.id), me)) return
    const pointer: FieldPointer = {
      collection,
      item: id,
      field: p.field,
      user: { id: String(p.user.id), name: String(p.user.name || 'Someone') },
      at: Date.now()
    }
    update(collection, id, (s) => ({ ...s, pointer }))
  }
  const onResult = (p: any) => {
    if (p?.collection !== collection || String(p?.item) !== id) return
    if (typeof p.ref !== 'string' || !myRefs.has(p.ref)) return
    myRefs.delete(p.ref)
    const result = { ...(p as FieldPointResult), seq: ++resultSeq }
    update(collection, id, (s) => ({ ...s, result }))
  }
  const onOut = (e: Event) => {
    const d = (e as CustomEvent).detail as
      | { collection?: string; item?: string; field?: string; to?: string; ref?: string }
      | undefined
    if (d?.collection !== collection || String(d.item) !== id || !d.field || !d.to) return
    socket.emit('field:point', { collection, item: id, field: d.field, to: d.to, ref: d.ref })
  }
  socket.on('record:viewers', onViewers)
  socket.on('field:editing', onEditing)
  socket.on('field:pointed', onPointed)
  socket.on('field:point-result', onResult)
  if (typeof window !== 'undefined') window.addEventListener(FIELD_POINT_OUT, onOut)
  return () => {
    socket.off('record:viewers', onViewers)
    socket.off('field:editing', onEditing)
    socket.off('field:pointed', onPointed)
    socket.off('field:point-result', onResult)
    if (typeof window !== 'undefined') window.removeEventListener(FIELD_POINT_OUT, onOut)
    if (states.delete(keyOf(collection, id))) emitChange()
  }
}

// ── Form side ──────────────────────────────────────────────────────────────

/** Ask the host to point `to` at `field` on this record (the host's socket carries it). */
export function pointCoViewer(
  collection: string,
  item: string | number,
  field: string,
  to: string
): void {
  if (typeof window === 'undefined') return
  const ref = Math.random().toString(36).slice(2, 12)
  myRefs.add(ref)
  if (myRefs.size > 50) myRefs.delete(myRefs.values().next().value as string)
  window.dispatchEvent(
    new CustomEvent(FIELD_POINT_OUT, { detail: { collection, item: String(item), field, to, ref } })
  )
}

/** One slice of a record's state; re-renders only when that slice changes (a field focus
 *  elsewhere must not re-render every field row that only asks who is here). */
function useRecordSlice<T>(
  collection: string | null | undefined,
  item: unknown,
  pick: (s: RecordState) => T
): T {
  const k = collection && item != null ? keyOf(collection, String(item)) : ''
  return useSyncExternalStore(
    subscribe,
    () => pick(k ? (states.get(k) ?? EMPTY) : EMPTY),
    () => pick(EMPTY)
  )
}

const NO_VIEWERS: CoViewer[] = []
const NO_EDITING: Record<string, CoViewer> = {}
const pickViewers = (s: RecordState) => s.viewers
const pickEditing = (s: RecordState) => s.editing
const pickPointer = (s: RecordState) => s.pointer
const pickResult = (s: RecordState) => s.result

/** The OTHER people with this record open (none in Calm/Off). */
export function useCoViewers(collection: string | null | undefined, item: unknown): CoViewer[] {
  const viewers = useRecordSlice(collection, item, pickViewers)
  const { quiet } = useLivePreference()
  return quiet ? NO_VIEWERS : viewers
}

/** Field (or `row:` / `cell:` key) → the co-viewer in it (none in Calm/Off). */
export function useFieldEditors(
  collection: string | null | undefined,
  item: unknown
): Record<string, CoViewer> {
  const editing = useRecordSlice(collection, item, pickEditing)
  const { quiet } = useLivePreference()
  return quiet ? NO_EDITING : editing
}

/** The newest nudge this person got on this record, and the last answer to their own. */
export function useFieldPointer(
  collection: string | null | undefined,
  item: unknown
): {
  pointer: FieldPointer | null
  result: (FieldPointResult & { seq: number }) | null
  dismiss: () => void
} {
  const pointer = useRecordSlice(collection, item, pickPointer)
  const result = useRecordSlice(collection, item, pickResult)
  return {
    pointer,
    result,
    dismiss: () => {
      if (collection && item != null)
        update(collection, String(item), (cur) => (cur.pointer ? { ...cur, pointer: null } : cur))
    }
  }
}

/** Tests: start empty. */
export function resetCoEditForTests(): void {
  states.clear()
  myRefs.clear()
  emitChange()
}
