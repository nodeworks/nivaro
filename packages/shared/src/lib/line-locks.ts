import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { post } from './commands'
import { LIVE_ASPECTS, useLiveCollection } from './live'
import { type RowLock, useRowLocks } from './live-list'

/**
 * Line-level edit locks (realtime round 2, item 7). With the parent collection's
 * `summary_mode_rules.line_locks` on, the record's own lock covers its header
 * fields only and each LINE (a row of an inline grid — a record of its own
 * collection) is locked while one person edits it: two people can work on
 * different lines of the same record at once; a line someone else is editing
 * shows their name and is read-only until they leave it.
 *
 * It is the ordinary record lock on the line's own row (POST /item-locks/
 * <line collection>/<row id>/lock), so everything the record lock already does
 * holds: the 30 s lease with a 10 s beat (lock-presence.ts `lockIsLive`), the
 * server refusing someone else's write to a held line (409 RECORD_LOCKED from
 * the single-row write path), `$lock` notices on the line collection's feed.
 * The server stops the parent's lock from covering the lines
 * (edit-lock.ts `lineLockParents`).
 */

/** Matches the record lock: a 30 s lease, beaten every 10 s. */
export const LINE_LOCK_BEAT_MS = 10_000
/** Leaving a line lets its lock go after this pause — moving focus between two
 *  cells of the same line, or into a picker's popover, is not leaving it. */
export const LINE_LOCK_LEAVE_MS = 1_500
/** Someone else holds a line: re-read every so often in case a `$lock` notice was missed
 *  (a lapsed lease sends none). */
export const LINE_LOCK_RECHECK_MS = 20_000

export interface LineLockView {
  /** Someone else is editing this line: it is read-only here. */
  readOnly: boolean
  /** Their name ("Someone" when the server could not name them). */
  by: string | null
}

/** What one line looks like to this viewer. Exported for tests. */
export function lineLockView(
  locks: ReadonlyMap<string, Pick<RowLock, 'is_mine' | 'locked_by_name'>>,
  rowId: string | null | undefined,
  refused?: ReadonlyMap<string, string | null>
): LineLockView {
  if (!rowId) return { readOnly: false, by: null }
  const l = locks.get(String(rowId))
  if (l && !l.is_mine) return { readOnly: true, by: l.locked_by_name ?? 'Someone' }
  if (refused?.has(String(rowId)))
    return { readOnly: true, by: refused.get(String(rowId)) ?? 'Someone' }
  return { readOnly: false, by: null }
}

/**
 * Which lock to take and which to let go when the line being edited changes.
 * Saved lines only (a new, unsaved line has no row to lock). Exported for tests.
 */
export function lineLockMoves(
  held: string | null,
  editing: string | null
): { release: string | null; claim: string | null } {
  const isSaved = (id: string | null) => !!id && id !== 'new' && !id.startsWith('pending:')
  const want = isSaved(editing) ? editing : null
  if (held === want) return { release: null, claim: null }
  return { release: held, claim: want }
}

export interface LineLocks {
  enabled: boolean
  view: (rowId: string | null | undefined) => LineLockView
  /** Take the lock on a line before editing it. false = someone else holds it. */
  claim: (rowId: string) => Promise<boolean>
  /** Let go of the line this viewer holds (after LINE_LOCK_LEAVE_MS unless `now`). */
  release: (opts?: { now?: boolean }) => void
  /** The line this viewer holds right now. */
  held: string | null
}

const lockPath = (collection: unknown, id: string) =>
  `/item-locks/${encodeURIComponent(String(collection))}/${encodeURIComponent(id)}`

const NONE: LineLocks = {
  enabled: false,
  view: () => ({ readOnly: false, by: null }),
  claim: async () => true,
  release: () => {},
  held: null
}

interface LockRefusal {
  response?: { code?: string; locked_by_name?: string | null; data?: Record<string, unknown> }
  status?: number
}

/** The holder named by a 409 RECORD_LOCKED, or undefined when the error is something else. */
export function lockRefusalHolder(err: unknown): string | null | undefined {
  const r = (err as LockRefusal | null)?.response
  const body = (r?.data ?? r) as { code?: unknown; locked_by_name?: unknown } | undefined
  if (body?.code !== 'RECORD_LOCKED') return undefined
  return typeof body.locked_by_name === 'string' ? body.locked_by_name : null
}

