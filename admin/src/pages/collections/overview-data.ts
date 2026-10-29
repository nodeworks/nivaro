import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNavFavorites } from '@/layouts/FavoritesNav'
import { api } from '@/lib/api'
import type { CollectionSummary, OverviewStats } from './types'

/** Facts for every collection (admin only; `enabled` false for others — no request). */
export function useOverviewStats(enabled: boolean) {
  return useQuery<OverviewStats>({
    queryKey: ['collections-overview-stats'],
    queryFn: () => api.get('/collections/overview-stats').then((r) => r.data.data ?? {}),
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

/** One collection's hover-card summary, fetched only while `enabled` (the card is open). */
export function useCollectionSummary(collection: string, enabled: boolean) {
  return useQuery<CollectionSummary>({
    queryKey: ['collection-summary', collection],
    queryFn: () =>
      api.get(`/collections/${encodeURIComponent(collection)}/summary`).then((r) => r.data.data),
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

// ─── Your own use (this browser) ───────────────────────────────────────────────

const USAGE_KEY = 'nvr_collections_usage'
const MAX_RECENT = 12

interface Usage {
  /** Newest first. */
  recent: string[]
  counts: Record<string, number>
}

function readUsage(): Usage {
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_KEY) ?? 'null') as Usage | null
    if (raw && Array.isArray(raw.recent) && raw.counts && typeof raw.counts === 'object')
      return { recent: raw.recent.map(String), counts: raw.counts }
  } catch {
    /* private window / bad JSON */
  }
  return { recent: [], counts: {} }
}

/** Remember that this person opened a collection from the page (Recent + Most used). */
export function recordCollectionOpen(collection: string): void {
  const u = readUsage()
  const recent = [collection, ...u.recent.filter((c) => c !== collection)].slice(0, MAX_RECENT)
  const counts = { ...u.counts, [collection]: (u.counts[collection] ?? 0) + 1 }
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify({ recent, counts }))
  } catch {
    /* storage off */
  }
}

/** Read once per page visit (a click navigates away, so nothing goes stale while shown). */
export function useCollectionUsage(): Usage {
  const [usage] = useState(readUsage)
  return usage
}

// ─── Pinned = sidebar favorites ───────────────────────────────────────────────

/**
 * A pinned collection is a sidebar favorite whose path is /collections/<name>
 * (users.preferences.nav_favorites), so pinning here also puts it in the
 * sidebar's Favorites and follows the person between machines.
 */
export function usePinnedCollections() {
  const { favorites, save } = useNavFavorites()
  const pinned = useMemo(() => {
    const set = new Set<string>()
    for (const f of favorites.items) {
      const m = /^\/collections\/([^/?#]+)$/.exec(f.path)
      if (m) set.add(decodeURIComponent(m[1]))
    }
    return set
  }, [favorites])
  const toggle = useCallback(
    async (collection: string, label: string) => {
      const path = `/collections/${encodeURIComponent(collection)}`
      const has = favorites.items.some((f) => f.path === path)
      if (!has && favorites.items.length >= 60) {
        toast.error('Favorites hold up to 60 pages — remove one first')
        return
      }
      await save(
        has
          ? { ...favorites, items: favorites.items.filter((f) => f.path !== path) }
          : { ...favorites, items: [...favorites.items, { label, path, group: null }] },
        has ? `Unpinned ${label}` : `Pinned ${label}`
      )
    },
    [favorites, save]
  )
  return { pinned, toggle }
}

// ─── Per-person page preferences (this browser) ───────────────────────────────

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage off */
  }
}

/** Move collections into a folder (or out of every folder with `null`). */
export async function moveCollections(names: string[], group: string | null): Promise<void> {
  for (const name of names) await api.patch(`/collections/${encodeURIComponent(name)}`, { group })
}
