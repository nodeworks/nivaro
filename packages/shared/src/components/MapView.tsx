import { useQuery } from '@tanstack/react-query'
import { Minus, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'

/**
 * Map display mode (#19) for collections with lat/long columns: OSM raster
 * tiles + record pins with grid clustering, click-through to the record,
 * driven by whatever filters the browser currently has applied. Hand-rolled
 * slippy-map math — no mapping library, no bundled tiles.
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

interface Pin {
  id: string
  lat: number
  lng: number
  label: string
}

export function MapView({
  collection,
  latField,
  lngField,
  labelField,
  conditions,
  search,
  onOpen
}: {
  collection: string
  latField: string
  lngField: string
  /** Best available name-ish column for the pin tooltip. */
  labelField: string | null
  /** The browser's compiled conditions param — the map is filter-aware. */
  conditions: string | null
  search: string
  onOpen: (id: string) => void
}) {
  const client = useNivaroClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 520 })
  const [view, setView] = useState<{ lat: number; lng: number; zoom: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number; lat: number; lng: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['map-view', collection, latField, lngField, conditions, search],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${collection}`, {
            limit: 1000,
            fields: ['id', latField, lngField, ...(labelField ? [labelField] : [])].join(','),
            ...(conditions ? { conditions } : {}),
            ...(search ? { search } : {})
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000
  })

  const pins: Pin[] = useMemo(
    () =>
      rows
        .map((r) => ({
          id: String(r.id),
          lat: Number(r[latField]),
          lng: Number(r[lngField]),
          label: labelField && r[labelField] != null ? String(r[labelField]) : `#${r.id}`
        }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0)),
    [rows, latField, lngField, labelField]
  )

  // Fit the pin bounds once when data first lands.
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || pins.length === 0) return
    fitted.current = true
    const lats = pins.map((p) => p.lat)
    const lngs = pins.map((p) => p.lng)
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
  }, [pins, size])

  const v = view ?? { lat: 39.5, lng: -98.35, zoom: 4 }
  const cx = lon2x(v.lng, v.zoom)
  const cy = lat2y(v.lat, v.zoom)

  // Visible tile range.
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

  // Grid clustering: pins within ~44px share a marker.
  const clusters = useMemo(() => {
    const CELL = 44
    const byCell = new Map<string, { pins: Pin[]; sx: number; sy: number }>()
    for (const p of pins) {
      const px = size.w / 2 + (lon2x(p.lng, v.zoom) - cx) * TILE
      const py = size.h / 2 + (lat2y(p.lat, v.zoom) - cy) * TILE
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
  }, [pins, v, cx, cy, size])

  const zoomBy = (delta: number, at?: { x: number; y: number }) => {
    setView((prev) => {
      const cur = prev ?? v
      const nz = Math.max(2, Math.min(18, cur.zoom + delta))
      if (nz === cur.zoom) return cur
      if (at) {
        // Keep the point under the cursor stationary.
        const wx = lon2x(cur.lng, cur.zoom) + (at.x - size.w / 2) / TILE
        const wy = lat2y(cur.lat, cur.zoom) + (at.y - size.h / 2) / TILE
        const scale = 2 ** (nz - cur.zoom)
        const nwx = wx * scale
        const nwy = wy * scale
        return {
          lng: x2lon(nwx - (at.x - size.w / 2) / TILE, nz),
          lat: y2lat(nwy - (at.y - size.h / 2) / TILE, nz),
          zoom: nz
        }
      }
      return { ...cur, zoom: nz }
    })
  }

  return (
    <div
      ref={containerRef}
      className='relative h-full min-h-[420px] w-full cursor-grab overflow-hidden rounded-lg border border-slate-200 bg-slate-100 active:cursor-grabbing dark:border-border dark:bg-muted'
      data-map-view
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
      {clusters.map((c) =>
        c.pins.length === 1 ? (
          <button
            key={c.pins[0].id}
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onOpen(c.pins[0].id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className='group absolute z-[2] -translate-x-1/2 -translate-y-full'
            style={{ left: c.x, top: c.y }}
            data-tip={c.pins[0].label}
          >
            <svg width='24' height='30' viewBox='0 0 24 30' aria-hidden='true'>
              <path
                d='M12 0C5.4 0 0 5.4 0 12c0 8.4 12 18 12 18s12-9.6 12-18C24 5.4 18.6 0 12 0z'
                fill='#00a5cc'
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
              // Zoom toward the cluster until it breaks apart.
              setView({
                lat: y2lat(cy + (c.y - size.h / 2) / TILE, v.zoom),
                lng: x2lon(cx + (c.x - size.w / 2) / TILE, v.zoom),
                zoom: Math.min(18, v.zoom + 2)
              })
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className='absolute z-[2] flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[#00a5cc] text-[12px] font-bold text-white shadow-md'
            style={{ left: c.x, top: c.y }}
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
      <div className='absolute bottom-2 left-2 z-[3] rounded bg-white/85 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-card/85 dark:text-slate-400'>
        {isLoading ? 'Loading records…' : `${pins.length} pinned${rows.length >= 1000 ? ' (first 1,000)' : ''}`}
        {' · © OpenStreetMap'}
      </div>
    </div>
  )
}
