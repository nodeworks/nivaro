import {
  clashSentence,
  clashWriter,
  DragClashNotice,
  dragBaseRevision,
  dragDayKey,
  dragDayLabel,
  dragDayOf,
  saveDrop,
  toastError,
  useActorNames,
  useLiveCalendar,
  useLiveDrag,
  useNivaroClient,
  valueOnDay
} from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { renderDisplayTemplate } from '@/lib/relations'
import { cn } from '@/lib/utils'

/**
 * Month-grid calendar over any date/datetime field of a collection.
 * Client-side view over the plain items API — one range-filtered fetch per
 * visible month, capped at 500 records.
 *
 * Entries drag to another day (round 9 #17): others looking at the same calendar see a ghost
 * of the entry moving with the dragger's name (lib/live-drag.ts), and a drop that meets
 * someone else's newer move asks "Beth just moved this to Dec 4 — Keep Beth's / Use yours"
 * instead of silently winning or losing.
 */

interface DateFieldOption {
  field: string
  label: string
  type?: string | null
}

/** System stamps never move by hand. */
const FIXED_DATE_FIELDS = new Set(['date_created', 'date_updated', 'created_at', 'updated_at'])

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

interface Clash {
  id: string
  label: string
  mineDay: string
  mineValue: string
  current: Record<string, unknown> | null
  latest: number
}

