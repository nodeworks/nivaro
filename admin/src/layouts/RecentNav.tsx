import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { recordHref, useRecentViews, useRefreshRecentOnRecordOpen } from '@/lib/recent-views'
import { cn, formatRelative, titleCase } from '@/lib/utils'

const COLLAPSED_KEY = 'nivaro-nav-recent-collapsed'
const LIMIT = 5

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * #3226 — "Recent" at the foot of the sidebar panel: the last five records the
 * person opened (the home rail's store), each with its pipeline state and a
 * dot when someone else changed it since they last looked. Collapsible; the
 * choice is per browser. Always-dark surface (the sidebar), so no light pairs.
 */
export function RecentNav() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const { pathname } = useLocation()
  useRefreshRecentOnRecordOpen()
  const { data: rows = [], isLoading } = useRecentViews(LIMIT)

  if (!isLoading && rows.length === 0) return null

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next))
      } catch {
        /* per-browser nicety only */
      }
      return next
    })
  }

  return (
    <div className='mt-4 border-t border-white/[0.07] pt-2' data-nav-recent>
      <button
        type='button'
        onClick={toggle}
        aria-expanded={!collapsed}
        className='flex w-full items-center gap-1 px-4 pb-1 text-left text-[11px] font-semibold text-slate-400 transition-colors hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60'
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', !collapsed && 'rotate-90')}
          aria-hidden
        />
        Recent
      </button>
      {!collapsed && (
        <ul className='space-y-px'>
          {isLoading
            ? Array.from({ length: 3 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows
                <li key={i} className='px-4 py-[7px]'>
                  <span className='block h-3 w-3/4 animate-pulse rounded bg-white/[0.08]' />
                </li>
              ))
            : rows.map((r) => {
                const to = recordHref(r)
                const active = pathname === to
                return (
                  <li key={`${r.collection}:${r.item_id}`}>
                    <Link
                      to={to}
                      aria-current={active ? 'page' : undefined}
                      data-nav-recent-row={`${r.collection}:${r.item_id}`}
                      data-tip={`${titleCase(r.collection)} · opened ${formatRelative(r.last_viewed_at)}${
                        r.changed ? ' · changed since you looked' : ''
                      }`}
                      className={cn(
                        'relative flex items-center gap-2 px-4 py-[6px] text-[12.5px] leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60',
                        active
                          ? 'bg-nvr-cyan/[0.12] text-nvr-cyan'
                          : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          r.changed ? 'bg-nvr-cyan' : 'bg-transparent'
                        )}
                        aria-hidden
                      />
                      {r.changed && <span className='sr-only'>Changed since you looked: </span>}
                      <span className='min-w-0 flex-1 truncate'>{r.label}</span>
                      {r.state && (
                        <span
                          className='max-w-[64px] shrink-0 truncate rounded-full px-1.5 py-px text-[9.5px] font-semibold'
                          style={{
                            backgroundColor: `${r.state.color ?? '#94a3b8'}33`,
                            color: lighten(r.state.color)
                          }}
                        >
                          {r.state.label}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
        </ul>
      )}
    </div>
  )
}

/** State colours are picked for light backgrounds; mix toward white so they read on navy. */
function lighten(hex: string | null): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return '#cbd5e1'
  const n = Number.parseInt(m[1], 16)
  const mix = (c: number) => Math.round(c + (255 - c) * 0.45)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `rgb(${r}, ${g}, ${b})`
}
