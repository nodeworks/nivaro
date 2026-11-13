import { type CollectionFavorites, favoriteCollectionsOf } from '@nivaro/shared'
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useNavFavorites } from '@/layouts/FavoritesNav'
import { api } from '@/lib/api'

/**
 * The admin app's own pieces of the Collections page; the page itself is the shared
 * CollectionsDirectory (@nivaro/shared).
 */

// ─── My favorites = sidebar favorites ─────────────────────────────────────────

/**
 * A person's favorite collection is a sidebar favorite whose path is /collections/<name>
 * (users.preferences.nav_favorites), so starring one here also puts it in the sidebar's
 * Favorites and follows the person between machines. Personal — not the shared "Pinned"
 * list an administrator sets for everyone. The admin app passes this so the sidebar and the
 * page share one optimistic copy.
 */
export function useFavoriteCollections(): CollectionFavorites {
  const { favorites, save } = useNavFavorites()
  const favorite = useMemo(() => favoriteCollectionsOf(favorites.items), [favorites])
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
        has ? `Removed ${label} from your favorites` : `Added ${label} to your favorites`
      )
    },
    [favorites, save]
  )
  return { favorite, toggle }
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
