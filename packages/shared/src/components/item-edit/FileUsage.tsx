import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Link2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

// ─── Where a file was used (#1288) ───────────────────────────────────────────
// A file chip on a record form carries a small "used in" glyph with a count;
// opening it lists what carried the file on THIS record — the addendum that
// attached it, the push whose payload named it, the email it rode, the layout
// that generated it. One request per field for all of its files, sent only
// once the chips are on screen and never for a new record.

export type FileUseKind = 'addendum' | 'push' | 'email' | 'generated'

export interface FileUse {
  kind: FileUseKind
  /** The source row's own id (addendum uuid, submission / mail-log / layout id). */
  id: string
  label: string
  at: string | null
  /** Admin-shaped console path; mapped through NavigationContext.consoleUrl. */
  href?: string
  /** An addendum use: opens the record on that addendum view. */
  addendum_id?: string
  detail?: string
  /** 'name' = only the download name matched (less certain than the uuid). */
  match: 'id' | 'name'
}

export type FileUsageMap = Record<string, FileUse[]>

const KIND_LABEL: Record<FileUseKind, string> = {
  addendum: 'Addendum',
  push: 'Integration',
  email: 'Email',
  generated: 'Generated'
}

const KIND_TONE: Record<FileUseKind, string> = {
  addendum: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  push: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  email: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  generated: 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
}

/** True once the element has been on screen — the usage read is deferred
 *  until then so a form with its files on a later step pays nothing.
 *  `active` re-arms the observer when the observed element mounts later
 *  (a field that had no file when the form opened). */
export function useOnceVisible<T extends HTMLElement>(
  active = true
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (visible || !active) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true)
        obs.disconnect()
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [visible, active])
  return [ref, visible]
}

/** One batched read per field for all of its files. Off until the host says
 *  the chips are visible, and always off on a new record (nothing could have
 *  carried a file of a record that does not exist yet). */
export function useFileUsage(
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  fileIds: string[],
  enabled: boolean
) {
  const client = useNivaroClient()
  const ids = [...new Set(fileIds.filter(Boolean))].sort()
  const item = itemId != null ? String(itemId) : ''
  const on = enabled && !!collection && !!item && item !== 'new' && ids.length > 0
  return useQuery<FileUsageMap>({
    queryKey: ['file-usage', collection, item, ...ids],
    queryFn: () =>
      client
        .request<{ data: FileUsageMap }>(
          post('/files/usage/on-record', { collection, item, file_ids: ids })
        )
        .then((r) => r.data ?? {}),
    enabled: on,
    staleTime: 60_000,
    retry: false
  })
}

function UseLink({
  use,
  collection,
  itemId,
  children
}: {
  use: FileUse
  collection: string | null | undefined
  itemId: string | null | undefined
  children: React.ReactNode
}) {
  const nav = useNavigation()
  const { urlFor, open } = useItemNavigation()
  const linkCls =
    'group/use inline-flex items-center gap-1 text-left hover:underline text-slate-800 dark:text-foreground'

  if (use.kind === 'addendum' && use.addendum_id && collection && itemId) {
    const target = { collection, itemId, query: { addendum: use.addendum_id } }
    return (
      <a
        href={urlFor(target)}
        className={linkCls}
        onClick={(e) => {
          e.preventDefault()
          open(target)
        }}
      >
        {children}
      </a>
    )
  }
  if (use.href) {
    const mapped = nav.consoleUrl ? nav.consoleUrl(use.href) : use.href
    if (mapped === null)
      return <span className='text-slate-800 dark:text-foreground'>{children}</span>
    if (/^https?:\/\//.test(mapped)) {
      return (
        <a href={mapped} target='_blank' rel='noreferrer' className={linkCls}>
          {children}
          <ExternalLink className='h-3 w-3 text-slate-400' />
        </a>
      )
    }
    return (
      <a
        href={mapped}
        className={linkCls}
        onClick={(e) => {
          e.preventDefault()
          nav.navigate(mapped)
        }}
      >
        {children}
      </a>
    )
  }
  return <span className='text-slate-800 dark:text-foreground'>{children}</span>
}

/** The glyph + count on a file chip, opening the list of uses. Renders
 *  nothing while the usage is unknown (new record, not yet on screen). */
export function FileUsageChip({
  fileId,
  uses,
  loading,
  collection,
  itemId
}: {
  fileId: string
  uses: FileUse[] | undefined
  loading: boolean
  collection: string | null | undefined
  itemId: string | null | undefined
}) {
  if (!loading && uses === undefined) return null
  const count = uses?.length ?? 0
  const tip = loading
    ? 'Checking where this file was used…'
    : count === 0
      ? 'Not used anywhere yet'
      : `Used in ${count} place${count === 1 ? '' : 's'}`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-file-usage-open={fileId}
          data-tip={tip}
          aria-label={tip}
          disabled={loading}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] tabular-nums transition-colors',
            count > 0
              ? 'bg-nvr-cyan/10 text-nvr-navy hover:bg-nvr-cyan/20 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
              : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200',
            loading && 'opacity-50'
          )}
        >
          <Link2 className='h-3 w-3' />
          <span data-file-usage-count={count}>{loading ? '…' : count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-[340px] p-2 text-[11.5px]'
        onClick={(e) => e.stopPropagation()}
      >
        <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
          Where this file was used
        </p>
        {count === 0 ? (
          <p className='px-1 py-1 text-slate-500 dark:text-muted-foreground'>
            Not used anywhere yet — no addendum, push, email or generated document on this record
            carried it.
          </p>
        ) : (
          <ul className='max-h-72 space-y-1 overflow-y-auto'>
            {uses!.map((u) => (
              <li
                key={`${u.kind}:${u.id}`}
                data-file-use={u.kind}
                data-file-use-match={u.match}
                className='rounded px-1 py-1 hover:bg-muted'
              >
                <div className='flex items-start gap-1.5'>
                  <span
                    className={cn(
                      'mt-px shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide',
                      KIND_TONE[u.kind]
                    )}
                  >
                    {KIND_LABEL[u.kind]}
                  </span>
                  <div className='min-w-0 flex-1'>
                    <UseLink use={u} collection={collection} itemId={itemId}>
                      <span className='break-words'>{u.label}</span>
                    </UseLink>
                    <div className='mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-slate-500 dark:text-muted-foreground'>
                      {u.at && <span data-tip={formatDateTime(u.at)}>{formatRelative(u.at)}</span>}
                      {u.detail && <span>{u.detail}</span>}
                      {u.match === 'name' && (
                        <span
                          className='rounded bg-amber-500/10 px-1 text-amber-700 dark:text-amber-300'
                          data-tip='Matched by the file name only — the source does not hold the file id'
                        >
                          by name
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
