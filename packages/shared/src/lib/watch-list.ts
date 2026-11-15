import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useOptionalNivaroClient } from '../context'
import { del, get, patch, post, put } from './commands'
import { toastError } from './error-toast'

/**
 * The watch list (rt5 #1 / #2): records a person pinned to follow from every page, in a dock
 * the app shell mounts once (components/watch-list/WatchDock.tsx). Server: /api/watch-list
 * (routes/watch-list.ts), stored in the person's own preferences, so it follows them across
 * tabs and devices.
 *
 * Reads:
 *   prefs   — pins + dock state, no record reads (every pin button and the header icon)
 *   rows    — the pinned records as the viewer reads them (dock open)
 *   summary — only which pins changed since seen (dock minimized / closed: the dot)
 *
 * Nothing here polls. The dock follows the pinned records' collections on the shared socket
 * and refetches in place, coalesced.
 */

export type DockState = 'open' | 'minimized' | 'closed'
export type DockTab = 'watching' | 'waiting' | 'mentions'
export type DockSort = 'mine' | 'changed' | 'due'

export interface WatchDockPrefs {
  state: DockState
  width: number
  tab: DockTab
  sort: DockSort
}

export interface WatchPinRef {
  key: string
  collection: string
  id: string
  pinned_at: string
}

export interface WatchPrefs {
  pins: WatchPinRef[]
  dock: WatchDockPrefs
  replies_seen_at: string | null
  max: number
}

export interface WatchChange {
  kind: 'moved' | 'edited' | 'commented' | 'created'
  at: string
  by: { id: string; name: string; self: boolean } | null
  text: string
  changed: boolean
  unseen: number
}

export interface WatchRowData {
  key: string
  collection: string
  collection_label: string
  id: string
  pinned_at: string
  available: boolean
  title: string | null
  state: { key: string; label: string; color: string | null } | null
  owners: Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
  figures: Array<{ field: string; label: string; value: number; money: boolean }>
  sla: {
    status: 'ok' | 'warning' | 'breached' | null
    warning_at: string | null
    due_at: string | null
  } | null
  timing: { in_step_s: number; usual_s: number | null; ratio: number | null } | null
  change: WatchChange | null
  updated_at: string | null
}

export interface WaitingRowData {
  key: string
  collection: string
  collection_label: string
  id: string
  title: string
  state: { key: string; label: string; color: string | null } | null
  waiting_on: Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
  since: string | null
}

export interface MentionItemData {
  key: string
  kind: 'mention' | 'reply'
  notification_id: number | null
  collection: string | null
  item: string | null
  title: string | null
  by: { id: string; name: string } | null
  text: string
  at: string
  unread: boolean
  field: string | null
}

export const WATCH_DOCK_DEFAULT: WatchDockPrefs = {
  state: 'open',
  width: 320,
  tab: 'watching',
  sort: 'mine'
}
export const WATCH_WIDTH_MIN = 280
export const WATCH_WIDTH_MAX = 480
/** Below this window width the dock never docks: the header icon opens it as a sheet. */
export const WATCH_DOCK_MIN_VIEWPORT = 1180

export const watchKeys = {
  all: ['watch-list'] as const,
  prefs: ['watch-list', 'prefs'] as const,
  rows: (sig: string) => ['watch-list', 'rows', sig] as const,
  summary: (sig: string) => ['watch-list', 'summary', sig] as const,
  waiting: ['watch-list', 'waiting'] as const,
  mentions: ['watch-list', 'mentions'] as const
}

export const pinKeyOf = (collection: string, id: string | number) => `${collection}:${id}`

/** Pin order as one string: the rows query's key (a new pin = a new read). */
export function pinsSignature(pins: WatchPinRef[]): string {
  return pins.map((p) => p.key).join('|')
}

// ── Local UI state shared by the header icon and the dock (one per tab) ────────────────

interface UiState {
  /** The narrow-screen sheet is open. */
  sheet: boolean
  /** Pins someone else changed while the rows were not on screen (live, no read). */
  localChanged: ReadonlySet<string>
  /** The viewport is wide enough to dock. */
  wide: boolean
  /** What the dock knows, for the header icon: changed pins + unread mentions. */
  changed: number
  unreadMentions: number
  /** A dock is mounted in this app (the header icon renders nothing without one). */
  mounted: boolean
  /** Pins this tab marked seen, and when (an answer read before the mark landed stays quiet). */
  seenLocal: ReadonlyMap<string, number>
}

let ui: UiState = {
  sheet: false,
  localChanged: new Set(),
  changed: 0,
  unreadMentions: 0,
  mounted: false,
  seenLocal: new Map(),
  wide: typeof window === 'undefined' ? true : window.innerWidth >= WATCH_DOCK_MIN_VIEWPORT
}
const uiListeners = new Set<() => void>()
function setUi(patchUi: Partial<UiState>): void {
  ui = { ...ui, ...patchUi }
  for (const l of uiListeners) l()
}
function subscribeUi(fn: () => void): () => void {
  uiListeners.add(fn)
  if (uiListeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('resize', onResize)
    onResize()
  }
  return () => {
    uiListeners.delete(fn)
    if (uiListeners.size === 0 && typeof window !== 'undefined')
      window.removeEventListener('resize', onResize)
  }
}
function onResize(): void {
  const wide = window.innerWidth >= WATCH_DOCK_MIN_VIEWPORT
  if (wide !== ui.wide) setUi({ wide, ...(wide ? { sheet: false } : {}) })
}

