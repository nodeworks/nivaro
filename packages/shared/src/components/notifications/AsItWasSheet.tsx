import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import {
  type AsItWasPayload,
  formatSnapshotValue,
  orderSnapshotFields,
  snapshotFieldLabel
} from './as-it-was'

/**
 * "As it was" (#1385): the record as it stood when the notification was sent
 * beside the record now — two columns, the fields that moved since marked
 * with an amber dot and listed first. Scalar + link fields only; the server
 * narrows both sides to what the viewer may read NOW. Needs `<NivaroProvider>`.
 */
export function AsItWasSheet({
  notificationId,
  title,
  onClose
}: {
  notificationId: number | null
  /** The notification's subject — the sheet's eyebrow. */
  title?: string | null
  onClose: () => void
}) {
  const client = useNivaroClient()
  const open = notificationId != null
  const { data, isPending, error } = useQuery({
    queryKey: ['notification-as-it-was', notificationId],
    queryFn: () =>
      client
        .request<{ data: AsItWasPayload }>(get(`/notifications/${notificationId}/as-it-was`))
        .then((r) => r.data),
    enabled: open,
    retry: false,
    staleTime: 60_000
  })
  const err = error as { status?: number; message?: string } | null
  const fields = data ? orderSnapshotFields(data) : []
  const changed = new Set(data?.changed_fields ?? [])
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className='flex w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[920px]'
        data-notification-as-it-was-sheet={notificationId ?? ''}
      >
        <SheetHeader className='border-b border-slate-200 px-5 py-4 dark:border-border'>
          <SheetTitle className='flex items-center gap-2 text-[15px]'>
            <History className='h-4 w-4 text-slate-400' />
            As it was when you were told
          </SheetTitle>
          {title && (
            <p className='truncate text-[12px] text-slate-500 dark:text-slate-400'>{title}</p>
          )}
          {data && (
            <p className='text-[11.5px] text-slate-400' data-notification-as-it-was-meta>
              {data.snapshot
                ? `Snapshot from ${formatRelative(data.at ?? data.notified_at ?? new Date())}${
                    data.revision_id != null ? ` · revision ${data.revision_id}` : ''
                  } · ${changed.size} field${changed.size === 1 ? '' : 's'} changed since`
                : 'No snapshot from that time'}
            </p>
          )}
        </SheetHeader>
        <div className='min-h-0 flex-1 overflow-y-auto'>
          {isPending ? (
            <div className='space-y-2 p-5'>
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className='h-5 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]'
                />
              ))}
            </div>
          ) : err ? (
            <p className='p-5 text-[13px] text-slate-500' data-notification-as-it-was-error>
              {err.status === 403 || err.status === 404
                ? 'You can no longer open this record, so there is nothing to compare it with.'
                : (err.message ?? 'Could not load the snapshot.')}
            </p>
          ) : !data ? null : !data.snapshot ? (
            <div className='p-5' data-notification-as-it-was-empty>
              <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>
                No snapshot from that time
              </p>
              <p className='mt-1 text-[12px] text-slate-500'>
                The record has no saved version from before this notification — it was either never
                edited through the app, or its history has been pruned. The current values are
                below.
              </p>
              <dl className='mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-[12.5px]'>
                {fields.map((f) => (
                  <div key={f.field} className='contents'>
                    <dt className='truncate text-slate-500'>{snapshotFieldLabel(f)}</dt>
                    <dd className='min-w-0 break-words text-slate-800 dark:text-slate-100'>
                      {formatSnapshotValue(
                        data.current[f.field],
                        f,
                        data.labels[f.field]?.current
                      ) || <span className='text-slate-300 dark:text-slate-600'>—</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <table className='w-full border-collapse text-[12.5px]'>
              <thead className='sticky top-0 bg-slate-50 dark:bg-muted/40'>
                <tr className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  <th className='w-[22%] px-5 py-2 text-left font-semibold'>Field</th>
                  <th className='px-3 py-2 text-left font-semibold'>
                    Then
                    <span className='ml-1 font-normal normal-case tracking-normal text-slate-400'>
                      {data.at ? formatRelative(data.at) : ''}
                    </span>
                  </th>
                  <th className='px-3 py-2 text-left font-semibold'>Now</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
                {fields.length === 0 && (
                  <tr>
                    <td colSpan={3} className='px-5 py-6 text-center text-slate-400'>
                      Nothing to show for this record.
                    </td>
                  </tr>
                )}
                {fields.map((f) => {
                  const moved = changed.has(f.field)
                  const then = formatSnapshotValue(
                    data.snapshot?.[f.field],
                    f,
                    data.labels[f.field]?.snapshot
                  )
                  const now = formatSnapshotValue(
                    data.current[f.field],
                    f,
                    data.labels[f.field]?.current
                  )
                  const cell = (v: string, tone: string) =>
                    v ? (
                      <span className={cn('break-words', tone)}>{v}</span>
                    ) : (
                      <span className='text-slate-300 dark:text-slate-600'>—</span>
                    )
                  return (
                    <tr
                      key={f.field}
                      className={cn(moved && 'bg-amber-50/60 dark:bg-amber-400/10')}
                      data-notification-as-it-was-field={f.field}
                      data-notification-as-it-was-changed={moved ? '1' : '0'}
                    >
                      <td className='px-5 py-2 align-top text-slate-500 dark:text-slate-400'>
                        <span className='inline-flex items-center gap-1.5'>
                          {moved && (
                            <span
                              className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500'
                              data-tip='Changed since you were told'
                            />
                          )}
                          {snapshotFieldLabel(f)}
                        </span>
                      </td>
                      <td className='px-3 py-2 align-top text-slate-700 dark:text-slate-300'>
                        {cell(then, moved ? 'line-through decoration-slate-300' : '')}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 align-top',
                          moved
                            ? 'font-medium text-slate-900 dark:text-slate-100'
                            : 'text-slate-700 dark:text-slate-300'
                        )}
                      >
                        {cell(now, '')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
