import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, ScrollText } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { SectionCard } from '../profile/primitives'

// ─── Permission summary in words (#12) ──────────────────────────────────────
// "Buyers can see and edit purchase orders in their own Zones, can't delete,
// can't see the Cost field." GET /api/access/summary builds every sentence
// from can(), the field lists, row filters and User Scopes the API enforces,
// so the words match what the role / person actually gets.

export interface PermissionSummaryLine {
  collections: string[]
  labels: string[]
  kind: 'full' | 'read_only' | 'limited' | 'hidden'
  sentence: string
}

export interface PermissionSummaryData {
  subject: { kind: 'role' | 'user'; name: string; role_name: string | null; admin: boolean }
  headline: string
  lines: PermissionSummaryLine[]
  ui_line: string | null
  closed_line: string | null
  sentences: string[]
  ui_disabled: string[]
  summary: string
}

const SHOWN = 8

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  const shown = items.slice(0, 8)
  const more = items.length - shown.length
  return more > 0
    ? `${shown.join(', ')} and ${more} more`
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

export function usePermissionSummary(target: { roleId?: string | null; userId?: string | null }) {
  const client = useNivaroClient()
  const qs = target.roleId
    ? `role=${encodeURIComponent(target.roleId)}`
    : `user=${encodeURIComponent(target.userId ?? '')}`
  return useQuery<PermissionSummaryData>({
    queryKey: ['access-summary', target.roleId ? 'role' : 'user', target.roleId ?? target.userId],
    queryFn: () =>
      client
        .request<{ data: PermissionSummaryData }>(get(`/access/summary?${qs}`))
        .then((r) => r.data),
    enabled: !!(target.roleId || target.userId),
    staleTime: 60_000
  })
}

/** The sentences alone — for a host that frames them itself (Roles page tab). */
export function PermissionSummaryBody({
  roleId,
  userId,
  pageLabel
}: {
  roleId?: string | null
  userId?: string | null
  /** Turns a disabled page path into the host's nav label. */
  pageLabel?: (path: string) => string | null | undefined
}) {
  const { data, isLoading, isError } = usePermissionSummary({ roleId, userId })
  const [all, setAll] = useState(false)
  if (isLoading)
    return (
      <p className='flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' /> Reading the policies…
      </p>
    )
  if (isError || !data)
    return (
      <p className='text-[12px] text-slate-500 dark:text-slate-400'>
        Could not put this access into words.
      </p>
    )
  const lines = all ? data.lines : data.lines.slice(0, SHOWN)
  const uiLine =
    data.ui_disabled.length && pageLabel
      ? `Pages turned off${data.ui_line?.includes(' for you') ? ' for you' : ''}: ${listWords(
          data.ui_disabled.map((p) => pageLabel(p) || p)
        )}.`
      : data.ui_line
  const tail = data.sentences.filter(
    (s) => s !== data.ui_line && s !== data.closed_line && !data.lines.some((l) => l.sentence === s)
  )
  return (
    <div
      className='space-y-2 text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300'
      data-access-summary
    >
      <p className='font-medium text-slate-800 dark:text-slate-100'>{data.headline}</p>
      {lines.length > 0 && (
        <ul className='space-y-1.5'>
          {lines.map((l) => (
            <li
              key={l.sentence}
              data-access-line={l.kind}
              className='border-l-2 border-slate-200 pl-2.5 dark:border-border'
            >
              {l.sentence}
            </li>
          ))}
        </ul>
      )}
      {data.lines.length > SHOWN && (
        <button
          type='button'
          onClick={() => setAll((v) => !v)}
          className='text-[12px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
        >
          {all ? 'Show fewer' : `Show all ${data.lines.length}`}
        </button>
      )}
      {data.closed_line && data.lines.length > 0 && (
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>{data.closed_line}</p>
      )}
      {uiLine && <p className='text-[12px] text-slate-500 dark:text-slate-400'>{uiLine}</p>}
      {tail.map((s) => (
        <p key={s} className='text-[12px] text-amber-700 dark:text-amber-400'>
          {s}
        </p>
      ))}
    </div>
  )
}

/** People page Access tab card. */
export function PermissionSummaryCard({
  roleId,
  userId,
  pageLabel
}: {
  roleId?: string | null
  userId?: string | null
  pageLabel?: (path: string) => string | null | undefined
}) {
  const { refetch, isFetching } = usePermissionSummary({ roleId, userId })
  return (
    <SectionCard
      icon={<ScrollText className='h-4 w-4' />}
      title='Permissions in words'
      hint='From the role’s policies, field lists, row filters and User Scopes — what the API enforces'
      testId='permission-summary'
      actions={
        <button
          type='button'
          onClick={() => void refetch()}
          disabled={isFetching}
          className='text-slate-400 transition-colors hover:text-nvr-cyan disabled:opacity-50'
          aria-label='Read again'
        >
          <RefreshCw className={isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        </button>
      }
    >
      <PermissionSummaryBody roleId={roleId} userId={userId} pageLabel={pageLabel} />
    </SectionCard>
  )
}
