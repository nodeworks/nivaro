import { useEffect, useState } from 'react'

/**
 * `useAfterIdle(ms)` — false on mount, true once the browser has had `ms` of
 * settle time after the first paint. Gate secondary reads on it (freshness
 * stamps, cell provenance, lineage explainers, the live integrity check):
 * they decorate a record the person is already looking at, and on a page
 * that fans out a hundred reads at once they were competing for the same
 * connection pool as the reads that PAINT the form.
 */
export function useAfterIdle(ms = 1500): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    const start = () => {
      if (cancelled) return
      timer = setTimeout(() => {
        if (!cancelled) setReady(true)
      }, ms)
    }
    // Two frames: the component has painted before the clock starts.
    const raf = requestAnimationFrame(() => requestAnimationFrame(start))
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
    }
  }, [ms])
  return ready
}
