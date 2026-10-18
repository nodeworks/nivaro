// #2278 — where the map's layout and edge routing run. A small map lays out in well under a
// millisecond, so it stays inline (a worker round trip would only add a frame of lag). Past
// WORKER_MIN_ITEMS nodes + edges the work moves to a module worker (layout.worker.ts) so frames
// arriving every second never stall hover, particles or scrolling; the page keeps drawing the
// previous layout until the new one lands. No Worker (tests, SSR, a blocked script) or a worker
// that fails = the same pure functions inline.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  computeLayout,
  type EdgeRoutes,
  type LayoutInput,
  type MapLayout,
  type RouteRequest,
  routeEdges
} from '../layout'

/** Nodes + edges from which the layout runs in the worker. */
export const WORKER_MIN_ITEMS = 300

export interface LayoutResult {
  layout: MapLayout
  /** Flattened edge curves (null when none were asked for: the 2D canvas strokes beziers). */
  routes: EdgeRoutes | null
}

/** Nodes + edges a layout request covers. */
export function layoutItems(input: LayoutInput, edges: RouteRequest | null): number {
  let n = input.callers.length + (input.sources?.length ?? 0) + input.downs.length
  for (const l of input.lanes) n += 1 + l.entities.length
  if (edges) n += edges.in.length + edges.ent.length + edges.out.length
  return n
}

export function layoutInline(input: LayoutInput, edges: RouteRequest | null): LayoutResult {
  const layout = computeLayout(input)
  return { layout, routes: edges ? routeEdges(layout, edges) : null }
}

function workerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined'
}

interface Reply {
  seq: number
  layout?: MapLayout
  routes?: EdgeRoutes | null
  error?: string
}

/**
 * The layout for `input` (+ routes for `edges`). `input` and `edges` must be memoised by the
 * caller: a new object is a new job. `via` says where the current result came from.
 */
export function useMapLayout(
  input: LayoutInput,
  edges: RouteRequest | null
): LayoutResult & { via: 'inline' | 'worker' } {
  const [failed, setFailed] = useState(false)
  const items = useMemo(() => layoutItems(input, edges), [input, edges])
  const offThread = !failed && items >= WORKER_MIN_ITEMS && workerAvailable()
  const inline = useMemo(
    () => (offThread ? null : layoutInline(input, edges)),
    [offThread, input, edges]
  )
  const [fromWorker, setFromWorker] = useState<LayoutResult | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const seqRef = useRef(0)
  const appliedRef = useRef(0)
  // the first off-thread render (nothing back yet) draws an inline layout instead of nothing
  const placeholder = useRef<LayoutResult | null>(null)

  useEffect(() => {
    if (!offThread) return
    let w = workerRef.current
    if (!w) {
      try {
        w = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
      } catch {
        setFailed(true)
        return
      }
      w.onmessage = (e: MessageEvent<Reply>) => {
        const r = e.data
        if (r.error || !r.layout) {
          setFailed(true)
          return
        }
        if (r.seq <= appliedRef.current) return // an older job answered late
        appliedRef.current = r.seq
        setFromWorker({ layout: r.layout, routes: r.routes ?? null })
      }
      w.onerror = () => setFailed(true)
      workerRef.current = w
    }
    w.postMessage({ seq: ++seqRef.current, input, edges })
  }, [offThread, input, edges])

  useEffect(
    () => () => {
      workerRef.current?.terminate()
      workerRef.current = null
    },
    []
  )

  if (inline) {
    placeholder.current = null
    return { ...inline, via: 'inline' }
  }
  if (fromWorker) return { ...fromWorker, via: 'worker' }
  if (!placeholder.current) placeholder.current = layoutInline(input, edges)
  return { ...placeholder.current, via: 'inline' }
}
