import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import type {
  CollectionFavorites,
  CollectionSummary,
  DirectoryCollection,
  HeavyListFlags,
  OverviewStats
} from './types'

/**
 * Reads behind the collections directory, through the host's Nivaro client. The query keys
 * match the shapes other screens cache under them (`['collections']` = the raw array).
 */

export const DIRECTORY_KEYS = {
  collections: ['collections'] as const,
  stats: ['collections-overview-stats'] as const,
  heavyLists: ['collections-list-weight'] as const,
  summary: (collection: string) => ['collection-summary', collection] as const
}

/** Every registered collection (GET /api/collections), the raw array. */
export function useDirectoryCollections() {
  const client = useNivaroClient()
  return useQuery<DirectoryCollection[]>({
    queryKey: DIRECTORY_KEYS.collections,
    queryFn: () =>
      client.request<{ data: DirectoryCollection[] }>(get('/collections')).then((r) => r.data ?? [])
  })
}

/** Facts for every collection (admin only; `enabled` false for others — no request). */
export function useOverviewStats(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<OverviewStats>({
    queryKey: DIRECTORY_KEYS.stats,
    queryFn: () =>
      client
        .request<{ data: OverviewStats }>(get('/collections/overview-stats'))
        .then((r) => r.data ?? {}),
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

/**
 * Collections whose list opens on a heavy "link to many" column (admin only; `enabled` false
 * for others — no request). Measured on the server and cached there for an hour, so a quiet
 * read: it never blocks the page and a failure just shows no badges.
 */
export function useHeavyListFlags(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<HeavyListFlags>({
    queryKey: DIRECTORY_KEYS.heavyLists,
    queryFn: () =>
      client
        .request<{ data: HeavyListFlags }>(get('/collections/list-weight'))
        .then((r) => r.data ?? {}),
    enabled,
    staleTime: 10 * 60_000,
    retry: false
  })
}

/** One collection's hover-card summary, fetched only while `enabled` (the card is open). */
export function useCollectionSummary(collection: string, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<CollectionSummary>({
    queryKey: DIRECTORY_KEYS.summary(collection),
    queryFn: () =>
      client
        .request<{ data: CollectionSummary }>(
          get(`/collections/${encodeURIComponent(collection)}/summary`)
        )
        .then((r) => r.data),
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

// ─── Your own use (this browser) ───────────────────────────────────────────────

const USAGE_KEY = 'nvr_collections_usage'
const MAX_RECENT = 12

export interface CollectionUsage {
  /** Newest first. */
  recent: string[]
  counts: Record<string, number>
}

function readUsage(): CollectionUsage {
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_KEY) ?? 'null') as CollectionUsage | null
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
export function useCollectionUsage(): CollectionUsage {
  const [usage] = useState(readUsage)
  return usage
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

// ─── My favorites (= the admin sidebar's favorites) ───────────────────────────

type NavFavorite = { label: string; path: string; group?: string | null }
interface NavFavoritesState {
  items: NavFavorite[]
  groups: string[]
}

const FAVORITES_KEY = ['nvr-nav-favorites'] as const
const MAX_FAVORITES = 60
/** `/collections/<name>` — the admin's path for a collection, the shape the sidebar stores. */
export const favoritePath = (collection: string) => `/collections/${encodeURIComponent(collection)}`

export function favoriteCollectionsOf(items: Array<{ path: string }>): Set<string> {
  const set = new Set<string>()
  for (const f of items) {
    const m = /^\/collections\/([^/?#]+)$/.exec(f.path)
    if (m) {
      try {
        set.add(decodeURIComponent(m[1]))
      } catch {
        /* a malformed path is no favorite */
      }
    }
  }
  return set
}

function readFavorites(prefs: Record<string, unknown> | null | undefined): NavFavoritesState {
  const groups = (Array.isArray(prefs?.nav_favorite_groups) ? prefs.nav_favorite_groups : [])
    .filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    .map((g) => g.trim())
  const items: NavFavorite[] = []
  for (const f of (Array.isArray(prefs?.nav_favorites) ? prefs.nav_favorites : []) as Array<
    Record<string, unknown>
  >) {
    if (!f || typeof f.path !== 'string' || typeof f.label !== 'string') continue
    if (items.some((i) => i.path === f.path)) continue
    items.push({
      label: f.label,
      path: f.path,
      group: typeof f.group === 'string' && groups.includes(f.group) ? f.group : null
    })
  }
  return { items, groups }
}

/**
 * The person's favorite collections when the host has no sidebar favorites of its own:
 * the same server store the admin sidebar uses (GET /users/me preferences, PATCH
 * /users/me/preferences {nav_favorites, nav_favorite_groups}), so a star here shows in the
 * admin's sidebar too and follows the person between apps and machines. Saves go out one
 * at a time; the star flips at once and falls back if the save fails.
 */
export function useNavFavoriteCollections(enabled = true): CollectionFavorites {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const query = useQuery<NavFavoritesState>({
    queryKey: FAVORITES_KEY,
    queryFn: () =>
      client
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => readFavorites(r.data?.preferences ?? {})),
    enabled,
    staleTime: 30_000
  })
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const favorite = useMemo(() => favoriteCollectionsOf(query.data?.items ?? []), [query.data])

  const toggle = useCallback(
    (collection: string, label: string) => {
      const current = qc.getQueryData<NavFavoritesState>(FAVORITES_KEY)
      // Never write before the stored list is known: the PATCH replaces the whole list.
      if (!current) {
        toast.error('Your favorites are still loading — try again in a moment')
        return Promise.resolve()
      }
      const path = favoritePath(collection)
      const has = current.items.some((f) => f.path === path)
      if (!has && current.items.length >= MAX_FAVORITES) {
        toast.error(`Favorites hold up to ${MAX_FAVORITES} pages — remove one first`)
        return Promise.resolve()
      }
      const next: NavFavoritesState = {
        ...current,
        items: has
          ? current.items.filter((f) => f.path !== path)
          : [...current.items, { label, path, group: null }]
      }
      qc.setQueryData(FAVORITES_KEY, next)
      const run = chain.current.then(async () => {
        try {
          await client.request(
            patch('/users/me/preferences', {
              nav_favorites: next.items.map((i) => ({
                label: i.label,
                path: i.path,
                ...(i.group ? { group: i.group } : {})
              })),
              nav_favorite_groups: next.groups
            })
          )
          toast.success(
            has ? `Removed ${label} from your favorites` : `Added ${label} to your favorites`
          )
        } catch {
          toast.error('Could not save favorites')
          void qc.invalidateQueries({ queryKey: FAVORITES_KEY })
        }
      })
      chain.current = run
      return run
    },
    [client, qc]
  )
  return { favorite, toggle }
}
