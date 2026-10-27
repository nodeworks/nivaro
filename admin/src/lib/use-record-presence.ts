import { relayLiveEvent } from '@nivaro/shared'
import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

import { useAuth } from '@/lib/auth'
import { getSocket, mintWsToken, usesWorkerSocket } from '@/lib/socket'
import { SOCKET_TRANSPORT_OPTIONS } from '@/lib/socket-transport'

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
 * The record room rides a socket of its own per record page — unless the tab shares the
 * browser's socket (#2475): then it is the shared one, which sits in several record rooms
 * at once and routes each room's events to the tabs holding it.
 */

export interface Viewer {
  id: string
  name: string
}

export interface LiveEdit extends Viewer {
  value?: unknown
}

export function useRecordPresence(collection: string | undefined, item: string | undefined) {
  const { user } = useAuth()
  const [viewers, setViewers] = useState<Viewer[]>([])
  const [editing, setEditing] = useState<Record<string, LiveEdit>>({})
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!collection || !item || item === 'new') return

    const shared = usesWorkerSocket()
    const socket = shared
      ? getSocket()
      : io(API_URL, {
          ...SOCKET_TRANSPORT_OPTIONS,
          withCredentials: true,
          reconnectionDelay: 1500 + Math.floor(Math.random() * 2500),
          reconnectionDelayMax: 15_000,
          randomizationFactor: 0.6
        })
    socketRef.current = socket
    let disposed = false
    /** Everything this record page put on the socket, so a shared one is left clean. */
    const bound: Array<[string, (...a: any[]) => void]> = []
    const bind = (event: string, cb: (...a: any[]) => void) => {
      socket.on(event, cb)
      bound.push([event, cb])
    }

    if (!shared)
      bind('connect', async () => {
        // Every sign-in mints a one-time ws token (the static token never reaches the browser).
        const token = await mintWsToken()
        if (token && !disposed) socket.emit('auth', { token })
      })

    const join = () => socket.emit('record:join', { collection, item })
    bind('auth:ok', join)
    // The shared socket is usually signed in already: join now, and again after each auth:ok.
    if (shared && socket.connected) join()

    // This socket is the one inside the record room (and the user room): hand
    // the live-record notices to the shared hooks (lib/live.ts useLiveEvent).
    const relayed = [
      'record:integrity',
      'record:automation',
      'owners:changed',
      'access:changed',
      'record:signal'
    ]
    // On the shared socket the host relays these once for every record page (getSocket).
    if (!shared)
      for (const ev of relayed) bind(ev, (payload: unknown) => relayLiveEvent(ev, payload))

    bind(
      'record:viewers',
      (payload: { collection?: string | null; item?: string | null; viewers: Viewer[] }) => {
        if (
          payload?.collection != null &&
          payload?.item != null &&
          (payload.collection !== collection || String(payload.item) !== String(item))
        )
          return
        setViewers(payload.viewers ?? [])
      }
    )

    // Upload presence relay (#282): this socket is the one actually inside
    // the record room, so it carries upload announcements both ways —
    // outbound from the file fields' window event, inbound re-dispatched as
    // a window event RecordLiveSync renders as chips.
    const onLocalUpload = (e: Event) => {
      const d = (e as CustomEvent).detail as { name?: string; state?: string }
      if (d?.name) socket.emit('record:uploading', { name: d.name, state: d.state })
    }
    window.addEventListener('nvr:upload-state', onLocalUpload)
    // Signals (a note being written, a transition dialog open — lib/presence-signals.ts) leave
    // through this socket too: it, not the feed socket, sits in the record room.
    const onSignalOut = (e: Event) => {
      const d = (e as CustomEvent).detail as
        | { collection?: string; item?: string; kind?: string; state?: string }
        | undefined
      if (d?.collection === collection && String(d.item) === String(item) && d.kind)
        socket.emit('record:signal', { collection, item, kind: d.kind, state: d.state })
    }
    // On the shared socket the sender's own `realtime.emit('record:signal')` already reaches it.
    if (!shared) window.addEventListener('nvr:record-signal-out', onSignalOut)
    bind('record:uploading', (payload: unknown) => {
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
      const wrap = (e.target as HTMLElement | null)?.closest?.('[data-field]')
      const field = wrap?.getAttribute('data-field')
      if (field) socket.emit('field:focus', { field, collection, item })
    }
    const onFocusOut = (e: FocusEvent) => {
      const wrap = (e.target as HTMLElement | null)?.closest?.('[data-field]')
      const field = wrap?.getAttribute('data-field')
      if (field) socket.emit('field:blur', { field, collection, item })
    }
    // Broadcast my keystrokes (throttled) for the live preview on other screens
    let lastEmit = 0
    const onInput = (e: Event) => {
      const target = e.target as HTMLInputElement | HTMLTextAreaElement | null
      const wrap = target?.closest?.('[data-field]')
      const field = wrap?.getAttribute('data-field')
      if (!field) return
      const now = Date.now()
      if (now - lastEmit < 250) return
      lastEmit = now
      const value =
        target && 'type' in target && (target as HTMLInputElement).type === 'checkbox'
          ? (target as HTMLInputElement).checked
          : (target?.value ?? '')
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
      window.removeEventListener('nvr:cell-editing', onCellEditing)
      window.removeEventListener('nvr:row-editing', onRowEditing)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('input', onInput)
      socket.emit('record:leave', { collection, item })
      for (const [ev, cb] of bound) socket.off(ev, cb)
      if (!shared) socket.disconnect()
      socketRef.current = null
      setViewers([])
      setEditing({})
    }
  }, [collection, item, user?.id])

  // Imperative outline on remotely-edited fields
  useEffect(() => {
    const marked: HTMLElement[] = []
    for (const field of Object.keys(editing)) {
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
    }
  }, [editing])

  const others = viewers.filter((v) => v.id !== user?.id)
  return { viewers: others, editing }
}
