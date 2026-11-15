import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { batchTouches, LIVE_ASPECTS, liveMotionAllowed, useLiveCollection } from '../../lib/live'
import { formatRelative } from '../../lib/utils'

/**
 * Threshold banners (realtime round 9, item 20): "Project US201979 just crossed 90%".
 *
 * Shows crossings of the alert definitions an administrator switched to "Show as a banner"
 * (Alerts → definition). Record mode (`itemId`) sits in a record page's banner stack; without
 * `itemId` it lists the collection's newest crossings (a budget console, a project hub). Each
 * banner is dismissed for the viewer alone; a later crossing shows again. Read as the viewer
 * (GET /alerts/banners), live: a new crossing (`$alerts`) or a write to a field a banner
 * watches re-reads it once per burst — no toast, no sound, nothing moves under the pointer.
 * Renders nothing when there is nothing to say.
 */

export interface AlertBannerData {
  log_id: number
  definition_id: number
  name: string
  collection: string
  item: string
  record: string
  field: string
  operator: string
  threshold: number
  unit: string
  value: number | null
  triggered_at: string
  phrase: string
}

export const alertBannersKey = (collection: string, itemId?: string | null) =>
  ['alert-banners', collection, itemId ?? '*'] as const

function withUnit(n: number, unit: string): string {
  const u = (unit ?? '').trim()
  const s = Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (!u || u === 'count') return s
  if (u === '%') return `${s}%`
  if (u === '$' || u === 'USD') return `$${s}`
  return `${s} ${u}`
}

export function AlertBanners({
  collection,
  itemId,
  max = 3,
  onOpenRecord,
  className
}: {
  collection: string
  /** One record's banners; omit for the collection's newest crossings. */
  itemId?: string | null
  /** Collection mode: how many show before "N more". */
  max?: number
  /** Collection mode: open the record a banner names. */
  onOpenRecord?: (collection: string, item: string) => void
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const key = alertBannersKey(collection, itemId)
  const [expanded, setExpanded] = useState(false)
  const { data } = useQuery<AlertBannerData[]>({
    queryKey: key,
    queryFn: () =>
      client
        .request<AlertBannerData[]>(
          get(
            `/alerts/banners?collection=${encodeURIComponent(collection)}${
              itemId ? `&item=${encodeURIComponent(itemId)}` : ''
            }`
          )
        )
        .then((r) => (Array.isArray(r) ? r : []))
        .catch(() => []),
    staleTime: 30_000,
    enabled: !!collection && itemId !== 'new'
  })

  // Fields the shown banners watch: a write to one may end a banner (value back under the line).
  const watched = useMemo(() => [...new Set((data ?? []).map((b) => b.field))], [data])
  const watchedRef = useRef(watched)
  watchedRef.current = watched
  useLiveCollection(
    collection,
    (batch) => {
      const mine = itemId ? itemId.toLowerCase() : null
      if (mine && !batch.ids.some((id) => id.toLowerCase() === mine || id === '*')) return
      if (
        batch.changedFields === null ||
        batchTouches(batch, LIVE_ASPECTS.alerts, ...watchedRef.current)
      )
        void qc.invalidateQueries({ queryKey: key })
    },
    { debounceMs: 1_000, includeOwn: true, enabled: !!collection && itemId !== 'new' }
  )

  const seen = useRef<Set<number> | null>(null)
  const dismiss = useMutation({
    mutationFn: (logId: number) => client.request(post(`/alerts/banners/${logId}/dismiss`, {})),
    onMutate: (logId) => {
      qc.setQueryData<AlertBannerData[]>(key, (prev) =>
        (prev ?? []).filter((b) => b.log_id !== logId)
      )
    },
    onError: (err) => {
      toastError(err, 'Could not hide that banner')
      void qc.invalidateQueries({ queryKey: key })
    }
  })

  const list = data ?? []
  // Only banners that arrive while the page is open fade in; the first paint just shows.
  const fresh = new Set<number>()
  if (seen.current) for (const b of list) if (!seen.current.has(b.log_id)) fresh.add(b.log_id)
  seen.current = new Set(list.map((b) => b.log_id))
  if (list.length === 0) return null

  const shown = itemId || expanded ? list : list.slice(0, max)
  const hidden = list.length - shown.length
  const motion = liveMotionAllowed()

  return (
    <div data-alert-banners className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      {shown.map((b) => (
        <div
          key={b.log_id}
          data-alert-banner={b.log_id}
          role='status'
          className={`${fresh.has(b.log_id) && motion ? 'nvr-expand-in ' : ''}flex items-center gap-2.5 rounded-md border border-amber-200 bg-amber-50 py-1.5 pl-3 pr-1.5 dark:border-amber-400/25 dark:bg-amber-400/[0.08]`}
        >
          <Gauge
            aria-hidden
            className='h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300'
            strokeWidth={2}
          />
          <p className='min-w-0 flex-1 text-[12.5px] leading-snug text-amber-950 dark:text-amber-100'>
            {!itemId && onOpenRecord ? (
              <button
                type='button'
                onClick={() => onOpenRecord(b.collection, b.item)}
                className='font-semibold underline decoration-amber-700/30 underline-offset-2 hover:decoration-amber-700 dark:decoration-amber-200/30 dark:hover:decoration-amber-200'
              >
                {b.record}
              </button>
            ) : (
              <span className='font-semibold'>{b.record}</span>
            )}{' '}
            {b.phrase}
            <span className='text-amber-800/80 dark:text-amber-200/70'>
              {b.value != null && <> · now {withUnit(b.value, b.unit)}</>} · {b.name} ·{' '}
              <time dateTime={b.triggered_at} title={new Date(b.triggered_at).toLocaleString()}>
                {formatRelative(b.triggered_at)}
              </time>
            </span>
          </p>
          <button
            type='button'
            aria-label={`Hide this banner for me: ${b.record} ${b.phrase}`}
            data-tip='Hide for me'
            onClick={() => dismiss.mutate(b.log_id)}
            className='shrink-0 rounded p-1 text-amber-700/70 hover:bg-amber-100 hover:text-amber-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500 dark:text-amber-200/60 dark:hover:bg-amber-400/15 dark:hover:text-amber-100'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      ))}
      {hidden > 0 && (
        <button
          type='button'
          onClick={() => setExpanded(true)}
          className='self-start rounded px-1 text-[12px] font-medium text-amber-800 hover:underline dark:text-amber-200'
        >
          {hidden} more
        </button>
      )}
    </div>
  )
}
