/**
 * The stack context builder (drill-down Task 8): walks the investigation's levels and pulls each
 * level's detail from the react-query cache — whatever its panel already loaded under
 * `['tm-inspect', kind, id, at, windowSec]` — into the compact JSON Explain and the notebook use.
 * Nothing is fetched: a level never opened (or that failed) is sent as "not loaded".
 */
import type { QueryClient } from '@tanstack/react-query'
import { refTitle } from '../../inspect/format'
import { encodeStack, type InspectStackState } from '../../inspect/stack'
import type { InspectRef } from '../../registry/inspectables'
import {
  type CompactResult,
  type ContextLevelInput,
  compactStackContext,
  type ExportLevel
} from './logic'

/** Minimal read side of the query cache (QueryClient satisfies it; tests pass a fake). */
export interface DetailCache {
  getQueriesData(filters: { queryKey: readonly unknown[] }): Array<[readonly unknown[], unknown]>
}

/**
 * A level's cached detail: the entry for the level's own time (else the anchor) when there is
 * one, else any loaded entry for that kind + id. undefined = nothing loaded.
 */
export function cachedDetail(
  cache: DetailCache,
  ref: InspectRef,
  anchor: number | null
): unknown | undefined {
  const entries = cache
    .getQueriesData({ queryKey: ['tm-inspect', ref.kind, ref.id] })
    .filter(([, data]) => data !== undefined)
  if (entries.length === 0) return undefined
  const at = ref.at ?? anchor ?? null
  const exact = entries.find(([key]) => (key[3] ?? null) === at)
  return (exact ?? entries[entries.length - 1])[1]
}

/** The levels (root first) with their titles and cached details. */
export function stackLevels(
  cache: DetailCache,
  s: Pick<InspectStackState, 'levels' | 'index' | 'anchor'>
): ContextLevelInput[] {
  return s.levels.map((ref, i) => ({
    ref,
    title: refTitle(ref),
    current: i === s.index,
    detail: cachedDetail(cache, ref, s.anchor)
  }))
}

/** The compact JSON of the whole stack (≤ 24 KB). */
export function buildStackContext(
  cache: DetailCache | QueryClient,
  s: Pick<InspectStackState, 'levels' | 'index' | 'anchor' | 'windowSec'>
): CompactResult {
  return compactStackContext(stackLevels(cache as DetailCache, s), {
    anchor: s.anchor,
    windowSec: s.windowSec
  })
}

/** Absolute link to the Traffic Map with `levels` open in the investigation panel. */
export function inspectUrl(levels: InspectRef[], origin = window.location.origin): string {
  const v = encodeStack(levels)
  if (!v) return `${origin}/traffic-map`
  return `${origin}/traffic-map?${new URLSearchParams({ inspect: v }).toString()}`
}

/** The levels as export input, each with the link to the stack up to it. */
export function exportLevels(
  cache: DetailCache | QueryClient,
  s: Pick<InspectStackState, 'levels' | 'index' | 'anchor'>,
  origin = window.location.origin
): ExportLevel[] {
  return stackLevels(cache as DetailCache, s).map((l, i) => ({
    ref: l.ref,
    title: l.title,
    detail: l.detail,
    url: inspectUrl(s.levels.slice(0, i + 1), origin)
  }))
}
