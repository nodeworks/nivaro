import { useEffect, useRef } from 'react'

/**
 * A re-read that follows pokes at most once per `gapMs`, and never while the tab is hidden: a
 * hidden tab owes one re-read and runs it when it is shown again. The first poke after a quiet
 * gap runs at once, later ones wait out the gap; a trailing one is never dropped. Used where the
 * read is heavy and the pokes are tenant-wide (My Work, the cover line, Overview sections).
 */
export interface GapRefresher {
  poke: () => void
  /** The tab was shown again: re-read now if one is owed. */
  resume: () => void
  cancel: () => void
}

function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/** Pure scheduler: the first poke after a quiet `gapMs` runs at once, later ones wait out the gap. */
export function createGapRefresher(
  fn: () => void,
  opts: { gapMs: number; now?: () => number; isVisible?: () => boolean }
): GapRefresher {
  const now = opts.now ?? (() => Date.now())
  const visible = opts.isVisible ?? tabVisible
  let last = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  let owed = false
  const run = () => {
    timer = null
    if (!visible()) {
      owed = true
      return
    }
    owed = false
    last = now()
    fn()
  }
  return {
    poke() {
      if (timer) return
      const wait = last + opts.gapMs - now()
      if (wait <= 0) run()
      else timer = setTimeout(run, wait)
    },
    resume() {
      if (!timer && owed && visible()) run()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      owed = false
    }
  }
}

/** React form: a stable `poke` that runs `fn` through a gap refresher (hidden tabs owe it). */
export function useGapRefresh(fn: () => void, gapMs: number, enabled = true): () => void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const ref = useRef<GapRefresher | null>(null)
  useEffect(() => {
    if (!enabled) return
    const r = createGapRefresher(() => fnRef.current(), { gapMs })
    ref.current = r
    const onVis = () => r.resume()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
      r.cancel()
      if (ref.current === r) ref.current = null
    }
  }, [gapMs, enabled])
  const poke = useRef(() => ref.current?.poke())
  return poke.current
}
