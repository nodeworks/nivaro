import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLivePreference } from '../../lib/live-preference'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import type { FieldTouch } from './HeaderFreshness'

/** How long the pointer rests on a field before its source is asked for. */
const HOVER_DWELL_MS = 450

/**
 * "Set by ERP Sync", "Set by import (po-lines)", "Set by procedure reforecast", "Set by Beth",
 * "Changed outside the app" — where a field's value came from. Pure — exported for tests.
 */
export function sourceSentence(t: Pick<FieldTouch, 'who' | 'via' | 'caller'>): string {
  if (t.via === 'outside') return 'Changed outside the app'
  if (t.caller?.name) return `Set by ${t.caller.name}`
  const who = String(t.who ?? '').trim()
  if (t.via === 'system' && (!who || who.toLowerCase() === 'system')) return 'Set by the system'
  return `Set by ${who || 'someone'}`
}

/**
 * Realtime round 7 #7 — the value source badge on a record form field. Shown while the value
 * has just changed live (`live`: the remote-change mark is up), and on demand when the pointer
 * rests on the field. One GET /revisions/field-touch per field, as the viewer (the server
 * answers only fields the viewer may read); the live-sync invalidation refreshes it after a
 * change. Takes no room: it hangs off a zero-width anchor at the end of the label row.
 */
export function FieldSourceBadge({
  collection,
  itemId,
  field,
  live
}: {
  collection: string
  itemId: string
  field: string
  live?: boolean
}) {
  const client = useNivaroClient()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [hovered, setHovered] = useState(false)
  const { quiet } = useLivePreference()
  const showLive = !!live && !quiet

  useEffect(() => {
    const wrap = anchorRef.current?.closest<HTMLElement>('[data-field]')
    if (!wrap) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const enter = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setHovered(true), HOVER_DWELL_MS)
    }
    const leave = () => {
      if (timer) clearTimeout(timer)
      timer = null
      setHovered(false)
    }
    wrap.addEventListener('pointerenter', enter)
    wrap.addEventListener('pointerleave', leave)
    return () => {
      if (timer) clearTimeout(timer)
      wrap.removeEventListener('pointerenter', enter)
      wrap.removeEventListener('pointerleave', leave)
    }
  }, [])

  const wanted = (hovered || showLive) && !!itemId && itemId !== 'new'
  const { data } = useQuery<Record<string, FieldTouch>>({
    // The same key shape HeaderFreshness uses for one field: answers are shared.
    queryKey: ['field-touch', collection, itemId, field],
    queryFn: () =>
      client
        .request<{ data: Record<string, FieldTouch> }>(
          get('/revisions/field-touch', { collection, item: itemId, fields: field })
        )
        .then((r) => r.data ?? {}),
    enabled: wanted,
    staleTime: 60_000
  })
  const t = data?.[field]
  const shown = wanted && !!t
  const text = t ? sourceSentence(t) : ''
  return (
    <span
      ref={anchorRef}
      data-field-source-anchor=''
      className='pointer-events-none relative h-4 min-w-0 flex-1 basis-0'
      aria-hidden={!shown}
    >
      {shown && t && (
        <span
          data-field-source={field}
          data-field-source-via={t.via}
          className={cn(
            'nvr-fade-in absolute right-0 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-white py-px pl-2 pr-0.5 text-[10.5px] leading-4 dark:bg-card',
            showLive ? 'text-sky-700 dark:text-sky-300' : 'text-slate-500 dark:text-slate-400'
          )}
          title={`${text} · ${formatDateTime(t.at)}`}
        >
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              t.via === 'user'
                ? 'bg-slate-300 dark:bg-slate-500'
                : t.via === 'outside'
                  ? 'bg-rose-400'
                  : 'bg-amber-400'
            )}
          />
          {text}
          <span className='text-slate-400 dark:text-slate-500'>· {formatRelative(t.at)}</span>
        </span>
      )}
    </span>
  )
}