export function useWatchUi(): UiState {
  return useSyncExternalStore(
    subscribeUi,
    () => ui,
    () => ui
  )
}
export const watchUi = {
  publish(counts: { changed: number; unreadMentions: number }) {
    if (counts.changed !== ui.changed || counts.unreadMentions !== ui.unreadMentions) setUi(counts)
  },
  setMounted(mounted: boolean) {
    if (mounted !== ui.mounted) setUi({ mounted })
  },
  openSheet: () => setUi({ sheet: true }),
  closeSheet: () => setUi({ sheet: false }),
  markLocal(keys: string[]) {
    if (keys.length === 0) return
    const next = new Set(ui.localChanged)
    for (const k of keys) next.add(k)
    if (next.size !== ui.localChanged.size) setUi({ localChanged: next })
  },
  noteSeen(keys: string[] | null, pins: string[]) {
    const next = new Map(ui.seenLocal)
    const now = Date.now()
    for (const k of keys ?? pins) next.set(k, now)
    setUi({ seenLocal: next })
  },
  clearLocal(keys?: string[]) {
    if (!keys) {
      if (ui.localChanged.size) setUi({ localChanged: new Set() })
      return
    }
    const next = new Set(ui.localChanged)
    for (const k of keys) next.delete(k)
    if (next.size !== ui.localChanged.size) setUi({ localChanged: next })
  }
}

// ── Queries + writes ─────────────────────────────────────────────────────────────

type Client = NonNullable<ReturnType<typeof useOptionalNivaroClient>>

function emptyPrefs(): WatchPrefs {
  return { pins: [], dock: WATCH_DOCK_DEFAULT, replies_seen_at: null, max: 50 }
}

/** The stored list (pins + dock). Null client (no provider) = an empty, inert list. */
export function useWatchPrefs(): { prefs: WatchPrefs; ready: boolean } {
  const client = useOptionalNivaroClient()
  const q = useQuery({
    queryKey: watchKeys.prefs,
    queryFn: () =>
      (client as Client)
        .request<{ data: WatchPrefs }>(get('/watch-list/prefs'))
        .then((r) => r.data),
    enabled: !!client,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1
  })
  return { prefs: q.data ?? emptyPrefs(), ready: q.isSuccess }
}

export interface WatchActions {
  isPinned: (collection: string, id: string | number) => boolean
  pin: (collection: string, id: string | number) => Promise<void>
  unpin: (collection: string, id: string | number) => Promise<void>
  toggle: (collection: string, id: string | number) => Promise<boolean>
  setDock: (patchDock: Partial<WatchDockPrefs>) => void
  reorder: (keys: string[]) => void
  markSeen: (keys?: string[]) => void
  full: boolean
}

