import { useCc } from '../state'
import { FAINT, PANEL, PANEL_HEAD, TITLE } from '../theme'

/** Pipeline flow: open records per state for every workflow-bound collection the viewer reads. */
export function FlowPanel() {
  const { snapshot: snap, navigate } = useCc()
  const flow = snap?.flow ?? []
  return (
    <section className={PANEL} data-cc-panel='flow'>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Pipeline flow</h2>
      </div>
      <div className='space-y-3 p-3'>
        {flow.map((f) => {
          const total = f.states.reduce((a, s) => a + s.count, 0)
          return (
            <div key={f.collection}>
              <div className='mb-1 flex items-baseline justify-between'>
                <span className='text-[12px] font-medium text-[var(--cc-text)]'>
                  {f.template_name}
                </span>
                <span className={`text-[11px] tabular-nums ${FAINT}`}>{total} open</span>
              </div>
              <div className='flex h-2.5 overflow-hidden rounded-full bg-[var(--cc-chip)]'>
                {f.states.map((s) => (
                  <button
                    key={s.key}
                    type='button'
                    onClick={() => navigate(`/collections/${f.collection}`)}
                    className='h-full transition-opacity hover:opacity-75'
                    style={{
                      width: `${Math.max(2, (s.count / Math.max(1, total)) * 100)}%`,
                      background: s.color ?? '#00a5cc'
                    }}
                    aria-label={`${s.label}: ${s.count}`}
                    data-tip={`${s.label}: ${s.count}`}
                  />
                ))}
              </div>
              <div className='mt-1 flex flex-wrap gap-x-3 gap-y-0.5'>
                {f.states.map((s) => (
                  <span
                    key={s.key}
                    className='flex items-center gap-1 text-[11px] text-[var(--cc-muted)]'
                  >
                    <span
                      className='h-1.5 w-1.5 rounded-full'
                      style={{ background: s.color ?? '#00a5cc' }}
                    />
                    {s.label} <b className='tabular-nums text-[var(--cc-text)]'>{s.count}</b>
                  </span>
                ))}
              </div>
            </div>
          )
        })}
        {flow.length === 0 && (
          <p className={`text-[12px] ${FAINT}`}>No workflow-bound collections visible to you.</p>
        )}
      </div>
    </section>
  )
}
