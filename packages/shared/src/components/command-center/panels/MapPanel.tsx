import { useMemo } from 'react'
import { titleCase } from '../../../lib/utils'
import { BaseMap, type BaseMapBubble, type BaseMapPin } from '../../BaseMap'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { GeoPin } from '../types'

/** Live map: record pins for one geo collection + people bubbles (offices, then regions). */
export function MapPanel() {
  const cc = useCc()
  const { snapshot: snap, config, mapCollection } = cc
  const collections = config?.geo_collections ?? []
  const collection = mapCollection ?? collections[0]?.key ?? null
  const showRecords = !!collection
  const { data: geo } = useCcQuery<GeoPin[] & { truncated?: boolean }>(
    '/geo',
    { collection },
    { enabled: !!collection, refetchInterval: 60_000 }
  )
  const { data: centroids = [] } = useCcQuery<
    Array<{ id: number; label: string; lat: number; lng: number }>
  >('/people-geo', undefined, { staleTime: 10 * 60_000, lenses: false })

  const pins: BaseMapPin[] = useMemo(
    () =>
      (showRecords ? (geo ?? []) : []).map((p) => ({
        id: p.id,
        lat: p.lat,
        lng: p.lng,
        label: `${p.label}${p.state ? ` — ${p.state}` : ''}${p.sla === 'breached' ? ' · SLA breached' : p.sla === 'warning' ? ' · SLA warning' : ''}`,
        color:
          p.sla === 'breached'
            ? '#ef4444'
            : p.sla === 'warning'
              ? '#f59e0b'
              : (p.state_color ?? '#00a5cc'),
        pulse: p.sla === 'breached'
      })),
    [geo, showRecords]
  )
  const bubbles: BaseMapBubble[] = useMemo(() => {
    const offices: BaseMapBubble[] = (snap?.people.offices ?? []).map((o, i) => ({
      id: `office-${i}`,
      lat: o.lat,
      lng: o.lng,
      count: o.count,
      label: `${o.label}${o.names.length ? ` — ${o.names.slice(0, 5).join(', ')}${o.names.length > 5 ? ` +${o.names.length - 5}` : ''}` : ''}`,
      color: '#10b981'
    }))
    const counts = new Map(
      (snap?.people.by_region ?? []).map((r) => [String(r.region_id), r.count])
    )
    const regionBubbles = centroids
      .filter((c) => (counts.get(String(c.id)) ?? 0) > 0)
      .map((c) => ({
        id: String(c.id),
        lat: c.lat,
        lng: c.lng,
        count: counts.get(String(c.id)) ?? 0,
        label: c.label,
        color: '#10b981'
      }))
    return [...offices, ...regionBubbles]
  }, [centroids, snap])

  return (
    <div className={`${PANEL} flex min-h-[420px] flex-col overflow-hidden`} data-cc-panel='map'>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Live map</h2>
        <div className='flex items-center gap-2'>
          {collections.map((c) => (
            <button
              key={c.key}
              type='button'
              aria-pressed={collection === c.key}
              onClick={() => cc.setMapCollection(c.key)}
              className={`rounded px-2 py-0.5 text-[11px] ${collection === c.key ? 'bg-nvr-cyan font-medium text-[#172940]' : 'text-[var(--cc-muted)] hover:bg-[var(--cc-chip)]'}`}
            >
              {c.label || titleCase(c.key.replace(/_/g, ' '))}
            </button>
          ))}
        </div>
      </div>
      <div className='min-h-0 flex-1'>
        <BaseMap
          pins={pins}
          bubbles={bubbles}
          focus={cc.mapFocus}
          onPinClick={(id) => collection && cc.setPeek({ collection, id })}
          statusLine={`${showRecords ? `${pins.length} ${(collection ?? '').replace(/_/g, ' ')}${geo?.truncated ? ' (first 500)' : ''}` : 'No map collection'}${bubbles.length > 0 ? ` · ${bubbles.length} groups with people on` : ''} · © OpenStreetMap`}
          minHeight={380}
        />
      </div>
    </div>
  )
}
