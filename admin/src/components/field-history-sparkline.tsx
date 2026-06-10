import { useQuery } from '@tanstack/react-query'
import { ChartLine, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface FieldHistoryEntry {
  revision_id: number
  timestamp: string
  value: unknown
  user_id: string | null
}

const W = 120
const H = 28
const PAD = 3

/**
 * Lazy inline sparkline of a numeric field's revision history.
 *
 * Renders a small chart toggle button (place next to the field label inside a
 * `flex flex-wrap` row); when opened it fetches
 * GET /items/:collection/:id/field-history/:field and draws a pure-SVG polyline
 * (nvr-cyan) with a dot on the latest point and a min/max/current tooltip.
 */
export function FieldHistorySparkline({
  collection,
  item,
  field
}: {
  collection: string
  item: string
  field: string
}) {
  const [open, setOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['field-history', collection, item, field],
    queryFn: () =>
      api
        .get<{ data: FieldHistoryEntry[] }>(
          `/items/${encodeURIComponent(collection)}/${encodeURIComponent(item)}/field-history/${encodeURIComponent(field)}`
        )
        .then((r) => r.data.data),
    enabled: open && !!collection && !!item && item !== 'new',
    staleTime: 30_000
  })

  if (!item || item === 'new') return null

  // API returns newest-first; reverse to chronological and keep numeric values only
  const points = (data ?? [])
    .slice()
    .reverse()
    .filter((e) => e.value !== null && e.value !== undefined && !Number.isNaN(Number(e.value)))
    .map((e) => ({ ts: e.timestamp, v: Number(e.value) }))

  let chart: React.ReactNode = null
  if (open) {
    if (isLoading) {
      chart = <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
    } else if (points.length < 2) {
      chart = (
        <span className='text-[10px] text-slate-400 italic'>
          {points.length === 0 ? 'No numeric history' : 'Only one recorded value'}
        </span>
      )
    } else {
      const values = points.map((p) => p.v)
      const min = Math.min(...values)
      const max = Math.max(...values)
      const current = values[values.length - 1]
      const range = max - min || 1
      const stepX = (W - PAD * 2) / (points.length - 1)
      const coords = points.map((p, i) => ({
        x: PAD + i * stepX,
        y: PAD + (1 - (p.v - min) / range) * (H - PAD * 2)
      }))
      const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
      const last = coords[coords.length - 1]
      const firstTs = points[0].ts
      const lastTs = points[points.length - 1].ts
      const tooltip = `min ${min} · max ${max} · current ${current}\n${points.length} revisions, ${formatRelative(firstTs)} → ${formatRelative(lastTs)}`

      chart = (
        <span className='inline-flex items-center gap-1.5' title={tooltip}>
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role='img'
            aria-label={`History of ${field}: min ${min}, max ${max}, current ${current}`}
            className='overflow-visible'
          >
            <polyline
              points={polyline}
              fill='none'
              stroke='#00ceff'
              strokeWidth={1.5}
              strokeLinejoin='round'
              strokeLinecap='round'
            />
            <circle cx={last.x} cy={last.y} r={2.5} fill='#00ceff' />
          </svg>
          <span className='font-mono text-[10px] text-slate-400 whitespace-nowrap'>
            {min} – {max}
          </span>
        </span>
      )
    }
  }

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center rounded px-1 py-0.5 transition-colors',
          open
            ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
            : 'text-slate-400 hover:bg-nvr-cyan/10 hover:text-nvr-cyan'
        )}
        title='Field change history'
        aria-expanded={open}
      >
        <ChartLine className='h-3 w-3' />
      </button>
      {open && <span className='inline-flex items-center'>{chart}</span>}
    </>
  )
}
