import { useCc } from '../state'
import { FAINT, PANEL, PANEL_HEAD, TITLE } from '../theme'

/** System rail — administrators only (the server withholds `health` otherwise). */
export function SystemPanel() {
  const { snapshot: snap } = useCc()
  const h = snap?.health
  if (!h) return null
  const dot = (ok: boolean) => `h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`
  return (
    <section className={PANEL} data-cc-panel='system'>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>System</h2>
        <span className={`text-[11px] ${FAINT}`}>{h.instances} instance(s)</span>
      </div>
      <div className='grid grid-cols-2 gap-x-4 gap-y-1.5 p-3 text-[12px] text-[var(--cc-text)]'>
        <span className='flex items-center gap-1.5'>
          <span className={dot(h.db_ok)} />
          Database
        </span>
        <span className='flex items-center gap-1.5'>
          <span className={dot(h.redis_ok)} />
          Redis
        </span>
        <span>
          Errors 1h: <b className='tabular-nums'>{h.errors_1h}</b>
          <span className={FAINT}> / {h.requests_1h.toLocaleString()} req</span>
        </span>
        <span>
          Jobs: <b className='tabular-nums'>{h.jobs_running}</b> running
          {h.jobs_failed_1h > 0 && (
            <b className='tabular-nums text-[var(--cc-warn-text)]'> · {h.jobs_failed_1h} failed</b>
          )}
        </span>
      </div>
    </section>
  )
}

/** One-line system status for the header (links into the Traffic Map). Slice 3 fills it in. */
export function SystemPill() {
  return null
}
