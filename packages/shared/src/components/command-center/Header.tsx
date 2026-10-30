import { useQueryClient } from '@tanstack/react-query'
import { RegionPicker } from './panels/RegionPicker'
import { SystemPill } from './panels/SystemPanel'
import { BriefButton, TimeBar } from './panels/TimeBar'
import { useCc } from './state'
import { BUTTON, FAINT } from './theme'

/** Board header: title, lenses (region, time), headline numbers, system pill, refresh. */
export function Header() {
  const cc = useCc()
  const qc = useQueryClient()
  const snap = cc.snapshot
  const t = snap?.throughput
  const delta = t ? t.transitions_today - t.transitions_yesterday_same_time : 0
  return (
    <header className='flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2'>
      <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-[var(--cc-strong)]'>
        Command Center
      </h1>
      <RegionPicker />
      <span className='flex items-center gap-1.5 text-[12.5px] text-[var(--cc-text)]'>
        <span className='h-2 w-2 rounded-full bg-[var(--cc-people)]' />
        {snap?.people.online_count ?? '–'} online
        {snap && snap.people.idle_count > 0 && (
          <span className={FAINT}>· {snap.people.idle_count} idle</span>
        )}
      </span>
      {t && (
        <span className='text-[12.5px] text-[var(--cc-text)]'>
          <b className='tabular-nums'>{t.transitions_today}</b> transitions today{' '}
          <span
            className={delta >= 0 ? 'text-[var(--cc-good-text)]' : 'text-[var(--cc-warn-text)]'}
          >
            ({delta >= 0 ? '+' : ''}
            {delta} vs yesterday)
          </span>
        </span>
      )}
      {snap && snap.risk.open_issues > 0 && (
        <button
          type='button'
          onClick={() => cc.navigate('/issues')}
          className='rounded-full bg-red-500/15 px-2.5 py-0.5 text-[12px] font-medium text-[var(--cc-bad-text)] hover:bg-red-500/25'
        >
          {snap.risk.open_issues} open issues
        </button>
      )}
      <SystemPill />
      <div className='ml-auto flex items-center gap-2'>
        <TimeBar />
        <BriefButton />
        <button
          type='button'
          onClick={() => void qc.invalidateQueries({ queryKey: ['command-center'] })}
          className={BUTTON}
        >
          Refresh
        </button>
      </div>
    </header>
  )
}
