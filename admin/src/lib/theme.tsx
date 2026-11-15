import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (t: Theme) => void
  /** The theme the person's account holds (set on another device): applied here without
   *  being saved back. Ignored for a few seconds after this tab's own choice. */
  adoptServerTheme: (t: unknown) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => {},
  adoptServerTheme: () => {}
})

// A choice made here is saved to the person's account (rt4 #19) by whoever is signed in: the
// app shell registers the saver, so this provider never depends on auth.
let persistTheme: ((t: Theme) => void) | null = null
export function registerThemePersist(fn: ((t: Theme) => void) | null): void {
  persistTheme = fn
}
const OWN_CHANGE_GRACE_MS = 5000

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('nivaro-theme') as Theme) ?? 'system'
    } catch {
      return 'system'
    }
  })

  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Another tab of this browser changed the theme (#2434): follow it at once. `storage` fires
  // in every OTHER tab of the origin when 'nivaro-theme' is written, so no loop.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'nivaro-theme') return
      const v = e.newValue
      setThemeState(v === 'light' || v === 'dark' || v === 'system' ? v : 'system')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const resolvedTheme: 'light' | 'dark' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    const root = document.documentElement
    if (resolvedTheme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [resolvedTheme])

  const ownChangeAt = useRef(0)

  function setTheme(t: Theme) {
    ownChangeAt.current = Date.now()
    setThemeState(t)
    try {
      localStorage.setItem('nivaro-theme', t)
    } catch {}
    persistTheme?.(t)
  }

  // Another device of this person chose a theme: follow it (nothing to save back).
  const adoptServerTheme = useCallback((t: unknown) => {
    if (t !== 'light' && t !== 'dark' && t !== 'system') return
    if (Date.now() - ownChangeAt.current < OWN_CHANGE_GRACE_MS) return
    setThemeState((cur) => (cur === t ? cur : t))
    try {
      localStorage.setItem('nivaro-theme', t)
    } catch {}
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, adoptServerTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
