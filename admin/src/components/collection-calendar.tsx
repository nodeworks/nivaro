import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { renderDisplayTemplate } from '@/lib/relations'
import { cn } from '@/lib/utils'

/**
 * Month-grid calendar over any date/datetime field of a collection.
 * Client-side view over the plain items API — one range-filtered fetch per
 * visible month, capped at 500 records.
 */

interface DateFieldOption {
  field: string
  label: string
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
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
  const [field, setField] = useState(dateFields[0]?.field ?? '')
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })

  const monthStart = cursor
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
  const from = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-01`
  const to = `${monthEnd.getFullYear()}-${pad(monthEnd.getMonth() + 1)}-${pad(monthEnd.getDate())} 23:59:59`

  const { data: items = [], isLoading } = useQuery({
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

  const byDay = useMemo(() => {
    const map = new Map<number, Array<Record<string, unknown>>>()
    for (const it of items) {
      const raw = it[field]
      if (!raw) continue
      const d = new Date(String(raw))
      if (Number.isNaN(d.getTime()) || d.getMonth() !== cursor.getMonth()) continue
      const day = d.getDate()
      const list = map.get(day) ?? []
      list.push(it)
      map.set(day, list)
    }
    return map
  }, [items, field, cursor])

  const label = (it: Record<string, unknown>) => {
    const t = displayTemplate ? renderDisplayTemplate(displayTemplate, it) : null
    return (
      (t && t.trim()) ||
      String(it.title ?? it.name ?? it.label ?? it.subject ?? `#${String(it.id)}`)
    )
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

  return (
    <div className='flex-1 overflow-auto p-4'>
      <div className='mb-3 flex items-center gap-2'>
        <Button
          variant='outline'
          size='sm'
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
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-400 hover:text-slate-700'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className='grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div
            key={d}
            className='bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-500 dark:bg-muted'
          >
            {d}
          </div>
        ))}
        {cells.map((day, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid
            key={i}
            className={cn(
              'min-h-24 bg-white p-1.5 dark:bg-card',
              day && isThisMonth && day === today.getDate() && 'bg-[#00ceff08]'
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
                  {(byDay.get(day) ?? []).slice(0, 4).map((it) => (
                    <button
                      key={String(it.id)}
                      type='button'
                      onClick={() => navigate(`/collections/${collection}/${String(it.id)}`)}
                      className='block w-full truncate rounded bg-[#00ceff1a] px-1.5 py-0.5 text-left text-[10px] font-medium text-nvr-navy hover:bg-[#00ceff33] dark:text-[#00ceff]'
                      title={label(it)}
                    >
                      {label(it)}
                    </button>
                  ))}
                  {(byDay.get(day)?.length ?? 0) > 4 && (
                    <p className='px-1 text-[9px] text-slate-400'>
                      +{(byDay.get(day)?.length ?? 0) - 4} more
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {isLoading && <p className='mt-2 text-[11px] text-slate-400'>Loading…</p>}
    </div>
  )
}
