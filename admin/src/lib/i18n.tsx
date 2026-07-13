import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import de from '@/locales/de.json'
import en from '@/locales/en.json'
import es from '@/locales/es.json'
import fr from '@/locales/fr.json'

/**
 * Lightweight admin-UI i18n — no dependency, JSON dictionaries, flat
 * dot-separated keys.
 *
 * Usage:
 *   const t = useT()
 *   t('nav.dashboards', 'Dashboards')     // fallback shown when key missing
 *   t('greeting', 'Hello {name}', { name })
 *
 * Extraction pattern: pass the English string as the fallback so untranslated
 * screens keep working; add the key to every locale file when you extract a
 * string. The dictionaries in src/locales cover the shell (nav, layout,
 * common actions) — page-level extraction is incremental.
 */

export const ADMIN_LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' }
] as const

export type AdminLocale = (typeof ADMIN_LOCALES)[number]['value']

const DICTS: Record<AdminLocale, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  de: de as Record<string, string>,
  fr: fr as Record<string, string>
}

const LOCALE_KEY = 'nivaro_admin_locale'

export function getStoredLocale(): AdminLocale {
  const v = localStorage.getItem(LOCALE_KEY)
  return ADMIN_LOCALES.some((l) => l.value === v) ? (v as AdminLocale) : 'en'
}

type TFunc = (key: string, fallback?: string, vars?: Record<string, string | number>) => string

const I18nContext = createContext<{
  locale: AdminLocale
  setLocale: (l: AdminLocale) => void
  t: TFunc
}>({
  locale: 'en',
  setLocale: () => {},
  t: (key, fallback) => fallback ?? key
})

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AdminLocale>(getStoredLocale)

  const setLocale = useCallback((l: AdminLocale) => {
    localStorage.setItem(LOCALE_KEY, l)
    setLocaleState(l)
  }, [])

  const t = useCallback<TFunc>(
    (key, fallback, vars) => {
      const hit = DICTS[locale][key] ?? DICTS.en[key] ?? fallback ?? key
      return interpolate(hit, vars)
    },
    [locale]
  )

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT(): TFunc {
  return useContext(I18nContext).t
}

export function useLocale() {
  const { locale, setLocale } = useContext(I18nContext)
  return { locale, setLocale }
}
