import { useQueries, useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../context'
import { post } from './commands'
import { pickerOptionsMeta } from './live-pickers'
import { liveQueryMeta } from './live-queries'

/**
 * Status badges in pickers (realtime round 6, item 12) — "On hold", "Closed", "Over budget",
 * "Inactive", "Hidden from pickers" beside a record in a dropdown, on a picked value and on a chip.
 *
 * The server decides (api routes/picker-badges.ts): per-collection config, read AS THE VIEWER,
 * rules on columns the viewer cannot read skipped. This module only asks, batches and caches:
 *
 * - Every picker on a screen asks through one batcher per client: ids asked within BATCH_MS go
 *   out as one POST per collection (≤ MAX_IDS each).
 * - A collection that answers "no rules" is not asked again for NONE_TTL_MS.
 * - Option lists use the picker's own live meta (`staleOnly`, live-pickers.ts): a change marks
 *   the badges stale and they re-read the next time the dropdown opens — an open list never
 *   shifts. A picked value / chip is a record query: a write to THAT record naming a column the
 *   badges read (or `$state` / `$picker`) re-reads it quietly, coalesced by the live bridge.
 */

export type PickerBadgeTone = 'neutral' | 'amber' | 'red' | 'muted'

export interface PickerBadge {
  key: string
  label: string
  tone: PickerBadgeTone
}

export const BATCH_MS = 30
export const MAX_IDS = 200
export const NONE_TTL_MS = 5 * 60_000

type Answer = { data: Record<string, PickerBadge[]>; meta?: { rules?: number; watch?: string[] } }
type Request = (collection: string, ids: string[]) => Promise<Answer>

const noneUntil = new Map<string, number>()
const watchOf = new Map<string, string[]>()

/** The columns / aspects whose change can move this collection's badges (once known). */
export function badgeWatchFor(collection: string): string[] | undefined {
  return watchOf.get(collection)
}

/** Whether this collection told us lately that it has no badges for this viewer. */
export function knownNoBadges(collection: string, now = Date.now()): boolean {
  const until = noneUntil.get(collection)
  return until !== undefined && until > now
}

/** For tests and after an admin saves the setting. */
export function forgetPickerBadgeRules(collection?: string) {
  if (collection) {
    noneUntil.delete(collection)
    watchOf.delete(collection)
  } else {
    noneUntil.clear()
    watchOf.clear()
  }
}

export interface BadgeBatcher {
  load(collection: string, ids: string[]): Promise<Record<string, PickerBadge[]>>
}

/** Merge asks made within BATCH_MS into one request per collection (exported for tests). */
export function createBadgeBatcher(request: Request, waitMs = BATCH_MS): BadgeBatcher {
  const pending = new Map<
    string,
    { ids: Set<string>; waiters: Array<(r: Record<string, PickerBadge[]>) => void> }
  >()
  const flush = async (collection: string) => {
    const p = pending.get(collection)
    pending.delete(collection)
    if (!p) return
    const ids = [...p.ids]
    const out: Record<string, PickerBadge[]> = {}
    try {
      for (let i = 0; i < ids.length; i += MAX_IDS) {
        const r = await request(collection, ids.slice(i, i + MAX_IDS))
        Object.assign(out, r.data ?? {})
        if (r.meta?.rules === 0) noneUntil.set(collection, Date.now() + NONE_TTL_MS)
        else noneUntil.delete(collection)
        if (Array.isArray(r.meta?.watch)) watchOf.set(collection, r.meta.watch)
        if (r.meta?.rules === 0) break
      }
    } catch {
      // Badges are a hint: a failed read shows none.
    }
    for (const w of p.waiters) w(out)
  }
  return {
    load(collection, ids) {
      if (ids.length === 0 || knownNoBadges(collection)) return Promise.resolve({})
      let p = pending.get(collection)
      if (!p) {
        p = { ids: new Set(), waiters: [] }
        pending.set(collection, p)
        setTimeout(() => void flush(collection), waitMs)
      }
      for (const id of ids) p.ids.add(id)
      const entry = p
      return new Promise((resolve) => {
        entry.waiters.push((all) => {
          const mine: Record<string, PickerBadge[]> = {}
          for (const id of ids) if (all[id]) mine[id] = all[id]
          resolve(mine)
        })
      })
    }
  }
}

const batchers = new WeakMap<object, BadgeBatcher>()

function useBatcher(): BadgeBatcher {
  const client = useNivaroClient()
  let b = batchers.get(client)
  if (!b) {
    b = createBadgeBatcher((collection, ids) =>
      client.request<Answer>(post('/picker-badges', { collection, ids }))
    )
    batchers.set(client, b)
  }
  return b
}

const EMPTY: Record<string, PickerBadge[]> = {}

/**
 * Badges for the options a dropdown lists. One cached answer per record (so a new search only
 * asks about ids not seen yet), batched into one request; re-read on the next open after a change.
 */
export function useOptionBadges(
  collection: string | null | undefined,
  ids: Array<string | number>,
  enabled = true
): Record<string, PickerBadge[]> {
  const batcher = useBatcher()
  const list = [...new Set(ids.map(String))]
  const on = enabled && !!collection && list.length > 0 && !knownNoBadges(collection)
  const meta = pickerOptionsMeta(collection)
  const results = useQueries({
    queries: (on ? list : []).map((id) => ({
      queryKey: ['picker-badges-opt', collection, id],
      queryFn: () =>
        batcher.load(collection as string, [id]).then((r) => r[id] ?? ([] as PickerBadge[])),
      staleTime: 30_000,
      meta
    }))
  })
  if (!on) return EMPTY
  const out: Record<string, PickerBadge[]> = {}
  results.forEach((r, i) => {
    if (r.data?.length) out[list[i]] = r.data
  })
  return out
}

/** Badges for one picked value (a field's value or a chip), live for that record. */
export function useRecordBadges(
  collection: string | null | undefined,
  id: string | number | null | undefined,
  enabled = true
): PickerBadge[] {
  const batcher = useBatcher()
  const key = id == null || id === '' ? '' : String(id)
  const on = enabled && !!collection && key !== '' && !knownNoBadges(collection)
  const watch = collection ? badgeWatchFor(collection) : undefined
  const { data } = useQuery({
    queryKey: ['picker-badges', collection, key],
    queryFn: () => batcher.load(collection as string, [key]),
    enabled: on,
    staleTime: 30_000,
    meta: collection
      ? liveQueryMeta({
          record: { collection, id: key },
          ...(watch ? { fields: watch.filter((f) => !f.startsWith('$')) } : {}),
          aspects: ['$state', '$picker']
        })
      : undefined
  })
  return data?.[key] ?? []
}
