/**
 * #1176 — the driver-level configuration cache on the database node: how many configuration
 * reads were answered from memory over the window, how often a write cleared it, and a hit-rate
 * sparkline that carries the change markers (each configuration-epoch move names the table), so
 * a latency bump right after a configuration edit explains itself.
 */
import { useTrafficMap } from '../../context'
import { Empty, Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { Sparkline } from '../../Sparkline'
import { inPage } from '../b1-shared'
import { hitRateSeries, type MetadataCacheFigures, pct } from './logic'
import { useDbLens } from './shared'
import { Figures } from './ui'

function MetadataCachePanel() {
  const { model, win } = useTrafficMap()
  const { data, loading } = useDbLens<MetadataCacheFigures>('metadata-cache', {
    params: { window: win },
    every: 10_000
  })
  const minutes = Math.round(win / 60)
  const title = `Configuration cache · last ${minutes} min`
  if (loading && !data)
    return (
      <Section title={title}>
        <Empty>Reading the cache counters…</Empty>
      </Section>
    )
  if (!data) return null
  const reads = data.hits + data.misses
  const low = data.hit_rate != null && reads >= 20 && data.hit_rate < 0.6
  const to = model.now * 1000
  return (
    <Section title={title}>
      <div
        className='grid gap-2 text-[12px]'
        id='tm-metadata-cache'
        data-tm-cache-hit={data.hit_rate ?? ''}
      >
        {!data.enabled ? (
          <Empty>The configuration cache is switched off (METADATA_QUERY_CACHE=off).</Empty>
        ) : (
          <>
            <Figures
              items={[
                ['From memory', data.hit_rate == null ? '—' : pct(data.hit_rate), low],
                ['Reads', reads.toLocaleString()],
                ['Cleared', data.clears.toLocaleString(), data.clears > 0 && low]
              ]}
            />
            {data.series.some((v) => v != null) && (
              <Sparkline
                data={hitRateSeries(data.series)}
                color='var(--tm-accent)'
                className='h-[26px] w-full'
                range={{ from: to - win * 1000, to }}
              />
            )}
            <p className='text-[11.5px] text-[var(--tm-muted)]'>
              {data.hits.toLocaleString()} answered from memory, {data.misses.toLocaleString()} read
              from the database
              {data.shared > 0
                ? `, ${data.shared.toLocaleString()} joined a read already running`
                : ''}
              . {data.entries.toLocaleString()} statements held for {Math.round(data.ttl_ms / 1000)}{' '}
              s.
              {data.clears > 0
                ? ' A configuration write empties it — the markers on the line show when.'
                : ''}
            </p>
            {data.epoch.last_moved_at && (
              <p className='text-[11.5px] text-[var(--tm-muted)]'>
                Last configuration change{' '}
                {new Date(data.epoch.last_moved_at).toTimeString().slice(0, 5)}
                {data.epoch.seen != null ? ` (epoch ${data.epoch.seen})` : ''}.
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'db-metadata-cache',
  order: 8,
  applies: (sel) => sel.kind === 'down' && sel.id === 'db',
  Component: inPage(MetadataCachePanel)
})