/** Pin / unpin / dock writes, applied to the cache first (the click lands at once). */
export function useWatchActions(): WatchActions & { prefs: WatchPrefs } {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const { prefs } = useWatchPrefs()
  const pinned = useMemo(() => new Set(prefs.pins.map((p) => p.key)), [prefs.pins])

  const apply = useCallback(
    (fn: (p: WatchPrefs) => WatchPrefs) => {
      qc.setQueryData<WatchPrefs>(watchKeys.prefs, (old) => fn(old ?? emptyPrefs()))
    },
    [qc]
  )
  const settle = useCallback(
    (r: { data: WatchPrefs } | undefined) => {
      if (r?.data) qc.setQueryData(watchKeys.prefs, r.data)
    },
    [qc]
  )
  const write = useMutation({
    mutationFn: async (cmd: Parameters<Client['request']>[0]) =>
      (client as Client).request(cmd) as Promise<{ data: WatchPrefs }>,
    onSuccess: settle
  })
  const run = useCallback(
    async (cmd: Parameters<Client['request']>[0], fallback: string) => {
      if (!client) return
      try {
        await write.mutateAsync(cmd)
      } catch (err) {
        void qc.invalidateQueries({ queryKey: watchKeys.prefs })
        toastError(err, fallback)
        throw err
      }
    },
    [client, write, qc]
  )

  const pin = useCallback(
    async (collection: string, id: string | number) => {
      const key = pinKeyOf(collection, id)
      if (pinned.has(key)) return
      const now = new Date().toISOString()
      apply((p) => ({
        ...p,
        pins: [{ key, collection, id: String(id), pinned_at: now }, ...p.pins]
      }))
      await run(
        post('/watch-list/pins', { collection, id: String(id) }),
        'Could not add it to your watch list'
      )
    },
    [apply, pinned, run]
  )
  const unpin = useCallback(
    async (collection: string, id: string | number) => {
      const key = pinKeyOf(collection, id)
      apply((p) => ({ ...p, pins: p.pins.filter((x) => x.key !== key) }))
      watchUi.clearLocal([key])
      await run(
        del(`/watch-list/pins/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`),
        'Could not remove it from your watch list'
      )
    },
    [apply, run]
  )
  const toggle = useCallback(
    async (collection: string, id: string | number) => {
      const on = pinned.has(pinKeyOf(collection, id))
      if (on) await unpin(collection, id)
      else await pin(collection, id)
      return !on
    },
    [pinned, pin, unpin]
  )
  const setDock = useCallback(
    (patchDock: Partial<WatchDockPrefs>) => {
      apply((p) => ({ ...p, dock: { ...p.dock, ...patchDock } }))
      void run(patch('/watch-list/dock', patchDock), 'Could not save the watch list layout').catch(
        () => {}
      )
    },
    [apply, run]
  )
  const reorder = useCallback(
    (keys: string[]) => {
      apply((p) => {
        const by = new Map(p.pins.map((x) => [x.key, x]))
        const out = keys.map((k) => by.get(k)).filter((x): x is WatchPinRef => !!x)
        for (const x of p.pins) if (!keys.includes(x.key)) out.push(x)
        return { ...p, pins: out }
      })
      void run(put('/watch-list/order', { keys }), 'Could not save the new order').catch(() => {})
    },
    [apply, run]
  )
  const markSeen = useCallback(
    (keys?: string[]) => {
      watchUi.clearLocal(keys)
      watchUi.noteSeen(
        keys ?? null,
        prefs.pins.map((p) => p.key)
      )
      // The rows on screen lose their mark at once; the server's answer confirms it.
      qc.setQueriesData<{ rows?: WatchRowData[]; changed: string[] }>(
        { queryKey: ['watch-list', 'rows'] },
        (old) =>
          old
            ? {
                ...old,
                changed: keys ? old.changed.filter((k) => !keys.includes(k)) : [],
                rows: old.rows?.map((r) =>
                  r.change && (!keys || keys.includes(r.key))
                    ? { ...r, change: { ...r.change, changed: false, unseen: 0 } }
                    : r
                )
              }
            : old
      )
      qc.setQueriesData<{ changed: string[] }>({ queryKey: ['watch-list', 'summary'] }, (old) =>
        old ? { ...old, changed: keys ? old.changed.filter((k) => !keys.includes(k)) : [] } : old
      )
      if (!client) return
      void client
        .request<{ data: WatchPrefs }>(post('/watch-list/seen', keys ? { keys } : {}))
        .then(settle)
        .catch(() => {})
    },
    [client, qc, settle, prefs.pins]
  )

  return {
    prefs,
    isPinned: (c, id) => pinned.has(pinKeyOf(c, id)),
    pin,
    unpin,
    toggle,
    setDock,
    reorder,
    markSeen,
    full: prefs.pins.length >= prefs.max
  }
}

/** Is the event target a place where a typed letter is text, not a shortcut? */
export function typingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"]'
  )
}

/** Sort rows for the dock: "My order" keeps pin order. Pure; exported for tests. */
export function sortWatchRows(rows: WatchRowData[], sort: DockSort): WatchRowData[] {
  if (sort === 'mine') return rows
  const t = (s: string | null | undefined) => (s ? new Date(s).getTime() : Number.NaN)
  return [...rows].sort((a, z) => {
    if (a.available !== z.available) return a.available ? -1 : 1
    if (sort === 'changed') {
      const ta = t(a.change?.at ?? a.updated_at)
      const tz = t(z.change?.at ?? z.updated_at)
      return (Number.isNaN(tz) ? 0 : tz) - (Number.isNaN(ta) ? 0 : ta)
    }
    const da = t(a.sla?.due_at)
    const dz = t(z.sla?.due_at)
    if (Number.isNaN(da) && Number.isNaN(dz)) return 0
    if (Number.isNaN(da)) return 1
    if (Number.isNaN(dz)) return -1
    return da - dz
  })
}

/** "3 d", "5 h", "12 m" — a short span for the step timeline. */
export function spanText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} m`
  if (s < 86_400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} d`
}

/** The changed keys the dot counts: the server's word plus live marks since. Pure. */
export function changedKeys(
  server: string[] | undefined,
  local: ReadonlySet<string>,
  pinned: Set<string>
): string[] {
  const out = new Set<string>()
  for (const k of server ?? []) if (pinned.has(k)) out.add(k)
  for (const k of local) if (pinned.has(k)) out.add(k)
  return [...out]
}

/**
 * Rows as this tab knows them: a pin marked seen here after its newest change reads quiet even
 * when the answer on screen was read before the mark reached the server. Pure.
 */
export function withLocalSeen(
  rows: WatchRowData[],
  seenLocal: ReadonlyMap<string, number>
): WatchRowData[] {
  if (seenLocal.size === 0) return rows
  return rows.map((r) => {
    const at = seenLocal.get(r.key)
    if (!at || !r.change?.changed) return r
    if (new Date(r.change.at).getTime() > at) return r
    return { ...r, change: { ...r.change, changed: false, unseen: 0 } }
  })
}
