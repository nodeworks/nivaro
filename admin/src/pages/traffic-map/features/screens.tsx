import { Fragment, useState } from 'react'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { callerLabel, fmtCount } from '../EventTicker'
import { Bar, Empty, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { stripTiles } from '../registry/stripTiles'
import { inMapOnly, isObj, LINK, PanelCard, StripCell, useTmRoute } from './ops-common'

/**
 * Originating screen (#1113) and fan-out (#1116). The front ends send the route pattern of the
 * screen each call came from and one id per page load; the API groups calls by screen and by
 * load, and flags a screen whose load fires more calls than the limit.
 */

interface ScreenLoad {
  n: number
  at: number
  span_s: number
  caller: string
  routes: Array<{ route: string; n: number }>
  open?: boolean
}
interface ScreenRow {
  screen: string
  app: string | null
  path: string
  calls: number
  loads: number
  avg: number
  max: number
  over_limit: boolean
  worst: ScreenLoad | null
  callers: Array<{ key: string; n: number }>
}
interface ScreensReport {
  limit: number
  window_s: number
  screens: ScreenRow[]
  offenders: Array<{ screen: string; max: number; avg: number }>
  open_loads: number
}

function useScreens(): ScreensReport | null {
  const { win } = useTrafficMap()
  const { data } = useTmRoute<ScreensReport>(['screens', win], `/screens?window=${win}`, 5000)
  return isObj(data) && Array.isArray(data.screens) ? data : null
}

const APP_LABEL: Record<string, string> = { admin: 'Admin', 'efp-new': 'EFP portal' }
export function appLabel(app: string | null): string {
  return app ? (APP_LABEL[app] ?? app) : '—'
}

export function FanOutTile() {
  const r = useScreens()
  const worst = r?.offenders[0] ?? null
  const top = r?.screens.reduce<ScreenRow | null>((w, s) => (!w || s.max > w.max ? s : w), null)
  const shown =
    worst ?? (top && top.max > 0 ? { screen: top.screen, max: top.max, avg: top.avg } : null)
  return (
    <StripCell
      label='Fan-out'
      value={shown ? String(shown.max) : '—'}
      unit='calls in one load'
      tone={worst ? 'warn' : undefined}
      testId='tm-strip-fanout'
      className='md:col-span-3 min-[1280px]:col-span-2'
    >
      <span className='truncate' title={shown?.screen}>
        {shown ? (
          <>
            <span className='font-mono text-[11px]'>{shown.screen}</span>
            {shown.avg ? ` · ${shown.avg} on average` : ''}
          </>
        ) : r ? (
          'No screen sent page headers in this window'
        ) : (
          '—'
        )}
      </span>
      <span className='flex min-w-0 items-center justify-between gap-2'>
        <span className='truncate tabular-nums'>
          {r
            ? r.offenders.length
              ? `${r.offenders.length} ${r.offenders.length === 1 ? 'screen' : 'screens'} over ${r.limit} calls per load`
              : `No screen over ${r.limit} calls per load`
            : ''}
        </span>
        <a href='#tm-screens' className={`${LINK} shrink-0`}>
          Screens
        </a>
      </span>
    </StripCell>
  )
}

const TH = 'whitespace-nowrap px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--tm-muted)]'
/** Figure columns take only what they need; the screen column gets the rest. */
const NUM = 'w-px whitespace-nowrap px-2.5 py-1.5 text-right'

export function ScreensPanel() {
  const { catalog } = useTrafficMap()
  const r = useScreens()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <PanelCard
      title='Screens'
      id='tm-screens'
      hint={
        r
          ? `Calls by the screen they came from · a load is one page visit (flagged over ${r.limit} calls)`
          : 'Calls by the screen they came from'
      }
    >
      {!r ? (
        <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>Loading…</p>
      ) : r.screens.length === 0 ? (
        <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]' id='tm-screens-empty'>
          No calls with a screen header in this window. The admin and the EFP portal send one; API
          keys and scripts do not.
        </p>
      ) : (
        <div className='max-h-[340px] overflow-auto'>
          <table className='w-full border-collapse text-[12px] tabular-nums'>
            <thead className='sticky top-0'>
              <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)] text-left'>
                <th scope='col' className={TH}>
                  Screen
                </th>
                <th scope='col' className={`${TH} w-px text-right`}>
                  Calls
                </th>
                <th scope='col' className={`${TH} w-px text-right`}>
                  Loads
                </th>
                <th scope='col' className={`${TH} w-px text-right`}>
                  Per load
                </th>
                <th scope='col' className={`${TH} w-px text-right`}>
                  Worst
                </th>
              </tr>
            </thead>
            <tbody>
              {r.screens.map((s) => {
                const isOpen = open === s.screen
                return (
                  <Fragment key={s.screen}>
                    <tr
                      className={cn(
                        'border-b border-[var(--tm-line-2)]',
                        s.over_limit && 'bg-[var(--tm-error-soft)]'
                      )}
                      data-tm-screen={s.screen}
                    >
                      <td className='max-w-0 px-2.5 py-1.5'>
                        <button
                          type='button'
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : s.screen)}
                          className='flex w-full min-w-0 items-baseline gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                        >
                          <span className='shrink-0 text-[11px] text-[var(--tm-muted)]'>
                            {appLabel(s.app)}
                          </span>
                          <span className='min-w-0 truncate font-mono text-[11px]' title={s.path}>
                            {s.path}
                          </span>
                        </button>
                      </td>
                      <td className={NUM}>{fmtCount(s.calls)}</td>
                      <td className={NUM}>{fmtCount(s.loads)}</td>
                      <td className={NUM}>{s.avg ? s.avg : '—'}</td>
                      <td
                        className={cn(
                          NUM,
                          s.over_limit && 'font-semibold text-[var(--tm-error-ink)]'
                        )}
                      >
                        {s.max || '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className='border-b border-[var(--tm-line-2)] bg-[var(--tm-card-2)]'>
                        <td colSpan={5} className='px-3 py-2'>
                          <div className='grid gap-2 min-[700px]:grid-cols-2'>
                            <div className='grid gap-1.5'>
                              <div className='text-[11.5px] text-[var(--tm-muted)]'>
                                Worst load
                                {s.worst
                                  ? ` · ${s.worst.n} calls over ${s.worst.span_s} s${s.worst.open ? ' (still loading)' : ''} · ${callerLabel(catalog, s.worst.caller)}`
                                  : ''}
                              </div>
                              {s.worst?.routes.length ? (
                                s.worst.routes.map((rt) => (
                                  <Bar
                                    key={rt.route}
                                    label={rt.route}
                                    n={rt.n}
                                    max={s.worst?.routes[0].n ?? 1}
                                  />
                                ))
                              ) : (
                                <Empty>No load id on these calls.</Empty>
                              )}
                            </div>
                            <div className='grid content-start gap-1.5'>
                              <div className='text-[11.5px] text-[var(--tm-muted)]'>Callers</div>
                              {s.callers.map((c) => (
                                <Bar
                                  key={c.key}
                                  label={callerLabel(catalog, c.key)}
                                  n={c.n}
                                  max={s.callers[0].n}
                                  mono={false}
                                />
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  )
}

/** Inspector: which screens a caller called from, or which screens hit an entity. */
export function ScreensSection({ kind, id }: { kind: 'caller' | 'entity'; id: string }) {
  const { win } = useTrafficMap()
  const { data, loading } = useTmRoute<Array<{ screen: string; n: number }>>(
    ['screens-of', kind, id, win],
    `/screens/of?kind=${kind}&key=${encodeURIComponent(id)}&window=${win}`,
    5000
  )
  const rows = Array.isArray(data) ? data : []
  return (
    <Section title={kind === 'caller' ? 'Screens it called from' : 'Screens calling it'}>
      <div className='grid gap-1.5' data-tm-screens-of={kind}>
        {rows.length ? (
          rows.map((r) => <Bar key={r.screen} label={r.screen} n={r.n} max={rows[0].n} />)
        ) : (
          <Empty>{loading ? 'Loading…' : 'No calls with a screen header in this window.'}</Empty>
        )}
      </div>
    </Section>
  )
}

const CALLER_RE = /^(k\d+|u[0-9A-F-]{36})$/

register(stripTiles, { id: 'screens-fanout', order: 13, Component: inMapOnly(FanOutTile) })
register(pagePanels, { id: 'screens', order: 20, Component: inMapOnly(ScreensPanel) })
register(inspectorPanels, {
  id: 'screens',
  order: 40,
  applies: (sel) =>
    (sel.kind === 'caller' && CALLER_RE.test(sel.id)) ||
    (sel.kind === 'entity' && /^[a-z]+\/.+/.test(sel.id)),
  Component: ({ sel }) => (
    <ScreensSection kind={sel.kind === 'caller' ? 'caller' : 'entity'} id={sel.id} />
  )
})
