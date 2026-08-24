import { useEffect, useState } from 'react'

/**
 * Long-request honesty (#370): after `thresholdMs` of continuous loading,
 * returns the elapsed seconds so surfaces can say "Still working — 8s" instead
 * of an eternal spinner. Returns null while under the threshold or idle.
 */
export function useElapsedLoading(loading: boolean, thresholdMs = 3000): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (!loading) {
      setElapsed(null)
      return
    }
    const start = Date.now()
    const t = setInterval(() => {
      const ms = Date.now() - start
      setElapsed(ms >= thresholdMs ? Math.round(ms / 1000) : null)
    }, 1000)
    return () => clearInterval(t)
  }, [loading, thresholdMs])
  return elapsed
}
