import { useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'

/**
 * BaseMap — the hand-rolled OSM slippy-map core (tile math, drag,
 * wheel-zoom-at-cursor, grid clustering) extracted from MapView so the
 * Command Center's live map and the collection browser's map view share one
 * engine. Takes concrete pins/bubbles; owns NO data fetching.
 *
 * Layers:
 *  - `pins`: record markers (color per pin, optional pulse for "on fire").
 *    Pins within ~44px cluster into a count disc; clicking a cluster zooms.
 *  - `bubbles`: region-level aggregates (the people-online layer) — a
 *    translucent disc sized by count with the label under it. Bubbles never
 *    cluster; they ARE the aggregation.
 */

const TILE = 256
const TILE_URL = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`

function lon2x(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z
}
function lat2y(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
}
function x2lon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180
}
function y2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

export interface BaseMapPin {
  id: string
  lat: number
  lng: number
  label: string
  /** Marker fill — defaults to the brand cyan. */
  color?: string
  /** Pulsing ring — SLA breach / needs-eyes markers. */
  pulse?: boolean
}

export interface BaseMapBubble {
  id: string
  lat: number
  lng: number
  count: number
  label: string
  color?: string
}

export function BaseMap({
  pins,
  bubbles = [],
  statusLine,
  onPinClick,
  onBubbleClick,
  minHeight = 420,
  focus = null
}: {
  pins: BaseMapPin[]
  bubbles?: BaseMapBubble[]
  /** Bottom-left caption ("214 pinned · © OpenStreetMap"). */
  statusLine?: string
  onPinClick?: (id: string) => void
  onBubbleClick?: (id: string) => void
  minHeight?: number
  /** Fly the view somewhere (People-pane region click). Nonce forces re-focus
   *  on repeat clicks of the same target. */
  focus?: { lat: number; lng: number; zoom?: number; nonce: number } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 520 })
  const [view, setView] = useState<{ lat: number; lng: number; zoom: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number; lat: number; lng: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit bounds once when the first geometry lands (pins or bubbles).
  const fitted = useRef(false)
  useEffect(() => {
    const all = [...pins, ...bubbles]
    if (fitted.current || all.length === 0) return
    fitted.current = true
    const lats = all.map((p) => p.lat)
    const lngs = all.map((p) => p.lng)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const minLng = Math.min(...lngs)
    const maxLng = Math.max(...lngs)
    const center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }
    let zoom = 15
    while (zoom > 3) {
      const wTiles = Math.abs(lon2x(maxLng, zoom) - lon2x(minLng, zoom)) * TILE
      const hTiles = Math.abs(lat2y(minLat, zoom) - lat2y(maxLat, zoom)) * TILE
      if (wTiles < size.w * 0.85 && hTiles < size.h * 0.85) break
      zoom--
    }
    setView({ ...center, zoom })
  }, [pins, bubbles, size])

  useEffect(() => {
    if (!focus) return
    setView({ lat: focus.lat, lng: focus.lng, zoom: focus.zoom ?? 8 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  const v = view ?? { lat: 39.5, lng: -98.35, zoom: 4 }
  const cx = lon2x(v.lng, v.zoom)
  const cy = lat2y(v.lat, v.zoom)

  const tiles: Array<{ z: number; x: number; y: number; left: number; top: number }> = []
  const half = 2 ** v.zoom
  const x0 = Math.floor(cx - size.w / 2 / TILE)
  const x1 = Math.ceil(cx + size.w / 2 / TILE)
  const y0 = Math.max(0, Math.floor(cy - size.h / 2 / TILE))
  const y1 = Math.min(half - 1, Math.ceil(cy + size.h / 2 / TILE))
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const wrapped = ((tx % half) + half) % half
      tiles.push({
        z: v.zoom,
        x: wrapped,
        y: ty,
        left: size.w / 2 + (tx - cx) * TILE,
        top: size.h / 2 + (ty - cy) * TILE
      })
    }
  }

  const project = (lat: number, lng: number) => ({
    x: size.w / 2 + (lon2x(lng, v.zoom) - cx) * TILE,
    y: size.h / 2 + (lat2y(lat, v.zoom) - cy) * TILE
  })

  // Grid clustering for PINS only.
  const clusters = useMemo(() => {
    const CELL = 44
    const byCell = new Map<string, { pins: BaseMapPin[]; sx: number; sy: number }>()
    for (const p of pins) {
      const { x: px, y: py } = project(p.lat, p.lng)
      if (px < -60 || px > size.w + 60 || py < -60 || py > size.h + 60) continue
      const key = `${Math.round(px / CELL)}:${Math.round(py / CELL)}`
      const c = byCell.get(key) ?? { pins: [], sx: 0, sy: 0 }
      c.pins.push(p)
      c.sx += px
      c.sy += py
      byCell.set(key, c)
    }
    return [...byCell.values()].map((c) => ({
      pins: c.pins,
      x: c.sx / c.pins.length,
      y: c.sy / c.pins.length
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, v, cx, cy, size])

  const zoomBy = (delta: number, at?: { x: number; y: number }) => {
    setView((prev) => {
      const cur = prev ?? v
      const nz = Math.max(2, Math.min(18, cur.zoom + delta))
      if (nz === cur.zoom) return cur
      if (at) {
        const wx = lon2x(cur.lng, cur.zoom) + (at.x - size.w / 2) / TILE
        const wy = lat2y(cur.lat, cur.zoom) + (at.y - size.h / 2) / TILE
        const scale = 2 ** (nz - cur.zoom)
        return {
          lng: x2lon(wx * scale - (at.x - size.w / 2) / TILE, nz),
          lat: y2lat(wy * scale - (at.y - size.h / 2) / TILE, nz),
          zoom: nz
        }
      }
      return { ...cur, zoom: nz }
    })
  }

  return (
    <div
      ref={containerRef}
      className='relative h-full w-full cursor-grab overflow-hidden rounded-lg border border-slate-200 bg-slate-100 active:cursor-grabbing dark:border-border dark:bg-muted'
      style={{ minHeight }}
      data-base-map
      onPointerDown={(e) => {
        dragRef.current = { x: e.clientX, y: e.clientY, lat: v.lat, lng: v.lng }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (!d) return
        const dx = (e.clientX - d.x) / TILE
        const dy = (e.clientY - d.y) / TILE
        setView({
          zoom: v.zoom,
          lng: x2lon(lon2x(d.lng, v.zoom) - dx, v.zoom),
          lat: y2lat(lat2y(d.lat, v.zoom) - dy, v.zoom)
        })
      }}
      onPointerUp={() => {
        dragRef.current = null
      }}
      onWheel={(e) => {
        e.preventDefault()
        const rect = containerRef.current?.getBoundingClientRect()
        zoomBy(e.deltaY < 0 ? 1 : -1, rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined)
      }}
    >
      {tiles.map((t) => (
        <img
          key={`${t.z}/${t.x}/${t.y}`}
          src={TILE_URL(t.z, t.x, t.y)}
          alt=''
          draggable={false}
          className='pointer-events-none absolute select-none'
          style={{ left: t.left, top: t.top, width: TILE, height: TILE }}
        />
      ))}

      {/* Region bubbles (people layer) — rendered UNDER pins. */}
      {bubbles.map((b) => {
        const { x, y } = project(b.lat, b.lng)
        if (x < -120 || x > size.w + 120 || y < -120 || y > size.h + 120) return null
        const r = Math.min(56, 18 + Math.sqrt(b.count) * 7)
        const color = b.color ?? '#00a5cc'
        return (
          <button
            key={`bubble-${b.id}`}
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onBubbleClick?.(b.id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className='absolute z-[1] -translate-x-1/2 -translate-y-1/2'
            style={{ left: x, top: y }}
            data-tip={`${b.label} — ${b.count} online`}
          >
            <span
              className='flex items-center justify-center gap-0.5 rounded-full font-bold text-white'
              style={{
                width: r * 2,
                height: r * 2,
                background: `${color}45`,
                border: `2.5px dashed ${color}`,
                boxShadow: `0 0 0 3px ${color}22`,
                fontSize: Math.max(12, Math.min(18, r / 2)),
                textShadow: '0 1px 2px rgba(0,0,0,0.55)'
              }}
            >
              <svg width='12' height='12' viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'>
                <path d='M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z' />
              </svg>
              {b.count}
            </span>
            <span
              className='mt-0.5 block whitespace-nowrap text-center text-[10.5px] font-semibold'
              style={{ color, textShadow: '0 0 3px #fff, 0 0 3px #fff' }}
            >
              {b.label}
            </span>
          </button>
        )
      })}

      {clusters.map((c) =>
        c.pins.length === 1 ? (
          <button
            key={c.pins[0].id}
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onPinClick?.(c.pins[0].id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className='group absolute z-[2] -translate-x-1/2 -translate-y-full'
            style={{ left: c.x, top: c.y }}
            data-tip={c.pins[0].label}
          >
            {c.pins[0].pulse && (
              <span
                className='absolute left-1/2 top-[10px] h-6 w-6 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full'
                style={{ background: `${c.pins[0].color ?? '#ef4444'}66` }}
              />
            )}
            <svg width='24' height='30' viewBox='0 0 24 30' aria-hidden='true' className='relative'>
              <path
                d='M12 0C5.4 0 0 5.4 0 12c0 8.4 12 18 12 18s12-9.6 12-18C24 5.4 18.6 0 12 0z'
                fill={c.pins[0].color ?? '#00a5cc'}
                stroke='#fff'
                strokeWidth='1.5'
              />
              <circle cx='12' cy='12' r='4.5' fill='#fff' />
            </svg>
          </button>
        ) : (
          <button
            key={`c-${c.pins[0].id}`}
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              setView({
                lat: y2lat(cy + (c.y - size.h / 2) / TILE, v.zoom),
                lng: x2lon(cx + (c.x - size.w / 2) / TILE, v.zoom),
                zoom: Math.min(18, v.zoom + 2)
              })
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className='absolute z-[2] flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-[12px] font-bold text-white shadow-md'
            style={{
              left: c.x,
              top: c.y,
              background: c.pins.some((p) => p.pulse) ? '#ef4444' : (c.pins[0].color ?? '#00a5cc')
            }}
            data-tip={`${c.pins.length} records — click to zoom`}
          >
            {c.pins.length}
          </button>
        )
      )}

      <div className='absolute right-3 top-3 z-[3] flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow dark:border-border dark:bg-card'>
        <button
          type='button'
          onClick={() => zoomBy(1)}
          onPointerDown={(e) => e.stopPropagation()}
          className='flex h-8 w-8 items-center justify-center text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-muted'
          aria-label='Zoom in'
        >
          <Plus className='h-4 w-4' />
        </button>
        <button
          type='button'
          onClick={() => zoomBy(-1)}
          onPointerDown={(e) => e.stopPropagation()}
          className='flex h-8 w-8 items-center justify-center border-t border-slate-100 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
          aria-label='Zoom out'
        >
          <Minus className='h-4 w-4' />
        </button>
      </div>
      {statusLine && (
        <div className='absolute bottom-2 left-2 z-[3] rounded bg-white/85 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-card/85 dark:text-slate-400'>
          {statusLine}
        </div>
      )}
    </div>
  )
}
