import { useQueries } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { post } from './commands'
import { type LiveBatch, useLiveCollection } from './live'
import { serverNow } from './server-clock'

/**
 * A list's selection, watched while it is held (realtime round 8, items 5–7):
 *
 * - it remembers when each row was picked (server time) — `useSelectionPicks`;
 * - a live write by someone else to a picked row marks it (ids + field names from the
 *   transport, never values) — `useSelectionLiveMarks`; marks are coalesced (one per ~1 s);
 * - the marked rows (or, once a bulk form opens, all of them — the live path is quiet with
 *   live updates Off) are asked of `POST /bulk-preflight/changes` AS THE VIEWER: who, which
 *   readable fields, a move, a delete — `useSelectionChanges`;
 * - the bar's count and sums are recomputed from the rows as they are now — `selectionSums`.
 *
 * Who has the rows open / is editing them comes from the list's own presence and lock reads
 * (`useRowPresence`, `useRowLocks`), which already judge each row as the viewer and name only
 * people the presence rules let the viewer see.
 */

/** `collection:id` — one row of a (possibly multi-collection) selection. */
export const selKey = (collection: string, id: string | number) => `${collection}:${id}`

export function splitSelKey(key: string): { collection: string; id: string } {
  const i = key.indexOf(':')
  return { collection: key.slice(0, i), id: key.slice(i + 1) }
}

/** Most rows asked about in one check (the server's cap). */
export const SELECTION_CHECK_MAX = 200

// ── Picks ────────────────────────────────────────────────────────────────

/** The picks after a selection change: new rows stamped `now`, dropped rows forgotten. */
export function reconcilePicks(
  prev: ReadonlyMap<string, number>,
  keys: readonly string[],
  now: number
): Map<string, number> {
  const next = new Map<string, number>()
  for (const k of keys) next.set(k, prev.get(k) ?? now)
  return next
}

