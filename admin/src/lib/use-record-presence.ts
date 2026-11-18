import { bindRecordCoEdit, liveEventQuiet, markRemoteCell, useLivePreference } from '@nivaro/shared'
import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useAuth } from '@/lib/auth'
import { getSocket, usesWorkerSocket } from '@/lib/socket'

/**
 * Record presence v2 — who's viewing this record and which field they're
 * editing right now.
 *
 * Field focus/blur is captured at the document level via the `data-field`
 * wrapper every shared FieldRow already renders, so no shared-package
 * changes are needed. Editing indicators are applied two ways: returned as
 * state (header chips) and as an imperative outline class on the field
 * wrapper (`nvr-remote-editing`), which the caller's page styles.
 *
 * The record room rides the app's one socket (getSocket): this tab's own, or the browser's shared
 * one (#2475), which sits in several record rooms at once and routes each room's events to the
 * tabs holding it.
 */

export interface Viewer {
  id: string
  name: string
}

export interface LiveEdit extends Viewer {
  value?: unknown
}

const NO_EDITING: Record<string, LiveEdit> = {}

/**
 * One entry per person. The server lists the record room per SOCKET (and peers' viewers from
 * other processes), so someone with two tabs or two devices open — or one on two API
 * processes — came twice ("BL BL"). Ids compare case-insensitively (SQL Server uuids arrive
 * in either case); the first name seen wins. Pure — exported for tests.
 */
