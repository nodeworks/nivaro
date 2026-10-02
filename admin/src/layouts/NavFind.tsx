import { Search, X } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useT } from '@/lib/i18n'
import { PanelLink } from './FavoritesNav'
import type { NavCategory, NavItem } from './nav-config'

/**
 * "Find a page" for the sidebar panel. With ~130 screens spread over ten
 * categories, knowing which category holds a page is the hard part — so this
 * searches every category at once (labels, section names, and hidden keyword
 * synonyms), shows each hit under its category so the reader learns where it
 * lives, and Enter opens the best match.
 */
export function NavFind({
  query,
  onQuery,
  categories
}: {
  query: string
  onQuery: (q: string) => void
  categories: NavCategory[]
}) {
  const t = useT()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()

  const results = useMemo(() => {
    if (!q) return []
    const words = q.split(/\s+/)
    const seen = new Set<string>()
    const groups: { cat: NavCategory; hits: { item: NavItem; score: number }[] }[] = []
    for (const cat of categories) {
      const hits: { item: NavItem; score: number }[] = []
      for (const item of cat.items) {
        const key = `${cat.id}|${item.to}`
        if (seen.has(key)) continue
        const label = t(`nav.${item.label}`, item.label).toLowerCase()
        const hay = [
          label,
          item.label.toLowerCase(),
          item.section ?? '',
          item.keywords ?? '',
          cat.label
        ]
          .join(' ')
          .toLowerCase()
        if (!words.every((w) => hay.includes(w))) continue
        seen.add(key)
        const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2
        hits.push({ item, score })
      }
      if (hits.length) groups.push({ cat, hits: hits.sort((a, b) => a.score - b.score) })
    }
    // Categories whose best hit is strongest come first; favorites win ties.
    return groups.sort((a, b) => a.hits[0].score - b.hits[0].score)
  }, [q, categories, t])

  const first = results[0]?.hits[0]?.item
  const total = results.reduce((n, g) => n + g.hits.length, 0)
  const clear = () => onQuery('')

  return (
    <>
      <div className='shrink-0 px-2.5 pb-1 pt-2.5'>
        <div className='relative'>
          <Search
            className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500'
            aria-hidden
          />
          <input
            ref={inputRef}
            type='search'
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && first) {
                e.preventDefault()
                navigate(first.to)
                clear()
                inputRef.current?.blur()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                clear()
              }
            }}
            placeholder='Find a page'
            aria-label='Find a page in the navigation'
            className='h-7 w-full rounded-md border border-white/[0.08] bg-white/[0.04] pl-7 pr-7 text-[12px] text-slate-100 outline-none transition-colors placeholder:text-slate-400 hover:border-white/[0.14] focus:border-nvr-cyan/60 focus:bg-white/[0.07] [&::-webkit-search-cancel-button]:hidden'
          />
          {query && (
            <button
              type='button'
              onClick={() => {
                clear()
                inputRef.current?.focus()
              }}
              aria-label='Clear search'
              className='absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:text-white'
            >
              <X className='h-3 w-3' />
            </button>
          )}
        </div>
      </div>
      {q && (
        <nav className='min-h-0 flex-1 overflow-y-auto pb-4 pt-1' aria-label='Search results'>
          <p className='sr-only' aria-live='polite'>
            {total === 0 ? 'No pages match' : `${total} pages match`}
          </p>
          {results.length === 0 ? (
            <div className='px-4 py-2 text-[12px] leading-relaxed text-slate-400'>
              <p>No page matches “{query.trim()}”.</p>
              <p className='mt-1'>
                Try a shorter word, or what the page is for (e.g. “email”, “cron”).
              </p>
            </div>
          ) : (
            results.map(({ cat, hits }, gi) => (
              <div key={cat.id} className={gi > 0 ? 'mt-3.5' : 'mt-0.5'}>
                <p className='flex items-center gap-1.5 px-4 pb-1 text-[11px] font-semibold text-slate-400'>
                  <cat.icon className='h-3 w-3' aria-hidden />
                  {t(`nav.${cat.label}`, cat.label)}
                </p>
                <div className='space-y-0.5'>
                  {hits.map(({ item }) => (
                    <PanelLink
                      key={item.to}
                      icon={item.icon}
                      label={item.label}
                      to={item.to}
                      onNavigate={clear}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </nav>
      )}
    </>
  )
}
