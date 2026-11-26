import { useLiveOps } from '@nivaro/shared'
import { type Query, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

/**
 * Every Hub query key starts with a `hub…` segment (`['hub', …]`, `['hub-ops']`,
 * `['hub-incidents', …]`): the one test of "is this a Hub read".
 */
export const isHubQuery = (q: Pick<Query, 'queryKey'>): boolean =>
  typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('hub')

/**
 * Live Hub pages (2026-11-25): the server pokes the `hub` ops topic whenever a Hub table is
 * written (db/ops-signal.ts) — a deploy step, a creation, the fleet status, a stack apply, an
 * incident. Each poke re-reads the Hub queries on screen, so nobody reloads to see a change.
 * The pages' own polls stay as the safety net when the socket is down.
 */
export function useHubLive(enabled: boolean): void {
  const qc = useQueryClient()
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ predicate: isHubQuery, refetchType: 'active' })
  }, [qc])
  useLiveOps('hub', refresh, { enabled, debounceMs: 1000 })
}

/** useHubLive as a component, for a layout that renders the realtime provider itself. */
export function HubLiveSync({ enabled }: { enabled: boolean }): null {
  useHubLive(enabled)
  return null
}
