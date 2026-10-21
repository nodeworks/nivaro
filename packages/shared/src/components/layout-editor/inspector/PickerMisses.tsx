import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { del, get } from '../../../lib/commands'
import { Skeleton } from '../../ui/skeleton'
import { Section } from './kit'

interface Miss {
  term: string
  count: number
  last: string
  suggestion: { kind: 'found_now' | 'filter' | 'hidden' | 'option'; text: string } | null
}

interface MissData {
  available: boolean
  target?: string | null
  fields: Array<{ field: string; total: number; misses: Miss[] }>
}

const daysAgo = (day: string): string => {
  const d = Math.round(
    (Date.parse(`${utcToday()}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000
  )
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}
const utcToday = () => new Date().toISOString().slice(0, 10)

/**
 * #2726 — picker search gaps on this placement: what people typed into this
 * field's picker on this form that found nothing (last 14 days, counts only,
 * no names), with a suggested option or filter fix for the top ones.
 */
export function PickerMisses({ layoutId, field }: { layoutId: number; field: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const key = ['layout-editor', 'picker-misses', layoutId, field]
  const { data, isLoading, isError, refetch } = useQuery<MissData>({
    queryKey: key,
    queryFn: () =>
      client
        .request<{ data: MissData }>(get(`/layout-usage/${layoutId}/picker-misses`, { field }))
        // Anything else (an older server, a stub) reads as "nothing recorded".
        .then((r) => ({
          available: r?.data?.available !== false,
          target: r?.data?.target ?? null,
          fields: Array.isArray(r?.data?.fields) ? r.data.fields : []
        })),
    enabled: layoutId > 0,
    staleTime: 60_000,
    retry: false
  })
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const mine = data?.fields.find((f) => f.field === field)
  const misses = Array.isArray(mine?.misses) ? mine.misses : []
  const total = mine?.total ?? 0

  const clear = async () => {
    setClearing(true)
    try {
      await client.request(
        del(`/layout-usage/${layoutId}/picker-misses?field=${encodeURIComponent(field)}`)
      )
      await qc.invalidateQueries({ queryKey: key })
    } finally {
      setClearing(false)
      setConfirming(false)
    }
  }

  return (
    <Section title='Searches that found nothing'>
      <div className='space-y-3' data-picker-misses={field}>
        <p className='text-[12px] leading-5 text-muted-foreground'>
          What people typed into this picker on this form in the last 14 days that matched no
          record. Counts only, never who typed it.
        </p>
        {isLoading ? (
          <div className='space-y-2' aria-busy='true'>
            <Skeleton className='h-4 w-3/4' />
            <Skeleton className='h-3 w-full' />
            <Skeleton className='h-4 w-1/2' />
          </div>
        ) : isError ? (
          <p className='text-[12px] text-muted-foreground'>
            Could not load the searches.{' '}
            <button
              type='button'
              onClick={() => void refetch()}
              className='font-medium text-foreground underline-offset-2 hover:underline'
            >
              Try again
            </button>
          </p>
        ) : data && !data.available ? (
          <p className='text-[12px] text-muted-foreground'>
            Searches are not being recorded on this server right now.
          </p>
        ) : misses.length === 0 ? (
          <p className='rounded-md border border-dashed border-border px-3 py-2.5 text-[12px] leading-5 text-muted-foreground'>
            No missed searches yet. When someone searches this picker and finds nothing, the words
            show here with a suggested fix.
          </p>
        ) : (
          <>
            <ol className='divide-y divide-border overflow-hidden rounded-md border border-border'>
              {misses.map((m) => (
                <li key={m.term} className='space-y-1 bg-card px-3 py-2' data-picker-miss={m.term}>
                  <div className='flex items-baseline gap-2'>
                    <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground'>
                      “{m.term}”
                    </span>
                    <span
                      className='shrink-0 text-[11.5px] tabular-nums text-muted-foreground'
                      data-tip={`Last searched ${daysAgo(m.last)}`}
                    >
                      {m.count} {m.count === 1 ? 'time' : 'times'}
                    </span>
                  </div>
                  {m.suggestion && (
                    <p
                      className='text-[11.5px] leading-4 text-muted-foreground'
                      data-picker-miss-fix={m.suggestion.kind}
                    >
                      {m.suggestion.text}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            <div className='flex items-center gap-2 text-[11.5px] text-muted-foreground'>
              <span className='flex-1'>
                {total} missed {total === 1 ? 'search' : 'searches'} in 14 days
              </span>
              {confirming ? (
                <>
                  <span>Clear the list?</span>
                  <button
                    type='button'
                    disabled={clearing}
                    onClick={() => void clear()}
                    className='rounded px-1.5 py-0.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/10'
                  >
                    Clear
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirming(false)}
                    className='rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground'
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  onClick={() => setConfirming(true)}
                  className='rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground'
                >
                  Clear list
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  )
}
