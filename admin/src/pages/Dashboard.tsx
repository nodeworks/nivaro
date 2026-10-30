import { FirstLoginChecklist, NavigationContext, NivaroProvider } from '@nivaro/react'
import { createNivaro } from '@nivaro/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import {
  localDayStart,
  needsYouCount,
  useMyWork,
  useOverviewPrefs,
  useOverviewStats,
  useSinceDigest,
  useUpdateOverviewPrefs
} from './overview/api'
import { CustomizePanel } from './overview/Customize'
import { layoutOf, type ResolvedSection, resolveSections } from './overview/layout'
import { isShownEvent, usePulse, useThrottledCall } from './overview/live'
import { RecentActivitySection } from './overview/RecentActivity'
import { availableSectionKeys, overviewSections } from './overview/registry'
import { SectionBoundary } from './overview/SectionBoundary'
import { SinceLastVisit } from './overview/SinceLastVisit'
import { StatLine } from './overview/StatLine'
import { SECTION_META } from './overview/sections-meta'
import { firstName, greetingSentence } from './overview/text'

/**
 * Overview (route `/`) — where a person starts: a greeting that says what needs them, what
 * changed since their last visit, today's figures against yesterday, their quick actions,
 * recent records and activity, and on the side their own work (plus, for administrators, this
 * instance's facts). Sections come from the registry (pages/overview/registry.ts), in the
 * person's own order — or their role's starter layout until they customise it.
 *
 * Everything is computed AS THE VIEWER. Administrators get live updates from the activity
 * pulse; everyone else a gentle refresh.
 */

