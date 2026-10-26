import { useEffect, useRef, useState } from 'react'
import { matchesAllTokens } from '../../lib/utils'

/**
 * Picker search pacing (2026-10-26). A plain 300 ms debounce fired one server
 * search per keystroke for anyone typing at a normal pace (~250–350 ms a key):
 * "robert" put six 1.4 s user searches in flight at once, they queued behind
 * each other on the server, and the panel sat on a spinner for 3–12 s.
 *
 * `useLatestSearch` sends at most ONE search at a time: while the current one
 * is in flight, further typing waits; when it lands, only the newest text goes
 * out. `narrowLocally` keeps the last answer on screen, narrowed by what has
 * been typed since, so the list reacts on every key while the server works.
 */
export function useLatestSearch(query: string, busy: boolean, delayMs = 300): string {
  const [sent, setSent] = useState(query)
  // Text typed while a search was out has already waited for it — it goes the
  // moment that search lands, without a second debounce on top.
  const waited = useRef(false)
  useEffect(() => {
    if (query === sent) {
      waited.current = false
      return
    }
    // An empty box answers at once — nobody waits to see the full list again.
    if (!query) {
      setSent('')
      return
    }
    if (busy) {
      waited.current = true
      return
    }
    const t = setTimeout(() => setSent(query), waited.current ? 0 : delayMs)
    return () => clearTimeout(t)
  }, [query, sent, busy, delayMs])
  return sent
}

/**
 * The options to show while a newer search is still out: the previous answer,
 * kept to rows whose rendered label still matches every typed word. Once the
 * answer for the typed text arrives (`settled`), it is shown as the server gave it
 * (the server also matches columns the label does not show).
 */
export function narrowLocally<T>(
  items: T[],
  labelOf: (item: T) => string,
  typed: string,
  settled: boolean
): T[] {
  if (settled || !typed.trim()) return items
  return items.filter((item) => matchesAllTokens(labelOf(item), typed))
}