export function distinctViewers(viewers: readonly Viewer[] | null | undefined): Viewer[] {
  const seen = new Set<string>()
  const out: Viewer[] = []
  for (const v of viewers ?? []) {
    if (!v || v.id == null) continue
    const key = String(v.id).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

/**
 * P6 — the `data-field` a focus/typing event names, only when it belongs to the page's own
 * record form: never a field inside a dialog (a RecordDrilldownSheet / peek holds ANOTHER
 * record, a popover editor or a modal is not the form), and, when the page marks its form root,
 * only inside that root. Null = not relayed. Pure — exported for tests.
 */
export function pageFormField(
  target: EventTarget | null,
  root: HTMLElement | null | undefined
): string | null {
  const wrap = (target as HTMLElement | null)?.closest?.('[data-field]')
  if (!wrap || wrap.closest('[role="dialog"],[role="alertdialog"]')) return null
  if (root && !root.contains(wrap)) return null
  return wrap.getAttribute('data-field') || null
}

export function useRecordPresence(
  collection: string | undefined,
  item: string | undefined,
  /** The page's own form root (P6): fields outside it are never relayed. */
  formRoot?: RefObject<HTMLElement | null>
) {
  const { user } = useAuth()
  const [viewers, setViewers] = useState<Viewer[]>([])
  const [editing, setEditing] = useState<Record<string, LiveEdit>>({})
  const socketRef = useRef<Socket | null>(null)
  /** P6: read at event time, so a late-mounted root still counts (stable across renders). */
  const formRootRef = useRef(formRoot)
  formRootRef.current = formRoot

  useEffect(() => {
    if (!collection || !item || item === 'new') return

    // The app's one socket (getSocket — the shared worker, or this tab's own, which signs itself
    // in). A record page used to open a second connection per tab without SharedWorker.
    const shared = usesWorkerSocket()
    const socket = getSocket()
    socketRef.current = socket
    let disposed = false
    /** Everything this record page put on the socket, so a shared one is left clean. */
    const bound: Array<[string, (...a: any[]) => void]> = []
    const bind = (event: string, cb: (...a: any[]) => void) => {
      socket.on(event, cb)
      bound.push([event, cb])
    }

    const join = () => {
      if (!disposed) socket.emit('record:join', { collection, item })
    }
    // Realtime round 7 — the shared form's section presence and "Point Beth to this field"
    // ride this record-room socket (shared lib/co-edit.ts).
    const unbindCoEdit = bindRecordCoEdit(socket, collection, item, user?.id ?? null)
    bind('auth:ok', join)
    // The socket is usually signed in already: join now, and again after each auth:ok.
    if (socket.connected) join()

    // The live-record notices this socket receives (record:integrity, owners:changed,
    // access:changed …) reach the shared hooks (lib/live.ts useLiveEvent) through getSocket's
    // own relay, once for every record page.

    bind(
      'record:viewers',
      (payload: { collection?: string | null; item?: string | null; viewers: Viewer[] }) => {
        if (
          payload?.collection != null &&
          payload?.item != null &&
          (payload.collection !== collection || String(payload.item) !== String(item))
        )
          return
        setViewers(distinctViewers(payload.viewers))
      }
    )

    // Upload presence relay (#282): this socket is the one actually inside
    // the record room, so it carries upload announcements both ways —
    // outbound from the file fields' window event, inbound re-dispatched as
    // a window event RecordLiveSync renders as chips.
    // rt9 #9: the whole report travels (upload id, field, phase, percent) — the server names the
    // file only to people who may read that field. An upload naming another record stays out.
    const onLocalUpload = (e: Event) => {
      const d = (e as CustomEvent).detail as
        | { name?: string; state?: string; collection?: string; item?: string }
        | undefined
      if (!d?.name) return
      if (d.collection && (d.collection !== collection || String(d.item) !== String(item))) return
      socket.emit('record:uploading', { ...d, collection, item: String(item) })
    }
    // On the shared socket the record form's own `realtime.emit` already reaches the room.
    if (!shared) window.addEventListener('nvr:upload-state', onLocalUpload)
    // Signals (a note being written, a transition dialog open — lib/presence-signals.ts) leave
    // through this socket too: it, not the feed socket, sits in the record room.
    const onSignalOut = (e: Event) => {
      const d = (e as CustomEvent).detail as
        | { collection?: string; item?: string; kind?: string; state?: string; field?: string }
        | undefined
      // `field` (a field comment thread) must ride along: the server sends it only to people
      // who may read that field — dropped here, it would go to the whole record room.
      if (d?.collection === collection && String(d.item) === String(item) && d.kind)
        socket.emit('record:signal', {
          collection,
          item,
          kind: d.kind,
          state: d.state,
          ...(d.field ? { field: d.field } : {})
        })
    }
    // On the shared socket the sender's own `realtime.emit('record:signal')` already reaches it.
    if (!shared) window.addEventListener('nvr:record-signal-out', onSignalOut)
    bind('record:uploading', (payload: unknown) => {
      if (liveEventQuiet('record:uploading')) return
      window.dispatchEvent(new CustomEvent('nvr:record-uploading', { detail: payload }))
    })

    const forThisRecord = (p: { collection?: string | null; item?: string | null }) =>
      p?.collection == null ||
      p?.item == null ||
      (p.collection === collection && String(p.item) === String(item))
    bind(
      'field:editing',
      (payload: {
        field: string
        user: Viewer | null
        collection?: string | null
        item?: string | null
      }) => {
        if (!forThisRecord(payload)) return
        setEditing((prev) => {
          const next = { ...prev }
          if (payload.user && payload.user.id !== user?.id) next[payload.field] = payload.user
          else delete next[payload.field]
          return next
        })
      }
    )

    // Live keystroke preview from other editors
    bind(
      'field:changed',
      (payload: {
        field: string
        value?: unknown
        user: Viewer | null
        collection?: string | null
        item?: string | null
      }) => {
        if (!forThisRecord(payload) || !payload.user || payload.user.id === user?.id) return
        setEditing((prev) => ({
          ...prev,
          [payload.field]: { ...payload.user!, value: payload.value }
        }))
      }
    )

    // Broadcast my own focus/blur from the data-field wrappers
    const onFocusIn = (e: FocusEvent) => {
      const field = pageFormField(e.target, formRootRef.current?.current)
      if (field) socket.emit('field:focus', { field, collection, item })
    }
    const onFocusOut = (e: FocusEvent) => {
      const field = pageFormField(e.target, formRootRef.current?.current)
      if (field) socket.emit('field:blur', { field, collection, item })
    }
    // Broadcast my keystrokes (throttled) for the live preview on other screens
    let lastEmit = 0
    const onInput = (e: Event) => {
      const target = e.target as HTMLInputElement | HTMLTextAreaElement | null
      const field = pageFormField(target, formRootRef.current?.current)
      if (!field) return
      const now = Date.now()
      if (now - lastEmit < 250) return
      lastEmit = now
      const type = target && 'type' in target ? (target as HTMLInputElement).type : ''
      // A password input never sends what is typed; co-viewers still see who is editing.
      if (type === 'password') {
        socket.emit('field:change', { field, collection, item })
        return
      }
      const value =
        type === 'checkbox' ? (target as HTMLInputElement).checked : (target?.value ?? '')
      socket.emit('field:change', { field, value, collection, item })
    }
    // Row presence: an inline grid announces which saved row is open in its
    // editor; relay it as a synthetic `row:<collection>:<id>` field so the
    // existing field:editing fan-out carries it.
    const onRowEditing = (e: Event) => {
      const d = (e as CustomEvent).detail as { row?: string; state?: string }
      if (!d?.row) return
      socket.emit(d.state === 'end' ? 'field:blur' : 'field:focus', {
        field: `row:${d.row}`,
        collection,
        item
      })
    }
    // #69 — cell-level cursors: an inline grid announces the cell its editor
    // has focus in; relayed as `cell:<collection>:<row>:<field>`.
    const onCellEditing = (e: Event) => {
      const d = (e as CustomEvent).detail as { cell?: string; state?: string }
      if (!d?.cell) return
      socket.emit(d.state === 'end' ? 'field:blur' : 'field:focus', {
        field: `cell:${d.cell}`,
        collection,
        item
      })
    }
    window.addEventListener('nvr:cell-editing', onCellEditing)
    window.addEventListener('nvr:row-editing', onRowEditing)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('input', onInput)

    return () => {
      window.removeEventListener('nvr:upload-state', onLocalUpload)
      window.removeEventListener('nvr:record-signal-out', onSignalOut)
      disposed = true
      unbindCoEdit()
      window.removeEventListener('nvr:cell-editing', onCellEditing)
      window.removeEventListener('nvr:row-editing', onRowEditing)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('input', onInput)
      socket.emit('record:leave', { collection, item })
      for (const [ev, cb] of bound) socket.off(ev, cb)
      socketRef.current = null
      setViewers([])
      setEditing({})
    }
  }, [collection, item, user?.id])

  // Live updates Calm/Off (Profile → Display): no "who else is here" or "editing" marks. The
  // person still joins the room (others keep seeing them); only what this tab shows goes quiet.
  const { quiet } = useLivePreference()
  const shownEditing = quiet ? NO_EDITING : editing

  // Imperative outline on remotely-edited fields
  useEffect(() => {
    const marked: HTMLElement[] = []
    const undo: Array<() => void> = []
    const editing = shownEditing
    for (const field of Object.keys(editing)) {
      // A grid cell: the person's own colour, their name on hover (realtime item 25).
      if (field.startsWith('cell:')) {
        const cell = document.querySelector<HTMLElement>(
          `[data-grid-cell="${CSS.escape(field.slice(5))}"]`
        )
        if (cell) undo.push(markRemoteCell(cell, editing[field]))
        continue
      }
      // `row:<collection>:<id>` marks a grid row; anything else a field wrapper.
      const el = field.startsWith('row:')
        ? document.querySelector<HTMLElement>(`[data-o2m-row="${CSS.escape(field.slice(4))}"]`)
        : field.startsWith('cell:')
          ? document.querySelector<HTMLElement>(`[data-grid-cell="${CSS.escape(field.slice(5))}"]`)
          : document.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)
      if (el) {
        el.classList.add('nvr-remote-editing')
        const e = editing[field]
        el.dataset.remoteEditor =
          e.value !== undefined && e.value !== ''
            ? `${e.name}: ${String(e.value).slice(0, 40)}`
            : e.name
        marked.push(el)
      }
    }
    return () => {
      for (const el of marked) {
        el.classList.remove('nvr-remote-editing')
        delete el.dataset.remoteEditor
      }
      for (const u of undo) u()
    }
  }, [shownEditing])

  const others = quiet ? [] : viewers.filter((v) => v.id !== user?.id)
  return { viewers: others, editing: shownEditing }
}
