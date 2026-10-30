import { useCc } from '../state'
import { FAINT, PANEL, rel } from '../theme'

/** Live feed of recent business writes the viewer can read. */
export function FeedPanel() {
  const { snapshot: snap, setPeek } = useCc()
  const rows = snap?.activity ?? []
  return (
    <section className={`${PANEL} shrink-0`} data-cc-panel='feed'>
      <div className='flex items-center gap-3 overflow-x-auto px-3 py-2'>
        <h2 className='shrink-0 text-[12.5px] font-semibold text-[var(--cc-strong)]'>Live</h2>
        {rows.map((a) => (
          <button
            key={a.id}
            type='button'
            onClick={() =>
              a.collection && a.item ? setPeek({ collection: a.collection, id: a.item }) : undefined
            }
            className='flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--cc-chip)] px-2.5 py-1 text-[11.5px] text-[var(--cc-text)] hover:bg-[var(--cc-chip-hover)]'
          >
            <span className={`tabular-nums ${FAINT}`}>{rel(a.timestamp)}</span>
            {a.sentence ? (
              <span>{a.sentence}</span>
            ) : (
              <>
                <span className='font-medium'>{a.user_name || 'System'}</span>
                <span className='text-[var(--cc-muted)]'>{a.action.replace(/-/g, ' ')}</span>
                {a.collection && (
                  <span className='text-[var(--cc-muted)]'>
                    {a.collection.replace(/_/g, ' ')}
                    {a.item ? ` #${a.item}` : ''}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
        {rows.length === 0 && (
          <span className={`text-[12px] ${FAINT}`}>Quiet — no recent activity you can see.</span>
        )}
      </div>
    </section>
  )
}