export function CollectionCalendar({
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
  const [field, setField] = useState(dateFields[0]?.field ?? '')
  const fieldType = dateFields.find((f) => f.field === field)?.type ?? null
  const canDrag = !!field && !FIXED_DATE_FIELDS.has(field)
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })

  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
  const from = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-01`
  const to = `${monthEnd.getFullYear()}-${pad(monthEnd.getMonth() + 1)}-${pad(monthEnd.getDate())} 23:59:59`

  const {
    data: fetched,
    isLoading,
    dataUpdatedAt
  } = useQuery({
    queryKey: ['calendar', collection, field, monthKey(cursor)],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${collection}`, {
          params: {
            filter: JSON.stringify({ [field]: { _gte: from, _lte: to } }),
            limit: 500,
            sort: field
          }
        })
        .then((r) => r.data.data ?? []),
    enabled: !!field
  })
  // Records others add, move or reschedule appear in place (#2124): one quiet re-read per
  // burst, the changed entries fade in, and an entry that left (moved to another day) stays
  // where it was, dimmed, until the person moves on — nothing shifts under the pointer.
  const live = useLiveCalendar({
    collection,
    keys: [['calendar', collection]],
    items: fetched,
    keyOf: (r) => String(r.id),
    updatedAt: dataUpdatedAt,
    resetKey: `${collection}|${field}|${monthKey(cursor)}`,
    enabled: !!field
  })

  // ── Drag to another day (round 9 #17) ──────────────────────────────────
  const view = `calendar:${field}`
  const ids = useMemo(() => live.entries.map((e) => String(e.row.id)), [live.entries])
  const liveDrag = useLiveDrag({ collection, view, items: ids, enabled: canDrag })
  const [drag, setDrag] = useState<{ id: string; fromDay: string; overDay: string } | null>(null)
  const dragRef = useRef<{
    id: string
    row: Record<string, unknown>
    fromDay: string
    overDay: string
    x: number
    y: number
    active: boolean
    base: Promise<number | null> | null
  } | null>(null)
  const suppressClickRef = useRef(false)
  // Drops on their way: drawn on the new day until the re-read shows it there.
  const [pending, setPending] = useState<Map<string, { value: string; day: string; at: number }>>(
    () => new Map()
  )
  const [clash, setClash] = useState<Clash | null>(null)
  const [clashBusy, setClashBusy] = useState(false)
  const clashWho = clashWriter(clash?.current ?? null)
  const clashNames = useActorNames(clashWho ? [clashWho] : [])

  // A pending drop is settled once the calendar's own read shows the record on that day.
  useEffect(() => {
    if (pending.size === 0) return
    const byId = new Map((fetched ?? []).map((r) => [String(r.id), r]))
    const now = Date.now()
    let changed = false
    const next = new Map(pending)
    for (const [id, p] of pending) {
      const row = byId.get(id)
      if ((row && dragDayOf(row[field]) === p.day) || now - p.at > 8000) {
        next.delete(id)
        changed = true
      }
    }
    if (changed) setPending(next)
  }, [fetched, field, pending])

  const items = useMemo(
    () =>
      live.entries.map((e) => {
        const p = pending.get(String(e.row.id))
        return {
          row: p ? { ...e.row, [field]: p.value } : e.row,
          departed: !p && e.state === 'departed'
        }
      }),
    [live.entries, pending, field]
  )

  const byDay = useMemo(() => {
    const map = new Map<string, Array<{ row: Record<string, unknown>; departed: boolean }>>()
    for (const entry of items) {
      const day = dragDayOf(entry.row[field])
      if (!day || day.slice(0, 7) !== monthKey(cursor)) continue
      const list = map.get(day) ?? []
      list.push(entry)
      map.set(day, list)
    }
    return map
  }, [items, field, cursor])
  const rowById = useMemo(() => new Map(items.map((e) => [String(e.row.id), e.row])), [items])

  const label = (it: Record<string, unknown>) => {
    const t = displayTemplate ? renderDisplayTemplate(displayTemplate, it) : null
    return (
      (t && t.trim()) ||
      String(it.title ?? it.name ?? it.label ?? it.subject ?? `#${String(it.id)}`)
    )
  }

  const endDrag = (cancel: boolean) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d?.active) return
    suppressClickRef.current = true
    setDrag(null)
    if (cancel || d.overDay === d.fromDay) {
      liveDrag.finish(d.id)
      return
    }
    void drop(d.id, d.row, d.overDay, d.base)
  }

  const drop = async (
    id: string,
    row: Record<string, unknown>,
    day: string,
    basePromise: Promise<number | null> | null,
    baseOverride?: number
  ) => {
    const value = valueOnDay(row[field], day, fieldType)
    setPending((m) => new Map(m).set(id, { value, day, at: Date.now() }))
    liveDrag.finish(id, { at: day })
    try {
      const base = baseOverride ?? (basePromise ? await basePromise : null)
      const r = await saveDrop(client, collection, id, { [field]: value }, base)
      if (r.ok) {
        setClash(null)
        void qc.invalidateQueries({ queryKey: ['calendar', collection] })
        return
      }
      setPending((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      setClash({
        id,
        label: label(row),
        mineDay: day,
        mineValue: value,
        current: r.current,
        latest: r.latest
      })
      void qc.invalidateQueries({ queryKey: ['calendar', collection] })
    } catch (err) {
      setPending((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      toastError(err, 'Could not move it to that day')
    }
  }

  // Escape cancels a drag in progress.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endDrag(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onEntryPointerDown = (e: React.PointerEvent, row: Record<string, unknown>) => {
    if (!canDrag || e.button !== 0 || clash) return
    const fromDay = dragDayOf(row[field])
    if (!fromDay) return
    dragRef.current = {
      id: String(row.id),
      row,
      fromDay,
      overDay: fromDay,
      x: e.clientX,
      y: e.clientY,
      active: false,
      base: null
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onEntryPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return
      d.active = true
      d.base = dragBaseRevision(client, collection, d.id)
      setDrag({ id: d.id, fromDay: d.fromDay, overDay: d.fromDay })
    }
    const cell = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest('[data-cal-day]')
      ?.getAttribute('data-cal-day')
    if (!cell || cell === d.overDay) return
    d.overDay = cell
    setDrag({ id: d.id, fromDay: d.fromDay, overDay: cell })
    liveDrag.move(d.id, { at: cell })
  }

  // Grid: leading blanks + days
  const firstDow = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay()
  const daysInMonth = monthEnd.getDate()
  const cells: Array<number | null> = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1)
  ]
  const today = new Date()
  const isThisMonth =
    today.getFullYear() === cursor.getFullYear() && today.getMonth() === cursor.getMonth()

  if (dateFields.length === 0) {
    return (
      <p className='p-8 text-center text-[13px] text-slate-400'>
        No date fields on this collection — the calendar view needs one.
      </p>
    )
  }

  const theirDay = clash ? dragDayOf(clash.current?.[field]) : null
  const theirName = clashWho ? (clashNames.get(clashWho) ?? null) : null

  return (
    <div className='flex-1 overflow-auto p-4' ref={live.ref}>
      <div className='mb-3 flex items-center gap-2'>
        <Button
          variant='outline'
          size='sm'
          aria-label='Previous month'
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
        >
          <ChevronLeft className='h-3.5 w-3.5' />
        </Button>
        <p className='w-40 text-center text-[14px] font-semibold text-slate-800 dark:text-slate-200'>
          {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </p>
        <Button
          variant='outline'
          size='sm'
          aria-label='Next month'
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
        >
          <ChevronRight className='h-3.5 w-3.5' />
        </Button>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}
        >
          Today
        </Button>
        <div className='ml-auto flex items-center gap-1.5'>
          <span className='text-[11px] text-slate-400'>Date field</span>
          <div className='flex items-center rounded-lg border border-slate-200 p-0.5 dark:border-border'>
            {dateFields.slice(0, 4).map((f) => (
              <button
                key={f.field}
                type='button'
                onClick={() => setField(f.field)}
                className={cn(
                  'h-6 rounded-md px-2 text-[11px] font-medium',
                  field === f.field
                    ? 'bg-nvr-cyan/15 text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                    : 'text-slate-400 hover:text-slate-700'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {clash && (
        <div className='mb-3'>
          <DragClashNotice
            sentence={clashSentence(theirName, theirDay, null, clash.label)}
            mine={`You dropped it on ${dragDayLabel(clash.mineDay)}`}
            theirsLabel={theirName ? `Keep ${theirName.split(' ')[0]}'s` : 'Keep theirs'}
            busy={clashBusy}
            onKeepTheirs={() => setClash(null)}
            onUseMine={() => {
              const row = rowById.get(clash.id) ?? clash.current ?? { id: clash.id }
              setClashBusy(true)
              void drop(clash.id, row, clash.mineDay, null, clash.latest).finally(() =>
                setClashBusy(false)
              )
            }}
          />
        </div>
      )}

      <div
        className={cn(
          'grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border',
          drag && 'cursor-grabbing select-none'
        )}
      >
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div
            key={d}
            className='bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-500 dark:bg-muted'
          >
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          const key = day ? dragDayKey(new Date(cursor.getFullYear(), cursor.getMonth(), day)) : ''
          const list = day ? (byDay.get(key) ?? []) : []
          const isOver =
            !!drag && day != null && drag.overDay === key && drag.overDay !== drag.fromDay
          const ghostsHere = day
            ? [...liveDrag.ghosts.values()].filter(
                (g) =>
                  g.at === key &&
                  rowById.has(g.item) &&
                  dragDayOf(rowById.get(g.item)?.[field]) !== key
              )
            : []
          const dragged = drag ? rowById.get(drag.id) : undefined
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid
              key={i}
              data-cal-day={key || undefined}
              className={cn(
                'min-h-24 bg-white p-1.5 transition-colors dark:bg-card',
                day && isThisMonth && day === today.getDate() && 'bg-[#00ceff08]',
                isOver && 'bg-[#eafaff] dark:bg-[#0d2a33]'
              )}
            >
              {day && (
                <>
                  <p
                    className={cn(
                      'mb-1 text-[10px] font-semibold',
                      isThisMonth && day === today.getDate() ? 'text-nvr-cyan' : 'text-slate-400'
                    )}
                  >
                    {day}
                  </p>
                  <div className='space-y-0.5'>
                    {isOver && dragged && (
                      <div
                        data-cal-drop-preview
                        className='truncate rounded border border-dashed border-nvr-cyan bg-white px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy dark:bg-card dark:text-[#7fe6ff]'
                      >
                        {label(dragged)}
                      </div>
                    )}
                    {ghostsHere.map((g) => {
                      const row = rowById.get(g.item)
                      if (!row) return null
                      const who = liveDrag.names.get(g.userId) ?? 'Someone'
                      return (
                        <div
                          key={`ghost-${g.item}`}
                          data-cal-ghost={g.item}
                          data-tip={`${who} is moving this here`}
                          className='nvr-fade-in flex items-center gap-1 truncate rounded border border-dashed border-violet-400 bg-violet-50/70 px-1.5 py-0.5 text-[10px] font-medium text-violet-900 dark:border-violet-400/60 dark:bg-violet-500/10 dark:text-violet-100'
                        >
                          <span className='truncate'>{label(row)}</span>
                          <span className='shrink-0 font-semibold text-violet-700 dark:text-violet-300'>
                            · {who.split(' ')[0]}
                          </span>
                        </div>
                      )
                    })}
                    {list.slice(0, 4).map(({ row: it, departed }) => {
                      const id = String(it.id)
                      const ghost = liveDrag.ghosts.get(id)
                      const ghostWho = ghost
                        ? (liveDrag.names.get(ghost.userId) ?? 'Someone')
                        : null
                      const beingDragged = drag?.id === id
                      return (
                        <button
                          key={id}
                          data-departed={departed || undefined}
                          data-cal-entry={id}
                          data-being-moved={ghost ? '' : undefined}
                          type='button'
                          onPointerDown={(e) => onEntryPointerDown(e, it)}
                          onPointerMove={onEntryPointerMove}
                          onPointerUp={() => endDrag(false)}
                          onPointerCancel={() => endDrag(true)}
                          onClick={(e) => {
                            if (suppressClickRef.current) {
                              suppressClickRef.current = false
                              e.preventDefault()
                              return
                            }
                            navigate(`/collections/${collection}/${id}`)
                          }}
                          className={cn(
                            'block w-full truncate rounded bg-[#00ceff1a] px-1.5 py-0.5 text-left text-[10px] font-medium text-nvr-navy hover:bg-[#00ceff33] dark:text-[#00ceff]',
                            canDrag && 'cursor-grab touch-none active:cursor-grabbing',
                            (departed || beingDragged) && 'opacity-50',
                            ghost &&
                              'outline-dashed outline-1 outline-violet-400 dark:outline-violet-400/70'
                          )}
                          title={ghostWho ? `${ghostWho} is moving this` : label(it)}
                        >
                          {label(it)}
                        </button>
                      )
                    })}
                    {list.length > 4 && (
                      <p className='px-1 text-[9px] text-slate-400'>+{list.length - 4} more</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
      {isLoading && <p className='mt-2 text-[11px] text-slate-400'>Loading…</p>}
      {canDrag && !isLoading && (
        <p className='mt-2 text-[11px] text-slate-400'>
          Drag an entry to another day to change its{' '}
          {dateFields.find((f) => f.field === field)?.label ?? field}.
        </p>
      )}
    </div>
  )
}
