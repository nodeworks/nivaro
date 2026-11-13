import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { CMSRelation } from './types'

/**
 * Header relation-path tiles ("Unit" = unit.name, "Schedule Date" =
 * unit.schedule_date) read the saved record's value from the server. On a new
 * form — or once the person picks another unit — that value is not there yet,
 * so the tile said "—" while a unit was plainly picked (army 11 f2). This
 * reads one-hop paths (`<m2o field>.<field>`) straight from the record the
 * draft points at, as the viewer. Longer paths keep the saved value.
 */

const idOf = (v: unknown): string =>
  String((v != null && typeof v === 'object' ? (v as { id?: unknown }).id : v) ?? '')

/**
 * The record read again, with the relation-path values the form was showing
 * ('unit.name', 'unit.schedule_date', resolved by /resolve-paths and merged
 * into the form's copy) carried over while the record still points at the same
 * related record. The read itself carries no such keys: adopting it as is
 * blanked those header tiles after any refetch (a refused move's refresh) until
 * the page was reloaded, because the resolved values are only merged when
 * their own read changes. A value the new read carries wins; a first hop that
 * now points elsewhere drops the old value. Returns `next` itself when nothing
 * is kept.
 */
export function keepResolvedPaths(
  prev: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(prev)) {
    const dot = key.indexOf('.')
    if (dot <= 0 || key in next) continue
    const hop = key.slice(0, dot)
    if (!(hop in next) || idOf(prev[hop]) !== idOf(next[hop])) continue
    out ??= { ...next }
    out[key] = value
  }
  return out ?? next
}

/** The one-hop header paths whose first hop the draft holds differently from the saved record. */
export function pathsToPreview(
  paths: string[],
  draft: Record<string, unknown>,
  saved: Record<string, unknown>,
  isNew: boolean
): Array<{ path: string; hop: string; rest: string; id: string }> {
  const out: Array<{ path: string; hop: string; rest: string; id: string }> = []
  for (const path of paths) {
    const parts = path.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue
    const [hop, rest] = parts
    const raw = draft[hop]
    const id = raw != null && typeof raw === 'object' ? (raw as { id?: unknown }).id : raw
    if (id === null || id === undefined || id === '') continue
    const savedRaw = saved[hop]
    const savedId =
      savedRaw != null && typeof savedRaw === 'object'
        ? (savedRaw as { id?: unknown }).id
        : savedRaw
    if (!isNew && String(savedId ?? '') === String(id)) continue
    out.push({ path, hop, rest, id: String(id) })
  }
  return out
}

export function useHeaderPathPreview(args: {
  collection: string
  relations: CMSRelation[]
  paths: string[]
  draft: Record<string, unknown>
  saved: Record<string, unknown>
  isNew: boolean
}): Record<string, unknown> {
  const client = useNivaroClient()
  const wanted = pathsToPreview(args.paths, args.draft, args.saved, args.isNew)
    .map((w) => {
      const rel = args.relations.find(
        (r) => r.many_collection === args.collection && r.many_field === w.hop && !r.junction_field
      )
      return rel?.one_collection ? { ...w, target: rel.one_collection } : null
    })
    .filter((w): w is NonNullable<typeof w> => !!w)
  // One read per picked record, every path it feeds in the same read.
  const groups = new Map<string, { target: string; id: string; fields: Set<string> }>()
  for (const w of wanted) {
    const k = `${w.target}:${w.id}`
    const g = groups.get(k) ?? { target: w.target, id: w.id, fields: new Set<string>() }
    g.fields.add(w.rest)
    groups.set(k, g)
  }
  const list = [...groups.values()]
  const results = useQueries({
    queries: list.map((g) => ({
      queryKey: ['header-path-preview', g.target, g.id, [...g.fields].sort().join(',')],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown> | null }>(
            get(`/items/${g.target}/${encodeURIComponent(g.id)}`, {
              fields: [...g.fields].join(',')
            })
          )
          .then((r) => r.data ?? null)
          .catch(() => null),
      staleTime: 30_000
    }))
  })
  const sig = results.map((r) => r.dataUpdatedAt).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: sig is the content key of the results
  return useMemo(() => {
    const out: Record<string, unknown> = {}
    for (const w of wanted) {
      const idx = list.findIndex((g) => g.target === w.target && g.id === w.id)
      const row = results[idx]?.data as Record<string, unknown> | null | undefined
      if (row) out[w.path] = row[w.rest] ?? null
    }
    return out
  }, [sig, wanted.map((w) => `${w.path}=${w.id}`).join('|')])
}