/** When each selected row was picked; `restamp(keys)` = "seen as it is now" (Continue). */
export function useSelectionPicks(keys: readonly string[]): {
  picks: ReadonlyMap<string, number>
  restamp: (keys: readonly string[]) => void
} {
  const [picks, setPicks] = useState<Map<string, number>>(() => new Map())
  const keysKey = keys.join('\u0001')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keysKey stands for keys
  useEffect(() => {
    setPicks((prev) => {
      const next = reconcilePicks(prev, keys, serverNow())
      if (next.size === prev.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev
      return next
    })
  }, [keysKey])
  const restamp = useCallback((ks: readonly string[]) => {
    const now = serverNow()
    setPicks((prev) => {
      const next = new Map(prev)
      for (const k of ks) if (next.has(k)) next.set(k, now)
      return next
    })
  }, [])
  return { picks, restamp }
}

// ── Live marks ───────────────────────────────────────────────────────────

/** A batch that changed a record itself: its own fields, a move, a create or delete. */
export function batchChangesRecord(
  batch: Pick<LiveBatch, 'changedFields' | 'aspectsOnly' | 'deleted' | 'created'>
): boolean {
  if (batch.deleted || batch.created) return true
  if (!batch.aspectsOnly) return true
  return (batch.changedFields ?? []).includes('$state')
}

/**
 * Picked rows someone else wrote to while they were selected (keys). Own writes never mark;
 * a bulk write that named no ids marks every picked row of its collection (the check sorts
 * out which really changed). Clears when the selection does.
 */
export function useSelectionLiveMarks(
  collections: readonly string[],
  picks: ReadonlyMap<string, number>
): { marked: ReadonlySet<string>; clear: (keys: readonly string[]) => void } {
  const [marked, setMarked] = useState<Set<string>>(() => new Set())
  const picksRef = useRef(picks)
  picksRef.current = picks
  useEffect(() => {
    setMarked((prev) => {
      const kept = [...prev].filter((k) => picks.has(k))
      return kept.length === prev.size ? prev : new Set(kept)
    })
  }, [picks])
  const onBatch = useCallback((batch: LiveBatch) => {
    if (!batchChangesRecord(batch)) return
    const hits: string[] = []
    for (const ev of batch.events) {
      const c = String(ev.collection ?? '')
      const id = String(ev.item ?? '')
      if (!c) continue
      if (id === '*') {
        for (const k of picksRef.current.keys()) if (splitSelKey(k).collection === c) hits.push(k)
      } else {
        const k = selKey(c, id)
        if (picksRef.current.has(k)) hits.push(k)
      }
    }
    if (hits.length === 0) return
    setMarked((prev) => {
      const next = new Set(prev)
      for (const h of hits) next.add(h)
      return next.size === prev.size ? prev : next
    })
  }, [])
  useLiveCollection(picks.size > 0 ? [...collections] : null, onBatch, {
    debounceMs: 1000,
    enabled: picks.size > 0
  })
  const clear = useCallback((ks: readonly string[]) => {
    setMarked((prev) => {
      const next = new Set(prev)
      for (const k of ks) next.delete(k)
      return next
    })
  }, [])
  return { marked, clear }
}

// ── The check (as the viewer) ────────────────────────────────────────────

export interface SelectionChange {
  at: string
  by: string[]
  fields: string[]
  fields_unknown?: boolean
  moved_to?: string | null
  deleted?: boolean
}

interface ChangesAnswer {
  changes: Record<string, SelectionChange>
  labels: {
    records: Record<string, string | null>
    users: Record<string, string>
    fields: Record<string, string>
  }
}

export interface ChangedRow extends SelectionChange {
  key: string
  collection: string
  id: string
  /** The record as the viewer may call it (null = no label). */
  label: string | null
  /** People by name, newest first ("someone" when a name is not to be had). */
  names: string[]
  /** Field labels, as the viewer may read them. */
  fieldLabels: string[]
}

/**
 * Which picked rows someone else changed since they were picked. Asks only for `keys`
 * (≤ SELECTION_CHECK_MAX), one call per collection, re-asked when the keys, their pick
 * times or `nonce` change. Nothing is asked for an empty list.
 */
export function useSelectionChanges(
  keys: readonly string[],
  picks: ReadonlyMap<string, number>,
  nonce = 0
): { rows: ChangedRow[]; checking: boolean } {
  const client = useOptionalNivaroClient()
  const groups = useMemo(() => {
    const by = new Map<string, Array<{ id: string; since: number }>>()
    for (const k of keys.slice(0, SELECTION_CHECK_MAX)) {
      const since = picks.get(k)
      if (since == null) continue
      const { collection, id } = splitSelKey(k)
      const list = by.get(collection) ?? []
      list.push({ id, since })
      by.set(collection, list)
    }
    return [...by.entries()].slice(0, 12)
  }, [keys, picks])
  const results = useQueries({
    queries: groups.map(([collection, items]) => ({
      queryKey: [
        'bulk-selection-changes',
        collection,
        items.map((i) => `${i.id}@${i.since}`).join(','),
        nonce
      ],
      queryFn: () =>
        client!
          .request<{ data: ChangesAnswer }>(
            post('/bulk-preflight/changes', {
              collection,
              items: items.map((i) => ({ id: i.id, since: new Date(i.since).toISOString() }))
            })
          )
          .then((r) => r.data),
      enabled: !!client && items.length > 0,
      staleTime: 10_000,
      retry: false
    }))
  })
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')
  const checking = results.some((r) => r.isFetching)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stamp string is the dependency (useQueries returns a fresh array each render)
  const rows = useMemo(() => {
    const out: ChangedRow[] = []
    results.forEach((r, i) => {
      const collection = groups[i]?.[0]
      const ans = r.data
      if (!collection || !ans) return
      out.push(...changedRowsOf(collection, ans))
    })
    return out.sort((a, b) => b.at.localeCompare(a.at))
  }, [stamp, groups])
  return { rows, checking }
}

/** The answer as display rows (exported for tests). */
export function changedRowsOf(collection: string, ans: ChangesAnswer): ChangedRow[] {
  return Object.entries(ans.changes ?? {}).map(([id, c]) => ({
    ...c,
    key: selKey(collection, id),
    collection,
    id,
    label: ans.labels?.records?.[`${collection}:${id}`] ?? null,
    names: c.by.map(
      (u) =>
        ans.labels?.users?.[u] ??
        ans.labels?.users?.[u.toUpperCase()] ??
        ans.labels?.users?.[u.toLowerCase()] ??
        'someone'
    ),
    fieldLabels: c.fields.map((f) => ans.labels?.fields?.[`${collection}.${f}`] ?? titleWords(f))
  }))
}

function titleWords(s: string): string {
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ── Words ────────────────────────────────────────────────────────────────

/** "Beth", "Beth and Sam", "Beth, Sam and 2 others". */
export function namesText(names: readonly string[], others = 0): string {
  const list = [...new Set(names.filter(Boolean))]
  const extra = others + Math.max(0, list.length - 2)
  const shown = list.slice(0, 2)
  if (shown.length === 0) return others > 0 ? `${others} ${others === 1 ? 'person' : 'people'}` : ''
  if (extra === 0) return shown.length === 1 ? shown[0] : `${shown[0]} and ${shown[1]}`
  return `${shown.join(', ')} and ${extra} other${extra === 1 ? '' : 's'}`
}

export interface OpenRow {
  key: string
  /** Named people (visible to the viewer) with it open or editing it. */
  names: string[]
  /** Others there the viewer may not see by name. */
  unnamed: number
  /** Someone holds the edit lock. */
  editing: boolean
}

/** "2 of these are open by Beth right now" / "1 of these is being edited by Sam". */
export function openNoticeText(rows: readonly OpenRow[], total: number): string | null {
  if (rows.length === 0) return null
  const names = rows.flatMap((r) => r.names)
  const unnamed = Math.max(0, ...rows.map((r) => r.unnamed))
  const who = names.length > 0 ? namesText(names) : unnamed > 1 ? `${unnamed} people` : 'someone'
  const n = rows.length
  const subject = total === n && n === 1 ? 'This one' : `${n} of these`
  const verb = n === 1 ? 'is' : 'are'
  const editingAll = rows.every((r) => r.editing)
  return editingAll
    ? `${subject} ${verb} being edited by ${who} right now`
    : `${subject} ${verb} open by ${who} right now`
}

/** "3 selected rows changed since you picked them". */
export function changedNoticeText(n: number): string | null {
  if (n <= 0) return null
  return n === 1
    ? '1 selected row changed since you picked it'
    : `${n} selected rows changed since you picked them`
}

/** "Beth changed Amount and Status" / "Beth moved it to Finance" / "Beth deleted it". */
export function changeLineText(
  row: Pick<ChangedRow, 'names' | 'fieldLabels' | 'fields_unknown' | 'moved_to' | 'deleted'>
): string {
  const who = namesText(row.names) || 'Someone'
  const Who = who.charAt(0).toUpperCase() + who.slice(1)
  if (row.deleted) return `${Who} deleted it`
  const parts: string[] = []
  if (row.moved_to !== undefined)
    parts.push(row.moved_to ? `moved it to ${row.moved_to}` : 'moved it')
  if (row.fieldLabels.length > 0) parts.push(`changed ${listText(row.fieldLabels)}`)
  else if (row.fields_unknown && parts.length === 0) parts.push('changed it')
  return `${Who} ${parts.join(' and ') || 'changed it'}`
}

function listText(items: readonly string[]): string {
  const u = [...new Set(items)]
  if (u.length === 1) return u[0]
  if (u.length <= 3) return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`
  return `${u.slice(0, 2).join(', ')} and ${u.length - 2} other fields`
}

// ── Sums ─────────────────────────────────────────────────────────────────

export interface SelectionSum {
  key: string
  sum: number
  /** Rows that held a number for it. */
  counted: number
}

const num = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

/**
 * The selection's sums over `columns`, from the rows the list holds (a selected row not on
 * screen counts with its last-known values; `known` says how many rows that is).
 */
export function selectionSums(
  rows: ReadonlyArray<Record<string, unknown> | undefined>,
  columns: readonly string[],
  read: (row: Record<string, unknown>, key: string) => unknown = (r, k) => r[k]
): { sums: SelectionSum[]; known: number } {
  const present = rows.filter((r): r is Record<string, unknown> => !!r)
  const sums = columns.map((key) => {
    let sum = 0
    let counted = 0
    for (const r of present) {
      const n = num(read(r, key))
      if (n == null) continue
      sum += n
      counted++
    }
    return { key, sum: Math.round(sum * 100) / 100, counted }
  })
  return { sums: sums.filter((s) => s.counted > 0), known: present.length }
}

/**
 * Last-known row values for the selected ids: the rows on screen win, rows that scrolled off
 * the page keep their last values, unselected rows are forgotten.
 */
export function useSelectedRowMemory<R extends Record<string, unknown>>(
  rows: readonly R[],
  idOf: (row: R) => string,
  selected: readonly string[]
): R[] {
  const mem = useRef(new Map<string, R>())
  const want = new Set(selected)
  for (const r of rows) {
    const id = idOf(r)
    if (want.has(id)) mem.current.set(id, r)
  }
  for (const k of [...mem.current.keys()]) if (!want.has(k)) mem.current.delete(k)
  return selected.map((id) => mem.current.get(id)).filter((r): r is R => !!r)
}
