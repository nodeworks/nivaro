import { useCallback, useState } from 'react'

export function usePersistedTab<T extends string>(
  key: string,
  defaultValue: T,
): [T, (tab: T) => void] {
  const [tab, setTabRaw] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) ?? defaultValue
    } catch {
      return defaultValue
    }
  })

  const setTab = useCallback(
    (value: T) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        /* noop */
      }
      setTabRaw(value)
    },
    [key],
  )

  return [tab, setTab]
}
