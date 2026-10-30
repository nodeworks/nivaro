import { KeyRound, MapPinned, Settings2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn, titleCase } from '../../../lib/utils'
import { BaseMap, type BaseMapBubble, type BaseMapDot, type BaseMapPin } from '../../BaseMap'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { BUTTON, FAINT, FOCUS, MUTED, PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { GeoAnswer, GeoPin, MapLayerAnswer, MapLayerKind } from '../types'
import { BoardSettings } from './BoardSettings'
import { MapFilters, MapLegend } from './MapLegend'
import { MAP_COLORS, pinColor, slaRank, slaWords } from './map-shared'

/**
 * Live map (slice 1): record pins for one map collection (configured or detected) with state,
 * SLA and owner filters, people bubbles (offices, then regions), optional layers (SLA heat,
 * recent changes, people out today), a key, and — for administrators — Board settings. A tenant
 * with no geo collection gets a teaching empty state; the rest of the board works without a map.
 */

const LAYERS: Array<{ kind: MapLayerKind; label: string }> = [
  { kind: 'sla_heat', label: 'SLA heat' },
  { kind: 'activity', label: 'Recent changes' },
  { kind: 'out_today', label: 'Out today' }
]

function geoParams(collection: string | null, f: ReturnType<typeof useCc>['filters']) {
  const p: Record<string, unknown> = {}
  if (collection) p.collection = collection
  if (f.states.length) p.states = f.states.join(',')
  if (f.sla.length) p.sla = f.sla.join(',')
  if (f.owner) p.owner = f.owner
  return p
}

export function MapPanel() {
  const cc = useCc()
  const { snapshot: snap, config, mapCollection } = cc
  const collections = config?.geo_collections ?? []
  const collection = mapCollection ?? collections[0]?.key ?? null
  const canConfigure = !cc.kiosk && (cc.isAdmin || !!config?.can_configure)
  const [layers, setLayers] = useState<MapLayerKind[]>([])
  const [showKey, setShowKey] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const geoQ = useCcQuery<GeoAnswer>('/geo', geoParams(collection, cc.filters), {
    enabled: !!collection,
    refetchInterval: 60_000
  })
  const geo = geoQ.data
  const layerArgs = (kind: MapLayerKind) =>
    [
      { kind, ...(kind !== 'out_today' && collection ? { collection } : {}) },
      {
        enabled: layers.includes(kind) && (kind === 'out_today' || !!collection),
        refetchInterval: 60_000
      }
    ] as const
  const heat = useCcQuery<MapLayerAnswer>('/layers', ...layerArgs('sla_heat'))
  const activity = useCcQuery<MapLayerAnswer>('/layers', ...layerArgs('activity'))
  const out = useCcQuery<MapLayerAnswer>('/layers', ...layerArgs('out_today'))

  const pinById = useMemo(() => new Map((geo?.pins ?? []).map((p) => [p.id, p])), [geo])
  const pins: BaseMapPin[] = useMemo(
    () =>
      (geo?.pins ?? []).map((p) => {
        const words = [p.state, slaWords(p.sla), p.owner ? `owner ${p.owner}` : null].filter(
          Boolean
        )
        return {
          id: p.id,
          lat: p.lat,
          lng: p.lng,
          label: `${p.label}${words.length ? ` — ${words.join(' · ')}` : ''}`,
          color: pinColor(p),
          pulse: p.sla === 'breached'
        }
      }),
    [geo]
  )
  const clusterColor = (group: BaseMapPin[]) => {
    let worst: GeoPin | undefined
    for (const bp of group) {
      const p = pinById.get(bp.id)
      if (p && (!worst || slaRank(p.sla) > slaRank(worst.sla))) worst = p
    }
    return worst ? pinColor(worst) : (group[0].color ?? MAP_COLORS.ok)
  }

  const states = useMemo(() => {
    const m = new Map<string, { key: string; label: string; color: string | null }>()
    for (const p of geo?.pins ?? [])
      if (p.state_key && !m.has(p.state_key))
        m.set(p.state_key, {
          key: p.state_key,
          label: p.state ?? p.state_key,
          color: p.state_color
        })
    return [...m.values()]
  }, [geo])

  const bubbles: BaseMapBubble[] = useMemo(() => {
    const out: BaseMapBubble[] = []
    for (const [i, g] of (snap?.people.regions ?? []).entries()) {
      if (g.lat == null || g.lng == null || g.count === 0) continue
      out.push({
        id: g.region_id != null ? `region:${g.region_id}` : `office:${i}`,
        lat: g.lat,
        lng: g.lng,
        count: g.count,
        label: `${g.label}${g.names.length ? ` — ${g.names.slice(0, 5).join(', ')}${g.names.length > 5 ? ` and ${g.names.length - 5} more` : ''}` : ''}`,
        color: MAP_COLORS.people
      })
    }
    return out
  }, [snap])

  const dots: BaseMapDot[] = useMemo(() => {
    const d: BaseMapDot[] = []
    for (const p of heat.data?.points ?? [])
      d.push({
        id: `sla_heat:${p.id}`,
        lat: p.lat,
        lng: p.lng,
        label: p.label,
        weight: p.weight,
        color: (p.weight ?? 0) >= 1 ? MAP_COLORS.breached : MAP_COLORS.warning
      })
    for (const p of activity.data?.points ?? [])
      d.push({
        id: `activity:${p.id}`,
        lat: p.lat,
        lng: p.lng,
        label: p.label,
        weight: p.weight,
        color: MAP_COLORS.activity
      })
    for (const p of out.data?.points ?? [])
      d.push({
        id: `out_today:${p.id}`,
        lat: p.lat,
        lng: p.lng,
        label: p.label,
        weight: 0.5,
        color: MAP_COLORS.out
      })
    return d
  }, [heat.data, activity.data, out.data])

  const configLoaded = !!config
  const noGeo = configLoaded && collections.length === 0
  const regionNote =
    cc.region && geo && !geo.region_applies ? ' · region focus does not apply here' : ''
  const collectionLabel =
    collections.find((c) => c.key === collection)?.label ||
    titleCase((collection ?? '').replace(/_/g, ' '))

  const gear = canConfigure && (
    <button
      type='button'
      onClick={() => setSettingsOpen(true)}
      aria-label='Board settings'
      data-tip='Board settings — map collections, regions, stuck days'
      className={cn('rounded-md p-1 text-[var(--cc-muted)] hover:bg-[var(--cc-chip)]', FOCUS)}
    >
      <Settings2 className='h-4 w-4' />
    </button>
  )

  if (noGeo)
    return (
      <div className={`${PANEL} flex flex-col overflow-hidden`} data-cc-panel='map'>
        <div className={PANEL_HEAD}>
          <h2 className={TITLE}>Live map</h2>
          {gear}
        </div>
        <div className='flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center'>
          <MapPinned className='h-7 w-7 text-[var(--cc-faint)]' aria-hidden='true' />
          <p className='text-[13px] font-semibold text-[var(--cc-strong)]'>
            Nothing to put on the map yet
          </p>
          <p className={`max-w-[440px] text-[12px] leading-relaxed ${MUTED}`}>
            The map shows records from any collection that has a latitude and a longitude field —
            sites, offices, stores. Add those two number fields to a collection and fill them in,
            and its records appear here with their step and SLA. The rest of the board works without
            a map.
          </p>
          {canConfigure ? (
            <button
              type='button'
              onClick={() => cc.navigate('/collections')}
              className={cn(BUTTON, FOCUS, 'mt-1')}
            >
              Open the data model
            </button>
          ) : (
            <p className={`text-[11.5px] ${FAINT}`}>An administrator can add them.</p>
          )}
        </div>
        {settingsOpen && <BoardSettings onClose={() => setSettingsOpen(false)} />}
      </div>
    )

  return (
    <div className={`${PANEL} flex min-h-[420px] flex-col overflow-hidden`} data-cc-panel='map'>
      <div className={cn(PANEL_HEAD, 'flex-wrap')}>
        <h2 className={TITLE}>Live map</h2>
        <div className='flex flex-wrap items-center gap-1.5'>
          {collections.length > 1 &&
            collections.map((c) => (
              <button
                key={c.key}
                type='button'
                aria-pressed={collection === c.key}
                onClick={() => cc.setMapCollection(c.key)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px]',
                  FOCUS,
                  collection === c.key
                    ? 'bg-nvr-cyan font-medium text-[#172940]'
                    : 'text-[var(--cc-muted)] hover:bg-[var(--cc-chip)]'
                )}
              >
                {c.label || titleCase(c.key.replace(/_/g, ' '))}
              </button>
            ))}
          <span className='mx-1 h-4 w-px bg-[var(--cc-border)]' aria-hidden='true' />
          {LAYERS.filter((l) => !(cc.kiosk && l.kind === 'out_today')).map((l) => {
            const on = layers.includes(l.kind)
            return (
              <button
                key={l.kind}
                type='button'
                aria-pressed={on}
                onClick={() =>
                  setLayers((cur) => (on ? cur.filter((k) => k !== l.kind) : [...cur, l.kind]))
                }
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px]',
                  FOCUS,
                  on
                    ? 'border-nvr-cyan bg-nvr-cyan/15 font-medium text-[var(--cc-strong)]'
                    : 'border-[var(--cc-border)] text-[var(--cc-muted)] hover:bg-[var(--cc-chip)]'
                )}
              >
                {l.label}
              </button>
            )
          })}
          <button
            type='button'
            aria-pressed={showKey}
            aria-label='Map key'
            data-tip='What the colours mean'
            onClick={() => setShowKey((v) => !v)}
            className={cn(
              'rounded-md p-1 text-[var(--cc-muted)] hover:bg-[var(--cc-chip)]',
              FOCUS,
              showKey && 'bg-[var(--cc-chip)]'
            )}
          >
            <KeyRound className='h-4 w-4' />
          </button>
          {gear}
        </div>
      </div>
      <MapFilters states={states} pins={geo?.pins ?? []} />
      <div className='relative min-h-0 flex-1'>
        <BaseMap
          pins={pins}
          bubbles={bubbles}
          dots={dots}
          focus={cc.mapFocus}
          clusterColor={clusterColor}
          onPinClick={(id) => collection && cc.setPeek({ collection, id })}
          onDotClick={(id) => {
            const [kind, rid] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]
            if (kind !== 'out_today' && collection) cc.setPeek({ collection, id: rid })
          }}
          onBubbleClick={(id) => {
            const b = bubbles.find((x) => x.id === id)
            if (id.startsWith('region:') && !cc.kiosk) cc.setRegion(id.slice('region:'.length))
            if (b) cc.focusMap({ lat: b.lat, lng: b.lng, zoom: id.startsWith('region:') ? 8 : 12 })
          }}
          statusLine={`${!configLoaded ? 'Loading…' : `${pins.length} ${collectionLabel.toLowerCase()}${geo?.truncated ? ' (the first ones only)' : ''}`}${bubbles.length > 0 ? ` · ${bubbles.length} groups with people on` : ''}${regionNote}${geo?.live_only ? ' · live (the map does not rewind)' : ''} · © OpenStreetMap`}
          minHeight={380}
        />
        {showKey && (
          <div className='absolute bottom-8 right-3 z-[4]'>
            <MapLegend states={states} layers={layers} showPeople={bubbles.length > 0} />
          </div>
        )}
      </div>
      {settingsOpen && <BoardSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