export function useLineLocks(opts: {
  /** The line collection (the inline grid's related collection). */
  collection: string | null | undefined
  /** The saved lines on screen. */
  rowIds: string[]
  /** The parent collection has line locks on, and this grid is editable. */
  enabled: boolean
}): LineLocks {
  const { collection, enabled } = opts
  const client = useNivaroClient()
  const on = enabled && !!collection && !String(collection).startsWith('nivaro_')
  const [tick, setTick] = useState(0)
  useLiveCollection(
    on ? collection : null,
    (batch) => {
      if (batch.events.some((e) => (e.changed_fields ?? []).includes(LIVE_ASPECTS.lock)))
        setTick((n) => n + 1)
    },
    { enabled: on, includeOwn: true, debounceMs: 150 }
  )
  const locks = useRowLocks(on ? collection : null, on ? opts.rowIds : [], tick)
  // Lines a claim was refused on (the read may lag the refusal by a beat).
  const [refused, setRefused] = useState<Map<string, string | null>>(() => new Map())
  const anyOther = useMemo(() => [...locks.values()].some((l) => !l.is_mine), [locks])
  useEffect(() => {
    if (!on || (!anyOther && refused.size === 0)) return
    const t = setInterval(() => {
      setRefused(new Map())
      setTick((n) => n + 1)
    }, LINE_LOCK_RECHECK_MS)
    return () => clearInterval(t)
  }, [on, anyOther, refused.size])

  const [held, setHeld] = useState<string | null>(null)
  const heldRef = useRef<string | null>(null)
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const leaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopBeat = useCallback(() => {
    if (beatRef.current) clearInterval(beatRef.current)
    beatRef.current = null
  }, [])
  const letGo = useCallback(
    (id: string, viaKeepalive = false) => {
      stopBeat()
      if (heldRef.current === id) {
        heldRef.current = null
        setHeld(null)
      }
      if (viaKeepalive && typeof fetch === 'function') {
        try {
          const token = client.getToken?.()
          const base = (client as { url?: string }).url ?? ''
          void fetch(`${base}/api${lockPath(collection, id)}/lock/release`, {
            method: 'POST',
            keepalive: true,
            credentials: token ? 'omit' : 'include',
            headers: token ? { Authorization: `Bearer ${token}` } : {}
          }).catch(() => {})
        } catch {
          /* the lease frees it */
        }
        return
      }
      void client.request(post(`${lockPath(collection, id)}/lock/release`, {})).catch(() => {})
    },
    [client, collection, stopBeat]
  )

  const claim = useCallback(
    async (id: string): Promise<boolean> => {
      if (!on) return true
      if (leaveRef.current) {
        clearTimeout(leaveRef.current)
        leaveRef.current = null
      }
      if (heldRef.current === id) return true
      const prev = heldRef.current
      if (prev) letGo(prev)
      const theirs = locks.get(id)
      if (theirs && !theirs.is_mine) return false
      try {
        await client.request(
          post(`${lockPath(collection, id)}/lock`, { beat_ms: LINE_LOCK_BEAT_MS })
        )
      } catch (err) {
        const by = lockRefusalHolder(err)
        if (by !== undefined) {
          setRefused((m) => new Map(m).set(id, by))
          setTick((n) => n + 1)
          return false
        }
        // Offline / an error: edit anyway — the server still refuses a held line on save.
        return true
      }
      heldRef.current = id
      setHeld(id)
      setRefused((m) => {
        if (!m.has(id)) return m
        const next = new Map(m)
        next.delete(id)
        return next
      })
      stopBeat()
      beatRef.current = setInterval(() => {
        void client
          .request(post(`${lockPath(collection, id)}/heartbeat`, { beat_ms: LINE_LOCK_BEAT_MS }))
          .catch(() => {})
      }, LINE_LOCK_BEAT_MS)
      return true
    },
    [on, client, collection, locks, letGo, stopBeat]
  )

  const release = useCallback(
    (o: { now?: boolean } = {}) => {
      const id = heldRef.current
      if (!id) return
      if (leaveRef.current) clearTimeout(leaveRef.current)
      if (o.now) {
        leaveRef.current = null
        letGo(id)
        return
      }
      leaveRef.current = setTimeout(() => {
        leaveRef.current = null
        if (heldRef.current === id) letGo(id)
      }, LINE_LOCK_LEAVE_MS)
    },
    [letGo]
  )

  // A hidden tab or a page going away lets go at once (the lease would, in 30 s).
  useEffect(() => {
    if (!on || typeof document === 'undefined') return
    const away = () => {
      if (document.visibilityState === 'hidden' && heldRef.current) letGo(heldRef.current, true)
    }
    const gone = () => {
      if (heldRef.current) letGo(heldRef.current, true)
    }
    document.addEventListener('visibilitychange', away)
    window.addEventListener('pagehide', gone)
    return () => {
      document.removeEventListener('visibilitychange', away)
      window.removeEventListener('pagehide', gone)
    }
  }, [on, letGo])
  // Unmount (record closed, grid gone): let go.
  useEffect(
    () => () => {
      if (leaveRef.current) clearTimeout(leaveRef.current)
      if (heldRef.current) letGo(heldRef.current)
    },
    [letGo]
  )

  const view = useCallback(
    (rowId: string | null | undefined) => lineLockView(locks, rowId, refused),
    [locks, refused]
  )
  if (!on) return NONE
  return { enabled: true, view, claim, release, held }
}

/** Set by the record form: the record's lines lock one at a time (its line grids read it). */
export const LineLockContext = createContext(false)
