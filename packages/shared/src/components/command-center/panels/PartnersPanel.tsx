import { useCcQuery } from '../api'
import { useCc } from '../state'
import { FAINT, FOCUS, PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { PartnerHealth } from '../types'
import { LiveOnlyBadge } from './TimeBar'

/** Shape + colour + word per status, so status never rides on colour alone. */
export const PARTNER_STATUS: Record<
  PartnerHealth['status'],
  { glyph: string; cls: string; word: string }
> = {
  ok: { glyph: '●', cls: 'text-[var(--cc-good-text)]', word: 'healthy' },
  degraded: { glyph: '▲', cls: 'text-[var(--cc-warn-text)]', word: 'degraded' },
  down: { glyph: '■', cls: 'text-[var(--cc-bad-text)]', word: 'failing' },
  unknown: { glyph: '○', cls: 'text-[var(--cc-faint)]', word: 'no calls today' }
}

/**
 * Partners strip (CC-14) — administrators only: one row of health marks, one per partner, with
 * open problems, each opening the Integrations console. Live only (the console keeps no
 * per-instant partner history).
 */
export function PartnersPanel() {
  const cc = useCc()
  const admin = cc.isAdmin || !!cc.snapshot?.health
  const { data } = useCcQuery<PartnerHealth[]>('/partners', undefined, {
    enabled: admin,
    refetchInterval: 60_000,
    staleTime: 30_000
  })
  if (!admin || !data || data.length === 0) return null
  const bad = data.filter((p) => p.status === 'down' || p.status === 'degraded').length
  const open = (href: string | null) => cc.navigate(href ?? '/integration-health?tab=partners')
  return (
    <section className={PANEL} data-cc-panel='partners' aria-label='Partners'>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Partners</h2>
        <span className='flex items-center gap-2'>
          {cc.at != null && <LiveOnlyBadge />}
          <span className={`text-[11.5px] ${FAINT}`}>
            {bad === 0 ? 'All healthy' : `${bad} not healthy`}
          </span>
        </span>
      </div>
      <ul className='flex flex-wrap gap-1.5 p-2.5'>
        {data.map((p) => {
          const s = PARTNER_STATUS[p.status]
          return (
            <li key={p.key}>
              <button
                type='button'
                onClick={() => open(p.href)}
                className={`flex items-center gap-1.5 rounded-full bg-[var(--cc-chip)] px-2 py-0.5 text-[11.5px] text-[var(--cc-text)] hover:bg-[var(--cc-chip-hover)] ${FOCUS}`}
                aria-label={`${p.label}: ${s.word}${p.open_problems ? `, ${p.open_problems} open problems` : ''}`}
                data-tip={
                  p.last_ok_at
                    ? `${s.word} · last worked ${new Date(p.last_ok_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                    : s.word
                }
              >
                <span aria-hidden className={`text-[10px] ${s.cls}`}>
                  {s.glyph}
                </span>
                <span className='max-w-[140px] truncate'>{p.label}</span>
                {p.open_problems > 0 && (
                  <span className='rounded-full bg-red-500/15 px-1.5 text-[10.5px] font-semibold tabular-nums text-[var(--cc-bad-text)]'>
                    {p.open_problems}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
