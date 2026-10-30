import { useCcQuery } from '../api'
import { useCc } from '../state'
import { FAINT, FOCUS, PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { WorkloadRow } from '../types'

/**
 * Workload (CC-32): per person, open records they own now as a bar, with a tick at their usual
 * load and the status in words (Over usual / Idle / Out). Administrators see everyone; managers
 * see their direct reports; anyone else gets nothing (the API answers 403 and the panel drops
 * out). A name opens that person's page.
 */
const STATUS: Record<WorkloadRow['status'], { word: string; tone: string; bar: string }> = {
  over: { word: 'Over usual', tone: 'text-[var(--cc-warn-text)]', bar: 'bg-amber-500' },
  normal: { word: '', tone: 'text-[var(--cc-muted)]', bar: 'bg-nvr-cyan' },
  idle: { word: 'Idle', tone: 'text-[var(--cc-muted)]', bar: 'bg-nvr-cyan' }
}

export function WorkloadPanel() {
  const cc = useCc()
  const q = useCcQuery<WorkloadRow[]>('/workload', undefined, {
    refetchInterval: 120_000,
    retry: false
  })
  if (q.isError) return null
  const rows = q.data ?? []
  if (!q.isLoading && rows.length === 0) return null
  const max = Math.max(1, ...rows.map((r) => Math.max(r.open, r.usual)))
  const over = rows.filter((r) => r.status === 'over').length
  return (
    <section className={PANEL} data-cc-panel='workload' aria-busy={q.isLoading}>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Workload</h2>
        <span className={`text-[11px] ${FAINT}`}>
          {over > 0 ? `${over} over usual` : 'open now · tick = usual'}
        </span>
      </div>
      <ul className='max-h-[320px] space-y-1.5 overflow-y-auto p-3'>
        {rows.map((r) => {
          const s = STATUS[r.status]
          const word = r.out ? (s.word ? `Out · ${s.word}` : 'Out') : s.word
          return (
            <li key={r.user_id} className='text-[11.5px]'>
              <div className='flex items-baseline gap-2'>
                <button
                  type='button'
                  onClick={() => cc.navigate(`/users/${encodeURIComponent(r.user_id)}`)}
                  className={`min-w-0 flex-1 truncate rounded text-left text-[var(--cc-text)] hover:underline ${FOCUS}`}
                >
                  {r.name}
                </button>
                {word && (
                  <span className={`shrink-0 ${r.out ? 'text-[var(--cc-muted)]' : s.tone}`}>
                    {word}
                  </span>
                )}
                <span
                  className='w-[64px] shrink-0 text-right tabular-nums text-[var(--cc-text)]'
                  data-tip={
                    r.usual_source === 'team'
                      ? 'Usual = the median across these people until their own history builds up'
                      : 'Usual = their median over the last 28 days'
                  }
                >
                  <b>{r.open}</b> <span className={FAINT}>/ {Math.round(r.usual)}</span>
                </span>
              </div>
              <div
                className='relative mt-0.5 h-1.5 rounded-full bg-[var(--cc-chip)]'
                role='img'
                aria-label={`${r.name}: ${r.open} open, usually ${Math.round(r.usual)}${word ? `, ${word}` : ''}`}
              >
                <div
                  className={`h-full rounded-full ${s.bar} ${r.out ? 'opacity-50' : ''}`}
                  style={{ width: `${(r.open / max) * 100}%` }}
                />
                <div
                  className='absolute top-[-2px] h-[10px] w-[2px] rounded bg-[var(--cc-strong)]'
                  style={{ left: `calc(${(r.usual / max) * 100}% - 1px)` }}
                  aria-hidden
                />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
