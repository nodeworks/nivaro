import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { api } from '@/lib/api'

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

import { useAuth } from '@/lib/auth'

/**
 * Record presence v2 — who's viewing this record and which field they're
 * editing right now.
 *
 * Field focus/blur is captured at the document level via the `data-field`
 * wrapper every shared FieldRow already renders, so no shared-package
 * changes are needed. Editing indicators are applied two ways: returned as
 * state (header chips) and as an imperative outline class on the field
 * wrapper (`nvr-remote-editing`), which the caller's page styles.
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

    const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
    socketRef.current = socket
    let disposed = false

    socket.on('connect', async () => {
      // Session-cookie users mint a one-time ws token; static-token users
      // authenticate directly.
      let token = user?.static_token ?? null
      if (!token) {
        try {
          const r = await api.get<{ data: { token: string } }>('/auth/ws-token')
          token = r.data.data?.token ?? (r.data as unknown as { token?: string }).token ?? null
        } catch {
          token = null
        }
      }
      if (token && !disposed) socket.emit('auth', { token })
    })

    socket.on('auth:ok', () => {
      socket.emit('record:join', { collection, item })
    })

    socket.on('record:viewers', (payload: { viewers: Viewer[] }) => {
      setViewers(payload.viewers ?? [])
    })

    socket.on('field:editing', (payload: { field: string; user: Viewer | null }) => {
      setEditing((prev) => {
        const next = { ...prev }
        if (payload.user && payload.user.id !== user?.id) next[payload.field] = payload.user
        else delete next[payload.field]
        return next
      })
    })

    // Live keystroke preview from other editors
    socket.on(
      'field:changed',
      (payload: { field: string; value?: unknown; user: Viewer | null }) => {
        if (!payload.user || payload.user.id === user?.id) return
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
      if (field) socket.emit('field:focus', { field })
    }
    const onFocusOut = (e: FocusEvent) => {
      const wrap = (e.target as HTMLElement | null)?.closest?.('[data-field]')
      const field = wrap?.getAttribute('data-field')
      if (field) socket.emit('field:blur', { field })
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
      socket.emit('field:change', { field, value })
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('input', onInput)

    return () => {
      disposed = true
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('input', onInput)
      socket.emit('record:leave')
      socket.disconnect()
      socketRef.current = null
      setViewers([])
      setEditing({})
    }
  }, [collection, item, user?.static_token, user?.id])

  // Imperative outline on remotely-edited fields
  useEffect(() => {
    const marked: HTMLElement[] = []
    for (const field of Object.keys(editing)) {
      const el = document.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)
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
