import type { Query } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useLiveEvent } from './live'
import { forgetSettledReads } from './request-gate'

/**
 * One person, many tabs and devices (#2383, #2434). What a person does in one place shows in
 * the others at once instead of on the next poll:
 *
 *   read:changed    reading a notification, or a chat room, clears its unread state everywhere
 *   prefs:changed   saved preferences (display, sound, do not disturb…) apply everywhere
 *   access:changed  {perms: true} — this person's role, policies, scopes or field access moved
 *                   (rt2 #18): the signed-in user (menus, buttons) and every query on screen
 *                   are fetched again as them, so things appear or go without signing out
 *   people:changed  {user_ids?, created?} — someone was added or their name, title, photo or
 *                   status moved (rt2 #19): pickers, mentions, cards and avatars refetch
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
  /** The host refetches its signed-in user (permissions, menus). Default: onPrefsChanged,
   *  which every host already points at its auth user. */
  onAccessChanged?: () => void
}

/**
 * Query keys that read people (lists, pickers, mention search, directory). A per-person key
 * (`PERSON_KEYS`) holds the person's id second and is refreshed only for the people named.
 */
export const PEOPLE_LIST_KEYS = new Set([
  'users',
  'people-search',
  'people-cards',
  'task-people',
  'task-people-search',
  'sla-users',
  'sla-user-search',
  'role-users',
  'record-chat-mentions',
  'nvr-chat-directory',
  'nvr-chat-members',
  'nvr-chat-members-page',
  'users-list-for-issues',
  'users-list-for-approvals',
  'presence-visible-people',
  'team-members'
])
export const PERSON_KEYS = new Set([
  'user-card',
  'user-avatar',
  'user-name',
  'user-chip',
  'user',
  'activity-chip-user',
  'nvr-directory-entry',
  'nvr-profile-card'
])

/** Does a `people:changed` notice make this query stale? Exported for tests. */
export function peopleQueryMatches(key: readonly unknown[], ids: Set<string> | null): boolean {
  const head = key[0]
  if (typeof head !== 'string') return false
  if (PEOPLE_LIST_KEYS.has(head)) return true
  if (!PERSON_KEYS.has(head)) return false
  if (!ids) return true
  const who = key[1]
  return (typeof who === 'string' || typeof who === 'number') && ids.has(String(who).toUpperCase())
}

/** Spread a reaction every open tab has at once (a role change reaches many people). */
function jitter(fn: () => void, maxMs = 1200): void {
  setTimeout(fn, Math.floor(Math.random() * maxMs))
}

/** Query keys the unread state lives under. */
const NOTIFICATION_KEYS = [['notification-count'], ['notifications'], ['my-work']]
// rt5 #9: the record header's unread count for its room (RecordChatActions) follows too.
const CHAT_KEYS = [['nvr-chat-rooms'], ['nvr-chat-record-room']]

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
    // Counts: a burst of reads (mark-all) is one re-read, not one per event.
    { includeOwn: true, debounceMs: 2000 }
  )

  const applyPrefs = useRef(() => {})
  applyPrefs.current = () => {
    void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
    void qc.invalidateQueries({ queryKey: ['presence-online'] })
    onPrefs.current?.()
  }
  useLiveEvent('prefs:changed', () => applyPrefs.current(), { includeOwn: true, debounceMs: 250 })

  // rt2 #18 — permissions moved: re-read who this person is and what is on screen, as them.
  // Queries keep their data until the new answer arrives (nothing blanks or jumps); an open
  // record they can no longer read turns calm on its own (RecordLiveSync, #1925).
  const onAccess = useRef(opts.onAccessChanged)
  onAccess.current = opts.onAccessChanged
  useLiveEvent(
    'access:changed',
    (p) => {
      if (!p?.perms) return
      jitter(() => {
        forgetSettledReads()
        ;(onAccess.current ?? onPrefs.current)?.()
        void qc.invalidateQueries({ refetchType: 'active' })
      })
    },
    { includeOwn: true, debounceMs: 400 }
  )

  // rt2 #19 — the people directory moved: people lists refetch; per-person cards only for the
  // people named (all of them when a notice names nobody). Notices inside one wait are one
  // refresh covering every person they named.
  const peopleWait = useRef<{
    ids: Set<string> | null
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  useLiveEvent(
    'people:changed',
    (p) => {
      const named = Array.isArray(p?.user_ids)
        ? p.user_ids.map((x: unknown) => String(x).toUpperCase())
        : null
      const cur = peopleWait.current
      if (cur) {
        if (!named) cur.ids = null
        else if (cur.ids) for (const id of named) cur.ids.add(id)
        return
      }
      const wait = {
        ids: named ? new Set<string>(named) : null,
        timer: setTimeout(
          () => {
            peopleWait.current = null
            void qc.invalidateQueries({
              refetchType: 'active',
              predicate: (q: Query) => peopleQueryMatches(q.queryKey, wait.ids)
            })
          },
          300 + Math.floor(Math.random() * 800)
        )
      }
      peopleWait.current = wait
    },
    { includeOwn: true }
  )
  useEffect(
    () => () => {
      if (peopleWait.current) clearTimeout(peopleWait.current.timer)
    },
    []
  )

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
