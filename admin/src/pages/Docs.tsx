import {
  Activity,
  BarChart2,
  BookOpen,
  Braces,
  Code2,
  Database,
  Eye,
  FileText,
  GitBranch,
  Globe,
  GraduationCap,
  HardDrive,
  Link2,
  Map as MapIcon,
  Network,
  Package,
  PuzzleIcon,
  Search,
  Settings,
  Shield,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Users
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { navSections } from '@/docs/index'
import { DocRenderer } from '@/docs/renderer'
import { cn } from '@/lib/utils'

// ─── Section icon mapping ──────────────────────────────────────────────────────

const SECTION_ICONS: Record<string, React.ElementType> = {
  overview: MapIcon,
  'user-guide': GraduationCap,
  'pipeline-engine': GitBranch,
  'rest-api': Globe,
  graphql: Braces,
  sdk: Package,
  extensions: PuzzleIcon,
  'ai-features': Sparkles,
  monitoring: Activity,
  'monitoring-api': BarChart2,
  'content-ops': FileText,
  security: Shield,
  devex: Code2,
  storage: HardDrive,
  integrations: Shuffle,
  collaboration: Users,
  'admin-ux': Search,
  'low-code': SlidersHorizontal,
  observability: Eye,
  'data-model': Database,
  trees: Network,
  settings: Settings,
  link: Link2
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function DocsPage() {
  const [activeId, setActiveId] = useState('what-is-nivaro')
  const [query, setQuery] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const allIds = navSections.flatMap((s) => s.items.map((i) => i.id))

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
            break
          }
        }
      },
      { root: el, rootMargin: '-20% 0px -70% 0px' }
    )

    for (const id of allIds) {
      const target = el.querySelector(`#${id}`)
      if (target) observer.observe(target)
    }
    return () => observer.disconnect()
  }, [])

  function scrollTo(id: string) {
    const el = contentRef.current?.querySelector(`#${id}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveId(id)
    }
  }

  const filteredSections = useMemo(() => {
    if (!query.trim()) return navSections
    const q = query.toLowerCase()
    return navSections
      .map((sec) => ({
        ...sec,
        items: sec.items.filter((item) => item.label.toLowerCase().includes(q))
      }))
      .filter((sec) => sec.items.length > 0 || sec.label.toLowerCase().includes(q))
  }, [query])

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden'>
      {/* ─── Left nav ────────────────────────────────────────────── */}
      <nav className='flex h-full w-[240px] shrink-0 flex-col border-r border-slate-200 dark:border-border bg-white dark:bg-card'>
        {/* Header */}
        <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 dark:border-border px-4 py-3.5'>
          <BookOpen className='h-4 w-4 text-nvr-cyan shrink-0' />
          <span className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            Documentation
          </span>
        </div>

        {/* Search */}
        <div className='shrink-0 px-3 pt-3 pb-2'>
          <div className='relative'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 pointer-events-none' />
            <input
              type='text'
              placeholder='Filter sections...'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn(
                'w-full rounded-md bg-slate-50 dark:bg-muted border border-slate-200 dark:border-border',
                'pl-8 pr-3 py-1.5 text-[12px] text-slate-700 dark:text-foreground',
                'placeholder:text-slate-400 dark:placeholder:text-muted-foreground',
                'focus:outline-none focus:ring-1 focus:ring-nvr-cyan focus:border-nvr-cyan',
                'transition-colors'
              )}
            />
          </div>
        </div>

        {/* Nav items */}
        <div className='min-h-0 flex-1 overflow-y-auto pb-6'>
          {filteredSections.length === 0 ? (
            <p className='px-4 pt-6 text-center text-[12px] text-slate-400 dark:text-muted-foreground'>
              No sections match
            </p>
          ) : (
            filteredSections.map((sec, si) => {
              const Icon = SECTION_ICONS[sec.id] ?? BookOpen
              return (
                <div key={sec.id} className={cn(si > 0 && 'mt-1')}>
                  {/* Section header */}
                  <div
                    className={cn(
                      'flex items-center gap-1.5 px-4 py-2',
                      si > 0 && 'border-t border-slate-100 dark:border-border mt-1 pt-3'
                    )}
                  >
                    <Icon className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground' />
                    <span className='text-[11px] font-semibold text-slate-500 dark:text-muted-foreground uppercase tracking-wide'>
                      {sec.label}
                    </span>
                  </div>

                  {/* Section items */}
                  <div className='px-2 pb-1'>
                    {sec.items.map((item) => (
                      <button
                        key={item.id}
                        type='button'
                        onClick={() => scrollTo(item.id)}
                        className={cn(
                          'group w-full rounded-md px-3 py-[5px] text-left text-[12.5px] transition-colors',
                          activeId === item.id
                            ? 'bg-nvr-cyan/[0.08] dark:bg-nvr-cyan/[0.06] font-medium text-nvr-cyan'
                            : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-muted/50 hover:text-slate-800 dark:hover:text-foreground'
                        )}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </nav>

      {/* ─── Content ─────────────────────────────────────────────── */}
      <div ref={contentRef} className='flex-1 overflow-y-auto bg-white dark:bg-background'>
        <div className='mx-auto max-w-3xl px-10 py-8'>
          {navSections.flatMap((sec, si) =>
            sec.items.map((section, ii) => {
              const isLast = si === navSections.length - 1 && ii === sec.items.length - 1
              const isFirstInSection = ii === 0 && si > 0
              return (
                <div key={section.id}>
                  {isFirstInSection && (
                    <div className='mb-8 flex items-center gap-3'>
                      <span className='shrink-0 text-[11px] font-semibold text-slate-400 dark:text-muted-foreground'>
                        {sec.label}
                      </span>
                      <div className='h-px flex-1 bg-slate-200 dark:bg-border' />
                    </div>
                  )}
                  <DocRenderer section={section} />
                  {!isLast && <hr className='my-10 border-slate-200 dark:border-border' />}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
