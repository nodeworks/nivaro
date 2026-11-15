import {
  clashSentence,
  clashWriter,
  DragClashNotice,
  dragAddDays,
  dragBaseRevision,
  dragDayKey,
  dragDayLabel,
  dragDayOf,
  saveDrop,
  toastError,
  useActorNames,
  useLiveDrag,
  useLiveQueryRefresh,
  useNivaroClient,
  valueOnDay
} from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { renderDisplayTemplate } from '@/lib/relations'
import { cn } from '@/lib/utils'

/**
 * Gantt view over a start/end date-field pair. Window spans the fetched
 * records' range clipped to ±120 days around today; bars are pure CSS
 * percentages — no chart library.
 *
 * Bars drag along the timeline (round 9 #17): both dates move by the same number of days,
 * others looking at the same chart see a ghost bar with the dragger's name (lib/live-drag.ts),
 * and a drop that meets someone else's newer move asks before anything is overwritten.
 */

interface DateFieldOption {
  field: string
  label: string
  type?: string | null
}

const DAY = 86_400_000
const WINDOW_BACK = 30 * DAY
const WINDOW_FWD = 120 * DAY
const FIXED_DATE_FIELDS = new Set(['date_created', 'date_updated', 'created_at', 'updated_at'])

interface Clash {
  id: string
  label: string
  start: string
  end: string
  current: Record<string, unknown> | null
  latest: number
}

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
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [startField, setStartField] = useState(
    dateFields.find((f) => /start|begin|from/i.test(f.field))?.field ?? dateFields[0]?.field ?? ''
  )
  const [endField, setEndField] = useState(
    dateFields.find((f) => /end|due|finish|to|complete/i.test(f.field))?.field ??
      dateFields[1]?.field ??
      ''
  )
  const typeOf = (f: string) => dateFields.find((d) => d.field === f)?.type ?? null
  const canDrag =
    !!startField &&
    !!endField &&
    startField !== endField &&
    !FIXED_DATE_FIELDS.has(startField) &&
    !FIXED_DATE_FIELDS.has(endField)

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
  // Records others add, move or reschedule appear in place (#2124).
  useLiveQueryRefresh(collection, [['gantt', collection]])

  // Drops on their way: drawn at the new dates until the re-read shows them.
  const [pending, setPending] = useState<
    Map<string, { start: string; end: string; values: Record<string, string>; at: number }>
  >(() => new Map())
  useEffect(() => {
    if (pending.size === 0) return
    const byId = new Map(items.map((r) => [String(r.id), r]))
    const now = Date.now()
    let changed = false
    const next = new Map(pending)
    for (const [id, p] of pending) {
      const row = byId.get(id)
      if ((row && dragDayOf(row[startField]) === p.start) || now - p.at > 8000) {
        next.delete(id)
        changed = true
      }
    }
    if (changed) setPending(next)
  }, [items, pending, startField])

  const { rows, windowStart, windowEnd } = useMemo(() => {
    const now = Date.now()
    let min = now - WINDOW_BACK
    let max = now + WINDOW_FWD
    const parsed = items
      .map((raw) => {
        const p = pending.get(String(raw.id))
        const it = p ? { ...raw, ...p.values } : raw
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
  }, [items, startField, endField, pending])

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

  // ── Drag along the timeline (round 9 #17) ──────────────────────────────
  const view = `gantt:${startField},${endField}`
  const ids = useMemo(() => rows.map((r) => String(r.it.id)), [rows])
  const liveDrag = useLiveDrag({ collection, view, items: ids, enabled: canDrag })
  const [drag, setDrag] = useState<{ id: string; days: number } | null>(null)
  const dragRef = useRef<{
    id: string
    row: Record<string, unknown>
    startDay: string
    endDay: string
    x: number
    width: number
    days: number
    active: boolean
    base: Promise<number | null> | null
  } | null>(null)
  const suppressClickRef = useRef(false)
  const [clash, setClash] = useState<Clash | null>(null)
  const [clashBusy, setClashBusy] = useState(false)
  const clashWho = clashWriter(clash?.current ?? null)
  const clashNames = useActorNames(clashWho ? [clashWho] : [])

  const drop = async (
    id: string,
    row: Record<string, unknown>,
    start: string,
    end: string,
    basePromise: Promise<number | null> | null,
    baseOverride?: number
  ) => {
    const values: Record<string, string> = {
      [startField]: valueOnDay(row[startField], start, typeOf(startField))
    }
    if (row[endField] != null && row[endField] !== '')
      values[endField] = valueOnDay(row[endField], end, typeOf(endField))
    setPending((m) => new Map(m).set(id, { start, end, values, at: Date.now() }))
    liveDrag.finish(id, { start, end })
    const forget = () =>
      setPending((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
    try {
      const base = baseOverride ?? (basePromise ? await basePromise : null)
      const r = await saveDrop(client, collection, id, values, base)
      void qc.invalidateQueries({ queryKey: ['gantt', collection] })
      if (r.ok) {
        setClash(null)
        return
      }
      forget()
      setClash({ id, label: label(row), start, end, current: r.current, latest: r.latest })
    } catch (err) {
      forget()
      toastError(err, 'Could not move it')
    }
  }

  const endDrag = (cancel: boolean) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d?.active) return
    suppressClickRef.current = true
    setDrag(null)
    if (cancel || d.days === 0) {
      liveDrag.finish(d.id)
      return
    }
    void drop(d.id, d.row, dragAddDays(d.startDay, d.days), dragAddDays(d.endDay, d.days), d.base)
  }
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endDrag(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onBarPointerDown = (
    e: React.PointerEvent<HTMLElement>,
    row: { it: Record<string, unknown>; s: number; e: number }
  ) => {
    if (!canDrag || e.button !== 0 || clash) return
    const lane = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect()
    if (!lane || lane.width <= 0) return
    dragRef.current = {
      id: String(row.it.id),
      row: row.it,
      startDay: dragDayKey(new Date(row.s)),
      endDay: dragDayKey(new Date(row.e)),
      x: e.clientX,
      width: lane.width,
      days: 0,
      active: false,
      base: null
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onBarPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    if (!d.active) {
      if (Math.abs(dx) < 5) return
      d.active = true
      d.base = dragBaseRevision(client, collection, d.id)
    }
    const days = Math.round(((dx / d.width) * span) / DAY)
    if (days === d.days && drag) return
    d.days = days
    setDrag({ id: d.id, days })
    liveDrag.move(d.id, { start: dragAddDays(d.startDay, days), end: dragAddDays(d.endDay, days) })
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

  const theirStart = clash ? dragDayOf(clash.current?.[startField]) : null
  const theirEnd = clash ? dragDayOf(clash.current?.[endField]) : null
  const theirName = clashWho ? (clashNames.get(clashWho) ?? null) : null

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
          {canDrag && rows.length > 0 ? ' · drag a bar to move its dates' : ''}
        </span>
      </div>

      {clash && (
        <div className='mb-3'>
          <DragClashNotice
            sentence={clashSentence(theirName, theirStart, theirEnd, clash.label)}
            mine={`You dropped it on ${dragDayLabel(clash.start)} – ${dragDayLabel(clash.end)}`}
            theirsLabel={theirName ? `Keep ${theirName.split(' ')[0]}'s` : 'Keep theirs'}
            busy={clashBusy}
            onKeepTheirs={() => setClash(null)}
            onUseMine={() => {
              const row = rows.find((r) => String(r.it.id) === clash.id)?.it ??
                clash.current ?? { id: clash.id }
              setClashBusy(true)
              void drop(clash.id, row, clash.start, clash.end, null, clash.latest).finally(() =>
                setClashBusy(false)
              )
            }}
          />
        </div>
      )}

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
          <div className={cn('relative', drag && 'cursor-grabbing select-none')}>
            {/* today line */}
            {todayPct > 0 && todayPct < 100 && (
              <span
                className='pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-nvr-cyan'
                style={{ left: `calc(14rem + (100% - 14rem) * ${todayPct / 100})` }}
              />
            )}
            {rows.map((r) => {
              const { it } = r
              const id = String(it.id)
              const shift = drag?.id === id ? drag.days * DAY : 0
              const s = r.s + shift
              const e = r.e + shift
              const ghost = liveDrag.ghosts.get(id)
              const ghostWho = ghost ? (liveDrag.names.get(ghost.userId) ?? 'Someone') : null
              const gs = ghost?.start ? new Date(`${ghost.start}T00:00:00`).getTime() : null
              const ge = ghost?.end ? new Date(`${ghost.end}T00:00:00`).getTime() + DAY : null
              return (
                <div
                  key={id}
                  data-gantt-row={id}
                  className='flex border-b border-slate-50 last:border-0 dark:border-border/50'
                >
                  <button
                    type='button'
                    onClick={() => navigate(`/collections/${collection}/${id}`)}
                    className='w-56 shrink-0 truncate border-r border-slate-100 px-3 py-1.5 text-left text-[11.5px] font-medium text-slate-700 hover:text-nvr-navy dark:border-border dark:text-slate-300'
                    title={label(it)}
                  >
                    {label(it)}
                  </button>
                  <div className='relative flex-1 py-1.5'>
                    {ghost && gs != null && ge != null && (
                      <div
                        data-gantt-ghost={id}
                        className='nvr-fade-in pointer-events-none absolute top-1/2 flex h-4 -translate-y-1/2 items-center rounded-full border border-dashed border-violet-400 bg-violet-50/60 dark:border-violet-400/70 dark:bg-violet-500/10'
                        style={{
                          left: `${pct(gs)}%`,
                          width: `${Math.max(0.6, pct(ge) - pct(gs))}%`
                        }}
                      >
                        <span className='absolute left-full ml-1.5 whitespace-nowrap text-[10px] font-semibold text-violet-700 dark:text-violet-300'>
                          {ghostWho?.split(' ')[0]} · {dragDayLabel(ghost.start as string)}
                        </span>
                      </div>
                    )}
                    <button
                      type='button'
                      data-gantt-bar={id}
                      aria-label={`${label(it)}: ${new Date(s).toLocaleDateString()} to ${new Date(e).toLocaleDateString()}`}
                      onPointerDown={(ev) => onBarPointerDown(ev, r)}
                      onPointerMove={onBarPointerMove}
                      onPointerUp={() => endDrag(false)}
                      onPointerCancel={() => endDrag(true)}
                      onClick={(ev) => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false
                          ev.preventDefault()
                          return
                        }
                        navigate(`/collections/${collection}/${id}`)
                      }}
                      className={cn(
                        'absolute top-1/2 h-3 -translate-y-1/2 rounded-full bg-[#00ceff66] ring-1 ring-[#00ceff] focus-visible:outline-none focus-visible:ring-2',
                        canDrag && 'cursor-grab touch-none active:cursor-grabbing',
                        drag?.id === id && 'shadow-[0_2px_8px_-1px_rgba(0,140,180,0.45)]',
                        ghost && 'opacity-60'
                      )}
                      style={{
                        left: `${pct(s)}%`,
                        width: `${Math.max(0.6, pct(e) - pct(s))}%`
                      }}
                      title={
                        ghostWho
                          ? `${ghostWho} is moving this`
                          : `${new Date(s).toLocaleDateString()} → ${new Date(e).toLocaleDateString()}`
                      }
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
