import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../context'
import { get } from './commands'
import { liveQueryMeta } from './live-queries'

/**
 * How many live records sit in each step of a pipeline right now, and how long the longest
 * waiting one has been there (realtime program 2026-11-14, idea 22).
 *
 * One read (`GET /pipelines/:id/instance-distribution`, administrators) that follows the bound
 * collections live: another person's move, a create or a delete refetches it through the
 * live-query bridge (coalesced, at most once per 15 s), so the pipeline editor's step list shows
 * today's numbers without a reload. Nothing here moves anything on screen — the counts change in
 * place.
 */

export interface CensusRow {
  state_id: string | null
  collection: string
  count: number
  oldest_at?: string | null
  key: string | null
  label: string | null
  color: string | null
  orphaned: boolean
}

export interface CensusState {
  count: number
  /** The longest-waiting record in the step entered it at this time (ISO), if known. */
  oldestAt: string | null
  /** Per bound collection, most records first. */
  byCollection: Array<{ collection: string; count: number; oldestAt: string | null }>
}

const sameId = (a: string | null, b: string) => !!a && a.toUpperCase() === b.toUpperCase()

/** Fold the rows into one entry per step id (pure). */
export function censusByState(
  rows: readonly CensusRow[],
  stateIds: readonly string[]
): Map<string, CensusState> {
  const out = new Map<string, CensusState>()
  for (const id of stateIds) {
    const mine = rows.filter((r) => sameId(r.state_id, id))
    const byCollection = mine
      .map((r) => ({
        collection: r.collection,
        count: Number(r.count) || 0,
        oldestAt: r.oldest_at ?? null
      }))
      .sort((a, b) => b.count - a.count)
    let oldest: string | null = null
    for (const c of byCollection) {
      if (c.oldestAt && (!oldest || Date.parse(c.oldestAt) < Date.parse(oldest)))
        oldest = c.oldestAt
    }
    out.set(id, {
      count: byCollection.reduce((n, c) => n + c.count, 0),
      oldestAt: oldest,
      byCollection
    })
  }
  return out
}

/** "oldest 12 d" — whole days from 2 d, "oldest 1 d", "oldest today" under a day. */
export function oldestHint(oldestAt: string | null | undefined, now = Date.now()): string | null {
  if (!oldestAt) return null
  const t = Date.parse(oldestAt)
  if (!Number.isFinite(t)) return null
  const days = Math.floor(Math.max(0, now - t) / 86_400_000)
  return days < 1 ? 'oldest today' : `oldest ${days.toLocaleString('en-US')} d`
}

/** The list a step's chip opens: the bound collection filtered to that step's key. */
export function stateListPath(collection: string, stateKey: string): string {
  return `/collections/${encodeURIComponent(collection)}?state=${encodeURIComponent(stateKey)}`
}

/**
 * The census read, live. `collections` = the collections this pipeline is bound to (what its
 * instances' moves are announced on). Same query key as the Instance migration card, so the two
 * share one cached answer.
 */
export function useStateCensus(templateId: string | undefined, collections: readonly string[]) {
  const client = useNivaroClient()
  const key = [...new Set(collections)].sort().join('|')
  const reads = useMemo(() => (key ? key.split('|') : []), [key])
  return useQuery({
    queryKey: ['instance-distribution', templateId],
    enabled: !!templateId,
    queryFn: () =>
      client.request<{
        data: CensusRow[]
        states: Array<{ id: string; key: string; label: string }>
      }>(get(`/pipelines/${templateId}/instance-distribution`)),
    staleTime: 30_000,
    // A move says `$state` on its record; creates and deletes always count; a plain column edit
    // does not (fields: []), so typing in a record never re-counts the pipeline.
    meta: reads.length
      ? liveQueryMeta({ reads, fields: [], aspects: ['$state'], minGapMs: 15_000 })
      : undefined
  })
}
