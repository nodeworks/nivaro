import { useCcQuery } from '../api'
import { useCc } from '../state'
import { FAINT, PANEL, PANEL_HEAD, TITLE } from '../theme'

/** People on now, grouped by office / region so the pane mirrors the map bubbles. */
export function PeoplePanel() {
  const cc = useCc()
  const snap = cc.snapshot
  const { data: centroids = [] } = useCcQuery<
    Array<{ id: number; label: string; lat: number; lng: number }>
  >('/people-geo', undefined, { staleTime: 10 * 60_000, lenses: false })
  const groups = snap?.people.regions ?? []
  return (
    <section className={PANEL} data-cc-panel='people'>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>People on now</h2>
        <span className={`text-[11px] tabular-nums ${FAINT}`}>
          {snap?.people.online_count ?? 0}
        </span>
      </div>
      <div className='space-y-2.5 p-3'>
        {groups.map((g) => {
          const centroid =
            g.region_id != null ? centroids.find((c) => String(c.id) === String(g.region_id)) : null
          const focus =
            g.lat != null && g.lng != null
              ? { lat: g.lat, lng: g.lng, zoom: 12 }
              : centroid
                ? { lat: centroid.lat, lng: centroid.lng, zoom: 8 }
                : null
          return (
            <div key={`${g.region_id ?? 'x'}:${g.label}`}>
              <button
                type='button'
                disabled={!focus}
                onClick={() => focus && cc.focusMap(focus)}
                className={`flex w-full items-center gap-1.5 text-left ${focus ? 'group cursor-pointer' : 'cursor-default'}`}
                data-tip={focus ? 'Show this group on the map' : 'No map placement for this group'}
              >
                <span className='h-2.5 w-2.5 rounded-full bg-[var(--cc-people)]' />
                <span className='text-[12px] font-semibold text-[var(--cc-people-text)] group-hover:underline'>
                  {g.label}
                </span>
                <span className={`text-[11px] tabular-nums ${FAINT}`}>{g.count}</span>
              </button>
              <div className='mt-1 flex flex-wrap gap-1.5 pl-4'>
                {g.names.map((n) => (
                  <span
                    key={n}
                    className='rounded-full bg-[var(--cc-chip)] px-2 py-0.5 text-[11.5px] text-[var(--cc-text)]'
                  >
                    {n}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
        {groups.length === 0 && <p className={`text-[12px] ${FAINT}`}>Nobody online right now.</p>}
      </div>
    </section>
  )
}
