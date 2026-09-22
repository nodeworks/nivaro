import { useQuery } from '@tanstack/react-query'
import { Sigma } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useAfterIdle } from '../../lib/defer'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { lineageSummary, useFieldLineage } from './FieldRow'

interface TrailEvent {
  at: string
  by: { id: string; name: string } | null
  action: string
  label: string
  field: string | null
  from: number | null
  to: number | null
  delta: number | null
  comment: string | null
  via_import: boolean
}
interface NumberTrail {
  since: string
  value_now: number | null
  net: number
  value_then_estimate: number | null
  events: TrailEvent[]
  truncated: boolean
  note: string | null
}

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 }
]

const ACTION_TEXT: Record<string, string> = {
  created: 'added',
  changed: 'changed',
  deleted: 'removed',
  moved_in: 'moved here',
  moved_out: 'moved away',
  parent: 'set'
}

/** "What changed my number?" (#510) — the events that moved a figure since a moment. */
function NumberTrailSection({
  collection,
  itemId,
  field,
  enabled
}: {
  collection: string
  itemId: string
  field: string
  enabled: boolean
}) {
  const client = useNivaroClient()
  const [hours, setHours] = useState(24)
  const { data, isLoading } = useQuery<NumberTrail>({
    queryKey: ['number-trail', collection, itemId, field, hours],
    queryFn: () =>
      client
        .request<{ data: NumberTrail }>(
          get(
            `/lineage/${collection}/${encodeURIComponent(itemId)}/${field}/changes?hours=${hours}`
          )
        )
        .then((r) => r.data),
    enabled,
    staleTime: 30_000
  })
  const num = (v: number | null | undefined) =>
    v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const signed = (v: number | null) =>
    v == null
      ? ''
      : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  const when = (iso: string) => {
    const d = new Date(iso)
    const ageH = (Date.now() - d.getTime()) / 3600_000
    return ageH < 24
      ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return (
    <div className='mt-2 border-t border-slate-100 pt-1.5 dark:border-border' data-number-trail>
      <div className='flex items-center gap-2 px-1'>
        <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
          What changed it
        </p>
        <div className='ml-auto flex gap-0.5'>
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type='button'
              onClick={() => setHours(w.hours)}
              data-trail-window={w.label}
              className={cn(
                'rounded px-1.5 py-px text-[10.5px]',
                hours === w.hours
                  ? 'bg-nvr-cyan text-white'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {isLoading && <p className='px-1 py-1 text-slate-400'>Reading the trail…</p>}
      {data && data.events.length === 0 && (
        <p className='px-1 py-1 text-slate-400'>
          Nothing moved this figure in the last {WINDOWS.find((w) => w.hours === hours)?.label}.
        </p>
      )}
      {data && data.events.length > 0 && (
        <>
          <p
            className='px-1 py-1 text-[11px] text-slate-600 dark:text-slate-300'
            data-trail-net={data.net}
          >
            <span className='font-medium tabular-nums'>{signed(data.net)}</span> across{' '}
            {data.events.length} change{data.events.length === 1 ? '' : 's'}
            {data.value_then_estimate != null && (
              <span className='text-slate-400'>
                {' '}
                · was about <span className='tabular-nums'>{num(data.value_then_estimate)}</span>
              </span>
            )}
          </p>
          <div className='max-h-[200px] space-y-px overflow-y-auto'>
            {data.events.map((e, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered events
                key={i}
                className='flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-muted'
                title={e.comment ?? undefined}
                data-trail-event={e.action}
              >
                <span className='w-12 shrink-0 text-[10.5px] tabular-nums text-slate-400'>
                  {when(e.at)}
                </span>
                <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                  <span className='text-slate-400'>
                    {e.by?.name ?? (e.via_import ? 'an import' : 'system')}
                  </span>{' '}
                  {ACTION_TEXT[e.action] ?? e.action}{' '}
                  <span className='text-slate-800 dark:text-slate-100'>{e.label}</span>
                  {e.action === 'changed' && e.from != null && e.to != null && (
                    <span className='text-slate-400'>
                      {' '}
                      {num(e.from)} → {num(e.to)}
                    </span>
                  )}
                  {e.via_import && (
                    <span className='ml-1 rounded bg-slate-100 px-1 text-[9.5px] uppercase text-slate-500 dark:bg-muted'>
                      import
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    'shrink-0 font-mono tabular-nums',
                    (e.delta ?? 0) > 0
                      ? 'text-[#15803d] dark:text-[#9fbf8a]'
                      : (e.delta ?? 0) < 0
                        ? 'text-[#b91c1c] dark:text-[#e08383]'
                        : 'text-slate-400'
                  )}
                >
                  {signed(e.delta)}
                </span>
              </div>
            ))}
          </div>
          {data.truncated && (
            <p className='px-1 pt-1 text-[10.5px] text-slate-400'>
              Only the first 300 changes are shown.
            </p>
          )}
          {data.note && <p className='px-1 pt-1 text-[10.5px] text-slate-400'>{data.note}</p>}
        </>
      )}
    </div>
  )
}

/**
 * "= 5 lines · 1 excluded (line type is not 4)" under a rollup header chip.
 * The summary is fetched once the chip is on screen (cheap: one lineage
 * read); the popover lists contributors, the excluded rows and per-source
 * subtotals so a total is never a mystery.
 */
export function HeaderRollupExplainer({
  collection,
  itemId,
  field,
  noun = 'lines'
}: {
  collection: string
  itemId: string
  field: string
  noun?: string
}) {
  const [open, setOpen] = useState(false)
  const settled = useAfterIdle(1500)
  const { data, isLoading } = useFieldLineage(collection, itemId, field, settled)
  const summary = lineageSummary(data, noun)
  const num = (v: unknown): string =>
    v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (!summary && !isLoading) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-copy-skip
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-left text-[10.5px] leading-none text-slate-500 hover:text-nvr-cyan dark:text-slate-400',
            open && 'text-nvr-cyan'
          )}
          data-tip='Where this number comes from'
        >
          <Sigma className='h-2.5 w-2.5 shrink-0' aria-hidden='true' />
          <span className='truncate'>{summary ?? '…'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[380px] p-2 text-[11.5px]'
        onClick={(e) => e.stopPropagation()}
      >
        <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
          Where this number comes from
        </p>
        {data && (data.kind === 'read' || data.kind === 'write') && (
          <div className='mb-1.5 px-1' data-lineage-formula>
            <p className='font-mono text-[11px] text-slate-700 dark:text-foreground'>
              {data.formula}
            </p>
            <p className='mt-0.5 text-[10.5px] text-slate-400'>
              {data.kind === 'read' ? 'Computed on read from' : 'Stored on save from'}
            </p>
            <dl className='mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5'>
              {Object.entries(data.inputs ?? {}).map(([k, v]) => (
                <div key={k} className='contents'>
                  <dt className='font-mono text-[10.5px] text-slate-500'>{k}</dt>
                  <dd className='text-right tabular-nums text-slate-800 dark:text-foreground'>
                    {num(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {(data?.sources ?? []).map((src, i) => (
          <div key={i} className='mb-1.5'>
            <p className='px-1 text-[10.5px] text-slate-400'>
              {(src.aggregate ?? 'sum').toUpperCase()}
              {src.value_field ? ` of ${src.value_field.replace(/_/g, ' ')}` : ''} across{' '}
              {src.collection.replace(/_/g, ' ')}
            </p>
            {src.note && <p className='px-1 py-1 text-slate-400'>{src.note}</p>}
            {src.error && <p className='px-1 py-1 text-amber-600'>{src.error}</p>}
            <div className='mt-0.5 max-h-[220px] space-y-px overflow-y-auto'>
              {src.rows.map((r) => (
                <div
                  key={r.id}
                  className='flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-muted'
                >
                  <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                    {r.label}
                  </span>
                  <span className='shrink-0 font-mono tabular-nums text-slate-800 dark:text-slate-100'>
                    {num(r.value)}
                  </span>
                </div>
              ))}
            </div>
            {src.subtotal != null && (
              <p className='border-t border-slate-100 px-1 pt-1 text-right font-medium text-slate-700 dark:border-border dark:text-slate-200'>
                subtotal {num(src.subtotal)}
              </p>
            )}
            {(src.excluded?.length ?? 0) > 0 && (
              <div className='mt-1 rounded bg-slate-50 px-1 py-1 dark:bg-muted/40'>
                <p className='text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                  {src.excluded!.length} excluded —{' '}
                  {src.excluded![0].reason.replace(/^does not match: /, '')}
                </p>
                {src.excluded!.slice(0, 8).map((r) => (
                  <div
                    key={r.id}
                    className='flex items-baseline gap-2 px-0.5 text-[11px] text-slate-400'
                  >
                    <span className='min-w-0 flex-1 truncate line-through decoration-slate-300'>
                      {r.label}
                    </span>
                    <span className='shrink-0 font-mono tabular-nums'>{num(r.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {data?.stored_value != null && (
          <p className='px-1 pt-1 text-right text-[11px] text-slate-500'>
            stored {num(data.stored_value)}
          </p>
        )}
        <NumberTrailSection collection={collection} itemId={itemId} field={field} enabled={open} />
      </PopoverContent>
    </Popover>
  )
}
