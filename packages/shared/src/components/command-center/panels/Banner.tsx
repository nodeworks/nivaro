import { useArmedFaults } from '../../chaos/DrillBanner'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { FOCUS } from '../theme'
import { clockLabel, whenLabel } from '../time'
import type { BoardBannerState } from '../types'

export interface BannerLine {
  key: 'drill' | 'maintenance' | 'incident'
  tone: 'critical' | 'warning' | 'info'
  text: string
  href: string | null
  action: string | null
}

/** What the banner says, most serious first (pure). */
export function bannerLines(
  state: BoardBannerState | null | undefined,
  drills: Array<{ label: string; target: string; ends_at: number }>
): BannerLine[] {
  const out: BannerLine[] = []
  if (state?.incident)
    out.push({
      key: 'incident',
      tone: 'critical',
      text: `Incident open since ${whenLabel(new Date(state.incident.started_at).getTime())}: ${state.incident.title}`,
      href: state.incident.href,
      action: 'Open the incident'
    })
  if (state?.maintenance)
    out.push({
      key: 'maintenance',
      tone: 'warning',
      text: `Maintenance in progress${state.maintenance.until ? ` until ${whenLabel(new Date(state.maintenance.until).getTime())}` : ''} — saving changes is paused.${state.maintenance.message ? ` ${state.maintenance.message}` : ''}`,
      href: null,
      action: null
    })
  if (drills.length > 0) {
    const first = drills[0]
    out.push({
      key: 'drill',
      tone: 'info',
      text: `Practice drill running: ${first.label} on ${first.target}${drills.length > 1 ? ` (+${drills.length - 1} more)` : ''}, until ${clockLabel(first.ends_at)}. Some failures on this board are deliberate.`,
      href: null,
      action: null
    })
  }
  return out
}

const TONE: Record<BannerLine['tone'], { box: string; glyph: string; word: string }> = {
  critical: { box: 'bg-red-500/15 text-[var(--cc-bad-text)]', glyph: '■', word: 'Incident' },
  warning: { box: 'bg-amber-500/15 text-[var(--cc-warn-text)]', glyph: '▲', word: 'Maintenance' },
  info: { box: 'bg-nvr-cyan/10 text-[var(--cc-text)]', glyph: '◆', word: 'Drill' }
}

/**
 * Board banner (CC-20): a chaos drill running, maintenance mode on, or an open incident
 * (administrators). Mount it at the top of the board, under the header; it renders nothing in
 * the normal state. Drill data comes from the shared useArmedFaults() hook (socket + slow poll);
 * maintenance + incident from GET /command-center/banner. Always about now, even rewound.
 */
export function BoardBanner() {
  const cc = useCc()
  const { data } = useCcQuery<BoardBannerState>('/banner', undefined, {
    lenses: false,
    refetchInterval: 30_000,
    staleTime: 15_000
  })
  const { armed } = useArmedFaults()
  const lines = bannerLines(data, armed)
  if (lines.length === 0) return null
  return (
    <div className='flex shrink-0 flex-col gap-1.5' role='status' data-cc-banner=''>
      {lines.map((l) => {
        const t = TONE[l.tone]
        return (
          <div
            key={l.key}
            className={`relative flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] ${t.box}`}
          >
            <span aria-hidden className='text-[10px]'>
              {t.glyph}
            </span>
            <span className='sr-only'>{t.word}: </span>
            <span className='min-w-0 flex-1 font-medium'>{l.text}</span>
            {l.href && l.action && (
              <button
                type='button'
                className={`rounded px-1.5 text-[12px] font-semibold underline-offset-2 hover:underline ${FOCUS}`}
                onClick={() => cc.navigate(l.href as string)}
              >
                {l.action}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
