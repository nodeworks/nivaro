import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

/**
 * Open lists follow schema and layout pushes (realtime fixes 2026-11-19, area B).
 *
 * The server broadcasts `config:update {surface, collection}` when an admin changes fields,
 * labels, browser settings, inline edit, default columns or row actions; hosts raise it as the
 * window event `nvr:config-update`. Only the record form listened, so an open list kept its old
 * columns and switches for up to 10 minutes (its metadata read is cached that long). A list or
 * queue names the collections it shows and the keys holding their metadata: a push that names
 * one of them (or names none) re-reads those keys once, after a short random spread so every
 * open tab does not ask in the same second. Config pushes are rare admin actions.
 */
export const CONFIG_UPDATE_WINDOW_EVENT = 'nvr:config-update'

/** Whether a push about `changed` concerns a screen showing `collections` (none named = all). */
export function configUpdateTouches(
  changed: string | null | undefined,
  collections: ReadonlyArray<string | null | undefined>
): boolean {
  if (!changed) return true
  return collections.some((c) => !!c && c === changed)
}

export function useConfigUpdateRefresh(
  collections: ReadonlyArray<string | null | undefined>,
  keys: ReadonlyArray<QueryKey>,
  opts: { enabled?: boolean; jitterMs?: number } = {}
): void {
  const qc = useQueryClient()
  const enabled = opts.enabled !== false
  const jitterMs = opts.jitterMs ?? 1500
  const collectionsJson = JSON.stringify(collections)
  const keysJson = JSON.stringify(keys)
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const watched = JSON.parse(collectionsJson) as string[]
    const queryKeys = JSON.parse(keysJson) as QueryKey[]
    let timer: ReturnType<typeof setTimeout> | null = null
    const onConfig = (e: Event) => {
      const changed = (e as CustomEvent<{ collection?: string } | undefined>).detail?.collection
      if (!configUpdateTouches(changed, watched) || timer) return
      timer = setTimeout(
        () => {
          timer = null
          for (const queryKey of queryKeys)
            void qc.invalidateQueries({ queryKey, refetchType: 'active' }, { cancelRefetch: false })
        },
        Math.floor(Math.random() * Math.max(0, jitterMs))
      )
    }
    window.addEventListener(CONFIG_UPDATE_WINDOW_EVENT, onConfig)
    return () => {
      window.removeEventListener(CONFIG_UPDATE_WINDOW_EVENT, onConfig)
      if (timer) clearTimeout(timer)
    }
  }, [qc, enabled, jitterMs, collectionsJson, keysJson])
}
