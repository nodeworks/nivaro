import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useId } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { formatDateTime, formatRelative } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

// ─── Who downloaded a record's files (#3235) ─────────────────────────────────
// For administrators, a file chip on a record form carries how many people
// downloaded it from THIS record (GET /api/file-downloads/on-record): hovering
// names them, clicking lists each with a count and when. Read once the chips are
// on screen, never for a new record; nothing shows for a file nobody downloaded.

export interface DownloadPerson {
  user: string
  name: string
  count: number
  last: string
}

export interface FileDownloadStat {
  count: number
  people: DownloadPerson[]
}

export type FileDownloadStats = Record<string, FileDownloadStat>

export function useFileDownloadStats(
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  fileIds: string[],
  enabled: boolean
) {
  const client = useNivaroClient()
  const { isAdmin } = useItemEditAuth()
  const ids = [...new Set(fileIds.filter(Boolean))].sort()
  const item = itemId != null ? String(itemId) : ''
  const on = isAdmin && enabled && !!collection && !!item && item !== 'new' && ids.length > 0
  return useQuery<FileDownloadStats>({
    queryKey: ['file-download-stats', collection, item, ...ids],
    queryFn: () =>
      client
        .request<{ data: FileDownloadStats }>(
          get('/file-downloads/on-record', { collection, item, ids: ids.join(',') })
        )
        .then((r) => r.data ?? {}),
    enabled: on,
    staleTime: 60_000,
    retry: false
  })
}

/** "Downloaded 5 times: Pat Lee (3), Sam Ortiz (2)" — the hover text. */
export function downloadTip(stat: FileDownloadStat | undefined): string {
  if (!stat || stat.count === 0) return 'Not downloaded from this record yet'
  const head = `Downloaded ${stat.count} time${stat.count === 1 ? '' : 's'}`
  const names = stat.people.slice(0, 4).map((p) => `${p.name} (${p.count})`)
  const more = stat.people.length > 4 ? `, +${stat.people.length - 4} more` : ''
  return `${head}: ${names.join(', ')}${more}`
}

/** Who downloaded this file from this record: a people glyph + count, apart from the
 *  file's own Download action. Nothing for a file nobody downloaded here. */
export function FileDownloadCount({
  fileId,
  stat
}: {
  fileId: string
  stat: FileDownloadStat | undefined
}) {
  const headingId = useId()
  const count = stat?.count ?? 0
  if (count === 0) return null
  const tip = downloadTip(stat)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-file-downloads-open={fileId}
          data-tip={tip}
          aria-label={`${count} download${count === 1 ? '' : 's'}: ${tip}`}
          onClick={(e) => e.stopPropagation()}
          className='inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] tabular-nums text-slate-600 transition-colors hover:bg-slate-500/10 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
        >
          <Users className='h-3 w-3' aria-hidden='true' />
          <span data-file-downloads-count={count}>{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        aria-labelledby={headingId}
        className='w-[300px] p-2 text-[12px]'
        onClick={(e) => e.stopPropagation()}
      >
        <p
          id={headingId}
          className='mb-1 px-1 text-[11px] font-medium text-slate-600 dark:text-slate-300'
        >
          Downloaded from this record
        </p>
        <ul className='max-h-72 space-y-0.5 overflow-y-auto'>
          {stat!.people.map((p) => (
            <li
              key={p.user || p.name}
              data-file-download-person={p.user}
              className='flex items-baseline gap-2 rounded px-1 py-1 hover:bg-muted'
            >
              <span className='min-w-0 flex-1 truncate text-slate-800 dark:text-foreground'>
                {p.name}
              </span>
              <span className='shrink-0 tabular-nums text-slate-600 dark:text-slate-300'>
                {p.count === 1 ? 'once' : `${p.count} times`}
              </span>
              <span
                className='shrink-0 text-[11px] text-slate-600 dark:text-slate-300'
                data-tip={formatDateTime(p.last)}
              >
                {formatRelative(p.last)}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
