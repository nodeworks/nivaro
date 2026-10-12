import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useLiveEvent } from './live'

/**
 * One person, many tabs and devices (#2383, #2434). What a person does in one place shows in
 * the others at once instead of on the next poll:
 *
 *   read:changed    reading a notification, or a chat room, clears its unread state everywhere
 *   prefs:changed   saved preferences (display, sound, do not disturb…) apply everywhere
 *
 * The server sends both through the person's user room (services/user-sync.ts); payloads name
 * a kind, a room key or preference NAMES, never values — each tab refetches through its own
 * permission-checked routes. Tabs of one browser are also told over a BroadcastChannel the
 * moment a preference is saved (`announceLocalPrefs`), which works with the socket down.
 * Mount `useUserSync` once per app shell.
 */

const PREFS_CHANNEL = 'nvr-prefs'
let channel: BroadcastChannel | null = null
function prefsChannel(scope: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    try {
      channel = new BroadcastChannel(`${PREFS_CHANNEL}:${scope}`)
    } catch {
      channel = null
    }
  }
  return channel
}

let currentScope = ''
/** Keep a "View as" tab apart from the administrator's own tabs (same idea as the socket leader's key). */
export function configureUserSync(scope: string): void {
  if (scope === currentScope) return
  currentScope = scope
  try {
    channel?.close()
  } catch {
    /* already closed */
  }
  channel = null
}

/** Tell this browser's other tabs that preferences were just saved. */
export function announceLocalPrefs(keys: string[] = []): void {
  try {
    prefsChannel(currentScope)?.postMessage({ keys })
  } catch {
    /* the socket still delivers it */
  }
}

export interface UserSyncOptions {
  /** The host refetches whatever it keeps preferences in (the admin's auth user). */
  onPrefsChanged?: () => void
}

/** Query keys the unread state lives under. */
const NOTIFICATION_KEYS = [['notification-count'], ['notifications'], ['my-work']]
const CHAT_KEYS = [['nvr-chat-rooms']]

export function useUserSync(opts: UserSyncOptions = {}): void {
  const qc = useQueryClient()
  const onPrefs = useRef(opts.onPrefsChanged)
  onPrefs.current = opts.onPrefsChanged

  useLiveEvent(
    'read:changed',
    (p) => {
      const keys = p?.kind === 'chat' ? CHAT_KEYS : NOTIFICATION_KEYS
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey })
    },
    { includeOwn: true, debounceMs: 250 }
  )

  const applyPrefs = useRef(() => {})
  applyPrefs.current = () => {
    void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
    void qc.invalidateQueries({ queryKey: ['presence-online'] })
    onPrefs.current?.()
  }
  useLiveEvent('prefs:changed', () => applyPrefs.current(), { includeOwn: true, debounceMs: 250 })

  useEffect(() => {
    const ch = prefsChannel(currentScope)
    if (!ch) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onMessage = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => applyPrefs.current(), 100)
    }
    ch.addEventListener('message', onMessage)
    return () => {
      ch.removeEventListener('message', onMessage)
      if (timer) clearTimeout(timer)
    }
  }, [])
}
