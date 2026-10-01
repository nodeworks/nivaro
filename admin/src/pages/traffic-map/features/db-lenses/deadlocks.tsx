/**
 * #1171 — deadlock markers. Each deadlock SQL Server recorded (the same system_health events as
 * DB Health's deadlock panel) is a marker on every sparkline at the moment it happened, named by
 * the entities whose statements met; the database node's inspector lists them with links to
 * those entities and the statements.
 */
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import { fmtTime } from '../../EventTicker'
import { Empty, Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { addSparkMarkerSource, type SparkMarker } from '../../registry/sparkMarkers'
import { inPage, TAG } from '../b1-shared'
import { createMarkerSource } from '../change-markers'
import { LINK } from '../shared'
import { type DeadlockEvent, deadlockMarkers } from './logic'
import { useDbLens } from './shared'
import { Sql } from './ui'

async function fetchDeadlockMarkers(from: number, to: number): Promise<SparkMarker[]> {
  const res = await api.get('/traffic-map/db-lens/deadlocks', {
    params: { from: Math.round(from), to: Math.round(to) }
  })
  const events = (res?.data as { data?: { events?: DeadlockEvent[] } })?.data?.events
  return Array.isArray(events) ? deadlockMarkers(events) : []
}

addSparkMarkerSource('deadlocks', createMarkerSource(fetchDeadlockMarkers))

function DeadlocksPanel() {
  const { model, win, setSelection } = useTrafficMap()
  const to = model.now * 1000
  // a whole-minute range so the query key stays stable between frames
  const from = Math.floor((to - win * 1000) / 60_000) * 60_000
  const { data, loading } = useDbLens<{ available: boolean; events: DeadlockEvent[] }>(
    'deadlocks',
    {
      params: { from, to: Math.ceil(to / 60_000) * 60_000 },
      every: 30_000
    }
  )
  const events = data?.events ?? []
  return (
    <Section title='Deadlocks'>
      <div className='grid gap-1.5 text-[12px]' id='tm-deadlocks' data-tm-deadlocks={events.length}>
        {loading && !data ? (
          <Empty>Reading the server's deadlock record…</Empty>
        ) : data && !data.available ? (
          <Empty>The database login cannot read the deadlock record (VIEW SERVER STATE).</Empty>
        ) : events.length === 0 ? (
          <Empty>No deadlock in this window.</Empty>
        ) : (
          <ul className='grid gap-1.5'>
            {[...events]
              .reverse()
              .slice(0, 6)
              .map((e) => (
                <li
                  key={`${e.at}-${e.parties.map((p) => p.spid).join(',')}`}
                  className='grid min-w-0 gap-1 rounded-md border border-[var(--tm-line)] px-2 py-1.5'
                  data-tm-deadlock={e.at}
                >
                  <span className='flex items-baseline gap-2'>
                    <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                      {fmtTime(e.at)}
                    </span>
                    {e.objects.length ? (
                      <span
                        className='min-w-0 truncate font-mono text-[10.5px] text-[var(--tm-muted)]'
                        title={e.objects.join(', ')}
                      >
                        on {e.objects.join(', ')}
                      </span>
                    ) : null}
                  </span>
                  {e.parties.map((p, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the graph's process order is stable
                    <span key={i} className='grid min-w-0 gap-0.5'>
                      <span className='flex min-w-0 items-baseline gap-1.5'>
                        {p.entity ? (
                          <button
                            type='button'
                            className={`${LINK} min-w-0 truncate font-mono text-[11px]`}
                            onClick={() => setSelection({ kind: 'entity', id: p.entity as string })}
                          >
                            {p.entity}
                          </button>
                        ) : (
                          <span className='min-w-0 truncate text-[11.5px]'>{p.label}</span>
                        )}
                        {p.victim && (
                          <span className={TAG} data-tm-deadlock-victim=''>
                            victim
                          </span>
                        )}
                      </span>
                      <Sql text={p.sql} />
                    </span>
                  ))}
                </li>
              ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'db-deadlocks',
  order: 7,
  applies: (sel) => sel.kind === 'down' && sel.id === 'db',
  Component: inPage(DeadlocksPanel)
})
