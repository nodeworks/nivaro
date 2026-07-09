import { useEffect, useState } from 'react'

/**
 * Returns a value that trails `value` by `delayMs`. Useful for keeping text
 * inputs bound to live state while queries key off the debounced copy so a
 * request doesn't fire per keystroke.
 */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
