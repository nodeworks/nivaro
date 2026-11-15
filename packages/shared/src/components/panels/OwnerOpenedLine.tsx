import { useQuery } from '@tanstack/react-query'
import { Eye, EyeOff } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { UserChip } from '../item-edit/UserChip'

/**
 * "Opened by the owner" (idea 21): for someone who is NOT an owner of the current step — the
 * requester above all — one line under the Owners roster saying whether an owner has opened
 * the record since it reached this step, so they know whether to chase. The server decides
 * (services/owner-opened.ts): which owners, which opens count (never a View-as one), which
 * names may be shown. Read only while the panel shows it; a failed read shows nothing.
 */

export type OwnerOpenedData =
  | { status: 'none' }
  | { status: 'owner' }
  | { status: 'not_opened'; state: { id: string; label: string }; entered_at: string }
  | {
      status: 'opened'
      state: { id: string; label: string }
      entered_at: string
      opened_at: string
      by: {
        id: string
        name: string
        group: string | null
        /** A delegate's open: the out-of-office owner they covered for. */
        covering_for?: string | null
      } | null
      /** The opener was a delegate covering an out-of-office owner. */
      delegate?: boolean
      others: number
    }

export const OWNER_OPENED_HEAD = 'pipeline-owner-opened'

/** The words around the opener's name. Pure — exported for tests. */
export function ownerOpenedWords(
  data: OwnerOpenedData,
  rel: (iso: string) => string = formatRelative
): { lead: string | null; name: string | null; group: string | null; tail: string } | null {
  if (data.status === 'not_opened') {
    return {
      lead: 'Not opened yet by the owners of this step',
      name: null,
      group: null,
      tail: ` · arrived ${rel(data.entered_at)}`
    }
  }
  if (data.status !== 'opened') return null
  const others =
    data.others > 0 ? ` · ${data.others} other owner${data.others === 1 ? '' : 's'} too` : ''
  // A delegate reads "Mark Lee (covering for Jane Smith)" in place of their department.
  const covering = data.by?.covering_for ? `covering for ${data.by.covering_for}` : null
  return {
    lead: data.by
      ? null
      : data.delegate
        ? 'Someone covering for an owner of this step'
        : 'An owner of this step',
    name: data.by?.name ?? null,
    group: covering ?? data.by?.group ?? null,
    tail: ` opened this ${rel(data.opened_at)}${others}`
  }
}

export function OwnerOpenedLine({
  collection,
  item,
  stateId,
  className
}: {
  collection: string
  item: string
  stateId: string
  className?: string
}) {
  const client = useNivaroClient()
  const { data } = useQuery<OwnerOpenedData | null>({
    queryKey: [OWNER_OPENED_HEAD, collection, item, stateId],
    queryFn: () =>
      client
        .request<{ data: OwnerOpenedData | null }>(
          get(`/pipelines/instance/${collection}/${item}/owner-opened`)
        )
        .then((r) => r.data ?? null),
    staleTime: 60_000,
    retry: false
  })
  if (!data || (data.status !== 'opened' && data.status !== 'not_opened')) return null
  const words = ownerOpenedWords(data)
  if (!words) return null
  const opened = data.status === 'opened'
  const Icon = opened ? Eye : EyeOff
  const exact = opened ? formatDateTime(data.opened_at) : formatDateTime(data.entered_at)
  return (
    <p
      data-owner-opened={data.status}
      className={cn(
        'flex items-start gap-1.5 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400',
        className
      )}
    >
      <Icon
        aria-hidden
        className={
          opened
            ? 'mt-px h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
            : 'mt-px h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
        }
      />
      <span data-tip={opened ? `Opened ${exact}` : `In this step since ${exact}`}>
        {words.lead}
        {opened && data.by ? (
          <>
            <UserChip userId={data.by.id}>
              <button
                type='button'
                aria-label={`${data.by.name} — profile`}
                className='rounded font-medium text-slate-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground'
              >
                {words.name}
              </button>
            </UserChip>
            {words.group ? ` (${words.group})` : null}
          </>
        ) : null}
        {words.tail}
      </span>
    </p>
  )
}
