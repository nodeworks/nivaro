/**
 * #2145 — the page's copy of GET /traffic-map/baselines: fetched when something first reads it,
 * again every REFRESH_MS and when the clock hour turns (the bands are per hour of the week).
 * Synchronous reads (canvas tones, badges) take whatever is loaded; React reads subscribe.
 */
import { useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import type { Baselines, KeyBands } from './score'

const REFRESH_MS = 10 * 60_000
let data: Baselines | null = null
let version = 0
let loadingAt = 0
let fetchedAt = 0
let lastHour = -1
let failed = false
const subs = new Set<() => void>()

function hourNow(): number {
  return Math.floor(Date.now() / 3600_000)
}

function notify(): void {
  version++
  for (const fn of subs) fn()
}

/** Ask for the bands when they are missing, stale or for another hour (throttled). */
export function ensureBaselines(): void {
  const now = Date.now()
  const h = hourNow()
  const due = !data || h !== lastHour || now - fetchedAt > REFRESH_MS
  if (!due || now - loadingAt < (failed ? 60_000 : 15_000)) return
  loadingAt = now
  // off the render path (synchronous readers call this while painting)
  Promise.resolve()
    .then(() => api.get('/traffic-map/baselines'))
    .then((r) => {
      const raw = (r?.data as { data?: Partial<Baselines> } | undefined)?.data
      if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object') {
        failed = true
        return
      }
      data = {
        h: 0,
        at: '',
        weeks: 4,
        hours_wanted: 0,
        hours_known: 0,
        learning: true,
        callers: {},
        edges: {},
        downs: {},
        total: {},
        people: null,
        ...raw,
        nodes: raw.nodes
      }
      lastHour = h
      fetchedAt = Date.now()
      failed = false
      notify()
    })
    .catch(() => {
      failed = true
    })
}

/** The loaded bands (null until the first answer). Starts a fetch when due. */
export function baselines(): Baselines | null {
  ensureBaselines()
  return data
}

/** Bands for one map node: an entity key, a caller key, a down id, or 'total'. */
export function bandsFor(
  kind: 'entity' | 'caller' | 'down' | 'total',
  id: string
): KeyBands | undefined {
  const b = baselines()
  if (!b) return undefined
  if (kind === 'entity') return b.nodes[id]
  if (kind === 'caller') return b.callers[id]
  if (kind === 'down') return b.downs[id]
  return b.total
}

/** Subscribe to new bands (the subscription also keeps them fresh while it lasts). */
export function subscribeBaselines(fn: () => void): () => void {
  return subscribe(fn)
}
export function baselinesVersion(): number {
  return version
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  ensureBaselines()
  const t = setInterval(ensureBaselines, 60_000)
  return () => {
    subs.delete(fn)
    clearInterval(t)
  }
}

/** Re-renders when new bands arrive. */
export function useBaselines(): Baselines | null {
  useSyncExternalStore(subscribe, () => version)
  return data
}

/** Tests: put bands in place (null clears). */
export function setBaselinesForTest(b: Baselines | null): void {
  data = b
  lastHour = b ? hourNow() : -1
  loadingAt = b ? Date.now() : 0
  fetchedAt = loadingAt
  notify()
}
