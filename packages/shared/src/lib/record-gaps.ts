/**
 * Missed-change detection per RECORD (realtime 23), beside the per-room tracker (room-gaps.ts).
 *
 * The server numbers every change of one record (`_iseq`, a Redis counter per collection + id
 * taken in the same step as the journal's own numbers; a merged burst carries
 * `_iseqs {id: [lowest, highest]}`). This tracker keeps the last number it saw per record and,
 * when one skips, waits a moment (events from two servers can arrive out of order, and the room
 * catch-up may still replay the missing one) and then asks the host to re-read THAT record —
 * never the whole page. The host turns the ask into the same `collection:update {collection,
 * item}` notice a record-room refetch uses, so lists re-read just that row and record pages just
 * that record, as the viewer.
 *
 * Unlike the room counters, these survive a reconnect: a reconnect whose catch-up could not be
 * verified leaves the room tracker blind to what it missed, but the next change of a record on
 * screen still shows whether one was lost on the way.
 *
 * Anything it cannot judge is forgotten, never guessed: an event about a record without a
 * number (an older server, a durable-table replay), a collection-wide burst, a room the host
 * refetched or left. Bounded to `maxRecords` records (least recently seen go first).
 */

export interface RecordRef {
  collection: string
  item: string
}

export interface RecordGapOptions {
  /** Re-read these records (each one missed a change). */
  refetch: (records: RecordRef[]) => void
  /** How long a skipped number may still arrive before the record is re-read (default 4000 ms). */
  graceMs?: number
  /** Records remembered at most (default 2000). */
  maxRecords?: number
}

export interface RecordGapTracker {
  /** Every live (or replayed) event; only `collection:update` payloads matter. */
  observe(event: string, payload: unknown): void
  /** Forget records of these collections (all when omitted): refetched, left or joined again. */
  forget(collections?: string[]): void
  /** Counts since the tracker started (diagnostics). */
  stats(): { gaps: number; missed: number; refetched: number; tracked: number }
}

interface Pending {
  missing: Set<number>
  timer: ReturnType<typeof setTimeout> | null
}

/** More missing than this for one record is still one re-read; the set stops growing here. */
const MAX_TRACKED_MISSING = 64

const SEP = '\u0000'

export function createRecordGapTracker(opts: RecordGapOptions): RecordGapTracker {
  const grace = opts.graceMs ?? 4000
  const max = opts.maxRecords ?? 2000
  /** key → highest number seen. Map order = least recently seen first. */
  const last = new Map<string, number>()
  const pending = new Map<string, Pending>()
  const counts = { gaps: 0, missed: 0, refetched: 0 }

  const settle = (key: string) => {
    const g = pending.get(key)
    if (!g) return
    if (g.timer) clearTimeout(g.timer)
    pending.delete(key)
  }

  const drop = (key: string) => {
    settle(key)
    last.delete(key)
  }

  const remember = (key: string, n: number) => {
    last.delete(key)
    last.set(key, n)
    while (last.size > max) {
      const oldest = last.keys().next().value as string | undefined
      if (oldest == null) break
      drop(oldest)
    }
  }

  const due = (key: string) => {
    const g = pending.get(key)
    if (!g) return
    g.timer = null
    pending.delete(key)
    if (g.missing.size === 0) return
    const i = key.indexOf(SEP)
    counts.refetched++
    opts.refetch([{ collection: key.slice(0, i), item: key.slice(i + 1) }])
  }

  const note = (key: string, lo: number, hi: number) => {
    const prev = last.get(key)
    if (prev == null) {
      remember(key, hi)
      return
    }
    // A late arrival fills its place in a waiting gap.
    const g = pending.get(key)
    if (g) {
      for (let n = lo; n <= hi; n++) g.missing.delete(n)
      if (g.missing.size === 0) settle(key)
    }
    if (hi <= prev) {
      // The record's counter restarted (it lapses after an idle hour): a new baseline.
      if (hi < prev && lo === 1) {
        settle(key)
        remember(key, hi)
      }
      return
    }
    if (lo > prev + 1) {
      const gap = pending.get(key) ?? { missing: new Set<number>(), timer: null }
      const missed = lo - prev - 1
      counts.gaps++
      counts.missed += missed
      for (let n = prev + 1; n < lo && gap.missing.size < MAX_TRACKED_MISSING; n++)
        gap.missing.add(n)
      pending.set(key, gap)
      if (!gap.timer) gap.timer = setTimeout(() => due(key), grace)
    }
    remember(key, hi)
  }

  const forget = (collections?: string[]) => {
    if (!collections) {
      for (const k of [...pending.keys()]) settle(k)
      last.clear()
      return
    }
    const prefixes = collections.map((c) => `${c}${SEP}`)
    for (const k of [...last.keys(), ...pending.keys()])
      if (prefixes.some((pre) => k.startsWith(pre))) drop(k)
  }

  return {
    observe(event, payload) {
      if (event !== 'collection:update' || !payload || typeof payload !== 'object') return
      const p = payload as {
        collection?: unknown
        item?: unknown
        items?: unknown
        many?: unknown
        _iseq?: unknown
        _iseqs?: unknown
      }
      if (typeof p.collection !== 'string' || !p.collection) return
      const c = p.collection
      if (typeof p.item === 'string' || typeof p.item === 'number') {
        const key = `${c}${SEP}${String(p.item)}`
        if (typeof p._iseq === 'number' && p._iseq > 0) note(key, p._iseq, p._iseq)
        else drop(key)
        return
      }
      if (Array.isArray(p.items)) {
        const ranges =
          p._iseqs && typeof p._iseqs === 'object' ? (p._iseqs as Record<string, unknown>) : {}
        for (const id of p.items) {
          if (typeof id !== 'string' && typeof id !== 'number') continue
          const key = `${c}${SEP}${String(id)}`
          const r = ranges[String(id)]
          if (
            Array.isArray(r) &&
            typeof r[0] === 'number' &&
            typeof r[1] === 'number' &&
            r[0] > 0 &&
            r[1] >= r[0]
          )
            note(key, r[0], r[1])
          else drop(key)
        }
        return
      }
      // A collection-wide notice (`many`, or no ids): every list on it refetches anyway.
      forget([c])
    },
    forget,
    stats() {
      return { ...counts, tracked: last.size }
    }
  }
}

/** The notice a re-read hands the live listeners: an update of that one record. */
export function recordRefetchEvent(r: RecordRef): {
  event: 'collection:update'
  payload: Record<string, unknown>
} {
  return { event: 'collection:update', payload: { collection: r.collection, item: r.item } }
}
