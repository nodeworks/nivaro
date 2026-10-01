import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { fmtCount } from '../EventTicker'
import { register } from '../registry/registry'
import { stripTiles } from '../registry/stripTiles'
import { inMapOnly, LINK } from './ops-common'

/**
 * #1180 — open tabs per app still running an old frontend build (or loaded against an older API)
 * after a deploy. Both front ends send their build on every call (`x-nivaro-client`); the newest
 * page load of an app names its current build. Pairs with the redeploy banner and the
 * "reload old tabs only" control on /realtime.
 */
export const STALE_TABS_TAP = 'stale-tabs'

interface Build {
  build: string | null
  api: string | null
  tabs: number
  people: number
  current: boolean
  older: 'build' | 'api' | null
}
interface App {
  app: string
  tabs: number
  stale: number
  current_build: string | null
  builds: Build[]
}
export interface StaleTabs {
  apps: App[]
  tabs: number
  stale: number
}

/** One line per app with old tabs, e.g. "efp-new 3 of 12 on an older build". */
export function staleLines(d: StaleTabs | null | undefined): string[] {
  if (!d) return []
  return d.apps
    .filter((a) => a.stale > 0)
    .map((a) => {
      const reasons = new Set(a.builds.filter((b) => b.older).map((b) => b.older))
      const why =
        reasons.size === 1 && reasons.has('api')
          ? 'loaded before the API update'
          : 'on an older build'
      return `${a.app} ${fmtCount(a.stale)} of ${fmtCount(a.tabs)} ${why}`
    })
}

function tipFor(d: StaleTabs): string {
  return d.apps
    .map((a) => {
      const builds = a.builds
        .map(
          (b) =>
            `  ${b.build ?? 'unknown'}${b.older === 'api' && b.api ? ` (API ${b.api})` : ''}: ${b.tabs} tab${b.tabs === 1 ? '' : 's'}${b.current ? ' · current' : b.older ? ' · old' : ''}`
        )
        .join('\n')
      return `${a.app} — current ${a.current_build ?? 'unknown'}\n${builds}`
    })
    .join('\n')
}

function StaleTabsTile() {
  const { win, paused, ready } = useTrafficMap()
  const { data } = useQuery<StaleTabs | null>({
    queryKey: ['traffic-map', 'stale-tabs', win],
    queryFn: () =>
      api
        .get<{ data: StaleTabs | null }>(`/traffic-map/stale-tabs?window=${win}`)
        .then((r) => r.data.data ?? null),
    enabled: ready,
    refetchInterval: paused ? false : 10_000,
    staleTime: 8_000
  })
  const lines = staleLines(data)
  return (
    <div
      className='min-w-0 bg-[var(--tm-card)] px-3.5 pb-2.5 pt-2.5'
      id='tm-strip-stale-tabs'
      data-tm-stale-tabs={data?.stale ?? 0}
      data-tip={data ? tipFor(data) : undefined}
    >
      <div className='text-[12px] font-medium text-[var(--tm-muted)]'>Old tabs</div>
      <div
        className={`mt-1 text-[22px] font-semibold leading-tight tabular-nums ${
          data?.stale ? 'text-[var(--tm-update)]' : ''
        }`}
      >
        {data ? fmtCount(data.stale) : '—'}
        {data ? (
          <span className='ml-1 text-[12px] font-normal text-[var(--tm-muted)]'>
            of {fmtCount(data.tabs)} open
          </span>
        ) : null}
      </div>
      {lines.length ? (
        <p className='mt-0.5 truncate text-[11.5px] text-[var(--tm-fg-2)]'>
          {lines.slice(0, 2).join(' · ')} ·{' '}
          <Link to='/realtime' className={LINK} data-tm-stale-tabs-reload>
            reload them
          </Link>
        </p>
      ) : data ? (
        <p className='mt-0.5 truncate text-[11.5px] text-[var(--tm-muted)]'>
          Every open tab runs the current build.
        </p>
      ) : null}
    </div>
  )
}

register(stripTiles, { id: STALE_TABS_TAP, order: 60, Component: inMapOnly(StaleTabsTile) })