// Shared FirstLoginChecklist needs a Nivaro client + navigation context; the page otherwise
// talks axios, so a small host wraps just the card.
const checklistClient = createNivaro(window.location.origin, { timeoutMs: 90_000 })
function ChecklistHost() {
  const navigate = useNavigate()
  return (
    <NivaroProvider client={checklistClient}>
      <NavigationContext.Provider value={{ navigate: (p: string) => navigate(p) }}>
        <div className='empty:hidden [&:has(>*)]:mb-5'>
          <FirstLoginChecklist profileUrl='/profile' />
        </div>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}

/** The viewer's day start; moves on at local midnight while the page stays open. */
function useLocalDayStart(): string {
  const [day, setDay] = useState(localDayStart)
  useEffect(() => {
    const t = setInterval(() => {
      const now = localDayStart()
      setDay((d) => (d === now ? d : now))
    }, 60_000)
    return () => clearInterval(t)
  }, [])
  return day
}

export function DashboardPage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const isAdmin = !!user?.is_admin
  const userId = user?.id ?? ''
  const dayStart = useLocalDayStart()

  const stats = useOverviewStats(dayStart, isAdmin ? 5 * 60_000 : 60_000)
  const myWork = useMyWork()
  const since = useSinceDigest()
  const prefs = useOverviewPrefs()
  const update = useUpdateOverviewPrefs()

  // Live figures: a burst of writes is one re-read, at most every 15 s.
  const refreshStats = useThrottledCall(
    () => void qc.invalidateQueries({ queryKey: ['overview', 'stats'] }),
    15_000
  )
  usePulse(isAdmin, (e) => isShownEvent(e) && refreshStats(), userId)

  // ── Sections ─────────────────────────────────────────────────────────────
  const defs = useMemo(() => new Map(overviewSections().map((d) => [d.key, d])), [])
  const available = useMemo(() => availableSectionKeys(), [])
  const resolved = useMemo(
    () =>
      resolveSections({
        meta: SECTION_META,
        roleDefault: prefs.data?.role_default ?? null,
        personal: prefs.data?.layout ?? null,
        isAdmin,
        available
      }),
    [prefs.data?.role_default, prefs.data?.layout, isAdmin, available]
  )
  const [customizing, setCustomizing] = useState(false)
  const [draft, setDraft] = useState<ResolvedSection[] | null>(null)
  const sections = draft ?? resolved
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    []
  )
  const changeLayout = (next: ResolvedSection[]) => {
    setDraft(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => update.mutate({ layout: layoutOf(next) }), 500)
  }
  const resetLayout = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setDraft(null)
    update.mutate({ layout: null })
  }

  // ── Greeting ─────────────────────────────────────────────────────────────
  const { greeting, detail } = greetingSentence({
    hour: new Date().getHours(),
    name: firstName(user ?? null),
    needsYou: needsYouCount(myWork.data),
    myRecordsChanged: since.data?.my_records_changed ?? null
  })

  const renderSection = (s: ResolvedSection) => {
    if (!s.visible) return null
    const wrap = (node: React.ReactNode, extra?: string) => (
      <div key={s.key} className={cn('min-w-0', s.meta.phoneFirst && 'max-lg:order-first', extra)}>
        <SectionBoundary title={s.meta.title}>{node}</SectionBoundary>
      </div>
    )
    if (s.key === 'stats')
      return wrap(
        <StatLine
          stats={stats.data}
          isLoading={stats.isLoading}
          error={stats.error}
          onRetry={() => void stats.refetch()}
          isAdmin={isAdmin}
        />
      )
    if (s.key === 'activity')
      return wrap(
        <RecentActivitySection
          userId={userId}
          isAdmin={isAdmin}
          className='flex flex-1 flex-col'
        />,
        'flex flex-1 flex-col'
      )
    const Comp = defs.get(s.key)?.component
    return Comp ? wrap(<Comp userId={userId} isAdmin={isAdmin} />) : null
  }

  const main = sections.filter((s) => s.column === 'main')
  const side = sections.filter((s) => s.column === 'side' && s.visible)

  return (
    <div className='flex flex-1 flex-col bg-slate-50 dark:bg-background'>
      {/* ── Header: greeting + since your last visit ───────────────────── */}
      <header className='sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-4 sm:px-6 lg:px-8 dark:border-border dark:bg-card'>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <h1 className='text-[18px] font-semibold leading-snug tracking-[-0.01em] text-slate-900 dark:text-slate-50'>
              {greeting}
              {detail && (
                <span className='font-normal text-slate-600 dark:text-slate-300'> — {detail}</span>
              )}
            </h1>
            {!since.firstVisit && (
              <SinceLastVisit digest={since.data} isLoading={since.isLoading} isAdmin={isAdmin} />
            )}
          </div>
          <Button
            variant='ghost'
            size='sm'
            className='h-8 shrink-0 gap-1.5 text-[12px]'
            aria-pressed={customizing}
            aria-expanded={customizing}
            onClick={() => {
              setCustomizing((v) => !v)
              setDraft(null)
            }}
          >
            <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden />
            <span className='max-sm:sr-only'>Customize</span>
          </Button>
        </div>
      </header>

      {customizing && (
        <CustomizePanel
          sections={sections}
          onChange={changeLayout}
          onDone={() => {
            setCustomizing(false)
            setDraft(null)
          }}
          onReset={resetLayout}
          canReset={!!prefs.data?.layout || !!draft}
          hasRoleDefault={!!prefs.data?.role_default}
          isAdmin={isAdmin}
        />
      )}

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div className='flex flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8'>
        <ChecklistHost />
        <div
          className={cn(
            'grid flex-1 grid-cols-1 gap-6',
            side.length > 0 &&
              'lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]'
          )}
        >
          <div className='flex min-w-0 flex-col gap-6'>
            {main.some((s) => s.visible) ? (
              main.map(renderSection)
            ) : (
              <p className='rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-[12.5px] text-slate-600 dark:border-border dark:text-slate-300'>
                Every section is hidden.{' '}
                <button
                  type='button'
                  className='font-medium text-slate-900 underline underline-offset-2 dark:text-white'
                  onClick={() => setCustomizing(true)}
                >
                  Choose what to show
                </button>
              </p>
            )}
          </div>
          {side.length > 0 && (
            <aside aria-label='Your work and this instance' className='flex min-w-0 flex-col gap-6'>
              {side.map(renderSection)}
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
