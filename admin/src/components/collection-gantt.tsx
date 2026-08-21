import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { renderDisplayTemplate } from '@/lib/relations'
import { cn } from '@/lib/utils'

/**
 * Gantt view over a start/end date-field pair. Window spans the fetched
 * records' range clipped to ±120 days around today; bars are pure CSS
 * percentages — no chart library.
 */

interface DateFieldOption {
  field: string
  label: string
}

const DAY = 86_400_000
const WINDOW_BACK = 30 * DAY
const WINDOW_FWD = 120 * DAY

export function CollectionGantt({
  collection,
  dateFields,
  displayTemplate
}: {
  collection: string
  dateFields: DateFieldOption[]
  displayTemplate: string | null
}) {
  const navigate = useNavigate()
  const [startField, setStartField] = useState(
    dateFields.find((f) => /start|begin|from/i.test(f.field))?.field ?? dateFields[0]?.field ?? ''
  )
  const [endField, setEndField] = useState(
    dateFields.find((f) => /end|due|finish|to|complete/i.test(f.field))?.field ??
      dateFields[1]?.field ??
      ''
  )

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['gantt', collection, startField, endField],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${collection}`, {
          params: {
            filter: JSON.stringify({ [startField]: { _nnull: true } }),
            limit: 200,
            sort: startField
          }
        })
        .then((r) => r.data.data ?? []),
    enabled: !!startField && !!endField && startField !== endField
  })

  const { rows, windowStart, windowEnd } = useMemo(() => {
    const now = Date.now()
    let min = now - WINDOW_BACK
    let max = now + WINDOW_FWD
    const parsed = items
      .map((it) => {
        const s = new Date(String(it[startField] ?? '')).getTime()
        const rawEnd = it[endField] ? new Date(String(it[endField])).getTime() : s + DAY
        if (Number.isNaN(s)) return null
        const e = Number.isNaN(rawEnd) || rawEnd <= s ? s + DAY : rawEnd
        return { it, s, e }
      })
      .filter((r): r is { it: Record<string, unknown>; s: number; e: number } => r !== null)
      .filter((r) => r.e >= min && r.s <= max)
      .sort((a, b) => a.s - b.s)
      .slice(0, 100)
    if (parsed.length > 0) {
      min = Math.max(Math.min(...parsed.map((r) => r.s)) - 2 * DAY, now - 365 * DAY)
      max = Math.min(Math.max(...parsed.map((r) => r.e)) + 2 * DAY, now + 365 * DAY)
    }
    return { rows: parsed, windowStart: min, windowEnd: max }
  }, [items, startField, endField])

  const span = windowEnd - windowStart
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - windowStart) / span) * 100))
  const todayPct = pct(Date.now())

  const label = (it: Record<string, unknown>) => {
    const t = displayTemplate ? renderDisplayTemplate(displayTemplate, it) : null
    return (
      (t && t.trim()) ||
      String(it.title ?? it.name ?? it.label ?? it.subject ?? `#${String(it.id)}`)
    )
  }

  // Month ticks
  const ticks: Array<{ pct: number; label: string }> = []
  const tick = new Date(windowStart)
  tick.setDate(1)
  tick.setHours(0, 0, 0, 0)
  if (tick.getTime() < windowStart) tick.setMonth(tick.getMonth() + 1)
  while (tick.getTime() < windowEnd) {
    ticks.push({
      pct: pct(tick.getTime()),
      label: tick.toLocaleDateString(undefined, { month: 'short' })
    })
    tick.setMonth(tick.getMonth() + 1)
  }

  if (dateFields.length < 2) {
    return (
      <p className='p-8 text-center text-[13px] text-slate-400'>
        The Gantt view needs two date fields (start and end) on this collection.
      </p>
    )
  }

  const FieldToggle = ({
    value,
    onChange,
    exclude
  }: {
    value: string
    onChange: (v: string) => void
    exclude: string
  }) => (
    <div className='flex items-center rounded-lg border border-slate-200 p-0.5 dark:border-border'>
      {dateFields
        .filter((f) => f.field !== exclude)
        .slice(0, 4)
        .map((f) => (
          <button
            key={f.field}
            type='button'
            onClick={() => onChange(f.field)}
            className={cn(
              'h-6 rounded-md px-2 text-[11px] font-medium',
              value === f.field
                ? 'bg-nvr-cyan/15 text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                : 'text-slate-400 hover:text-slate-700'
            )}
          >
            {f.label}
          </button>
        ))}
    </div>
  )

  return (
    <div className='flex-1 overflow-auto p-4'>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <div className='flex items-center gap-1.5'>
          <span className='text-[11px] text-slate-400'>Start</span>
          <FieldToggle value={startField} onChange={setStartField} exclude={endField} />
        </div>
        <div className='flex items-center gap-1.5'>
          <span className='text-[11px] text-slate-400'>End</span>
          <FieldToggle value={endField} onChange={setEndField} exclude={startField} />
        </div>
        <span className='ml-auto text-[11px] text-slate-400'>
          {rows.length} record{rows.length !== 1 ? 's' : ''} in window
        </span>
      </div>

      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        {/* Month scale */}
        <div className='relative flex h-7 border-b border-slate-100 dark:border-border'>
          <div className='w-56 shrink-0 border-r border-slate-100 px-3 py-1.5 text-[10px] font-semibold text-slate-500 dark:border-border'>
            Record
          </div>
          <div className='relative flex-1'>
            {ticks.map((t) => (
              <span
                key={t.label + t.pct}
                className='absolute top-1.5 text-[9px] text-slate-400'
                style={{ left: `${t.pct}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>

        {isLoading ? (
          <p className='p-6 text-center text-[12px] text-slate-400'>Loading…</p>
        ) : rows.length === 0 ? (
          <p className='p-6 text-center text-[12px] text-slate-400'>
            No records with {startField} in the visible window.
          </p>
        ) : (
          <div className='relative'>
            {/* today line */}
            {todayPct > 0 && todayPct < 100 && (
              <span
                className='pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-nvr-cyan'
                style={{ left: `calc(14rem + (100% - 14rem) * ${todayPct / 100})` }}
              />
            )}
            {rows.map(({ it, s, e }) => (
              <div
                key={String(it.id)}
                className='flex border-b border-slate-50 last:border-0 dark:border-border/50'
              >
                <button
                  type='button'
                  onClick={() => navigate(`/collections/${collection}/${String(it.id)}`)}
                  className='w-56 shrink-0 truncate border-r border-slate-100 px-3 py-1.5 text-left text-[11.5px] font-medium text-slate-700 hover:text-nvr-navy dark:border-border dark:text-slate-300'
                  title={label(it)}
                >
                  {label(it)}
                </button>
                <div className='relative flex-1 py-1.5'>
                  <div
                    className='absolute top-1/2 h-3 -translate-y-1/2 rounded-full bg-[#00ceff66] ring-1 ring-[#00ceff]'
                    style={{
                      left: `${pct(s)}%`,
                      width: `${Math.max(0.6, pct(e) - pct(s))}%`
                    }}
                    title={`${new Date(s).toLocaleDateString()} → ${new Date(e).toLocaleDateString()}`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
