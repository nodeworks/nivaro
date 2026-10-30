import { useActivityLabels } from '@nivaro/shared'
import { ChevronDown } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { cn, formatRelative, titleCase } from '@/lib/utils'
import type { SinceDigest } from './api'
import { Bone } from './parts'
import { digestSentence, plural } from './text'

/**
 * "Since Tuesday: 38 records changed, 1 release, 1 new person" under the greeting, opening to a
 * short list: records of yours someone else changed, the release, new people, failed jobs.
 * Hidden on a first visit. Everything in it was computed as the viewer.
 */

export function SinceLastVisit({
  digest,
  isLoading,
  isAdmin
}: {
  digest: SinceDigest | null
  isLoading: boolean
  isAdmin: boolean
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  // Record names, read as the viewer (a record they cannot see stays unnamed).
  const refs = useMemo(
    () =>
      (digest?.my_records ?? []).map((r) => ({
        id: null,
        action: 'update',
        collection: r.collection,
        item: r.item,
        timestamp: r.last_at
      })),
    [digest]
  )
  const labels = useActivityLabels(refs as never[])
  if (isLoading) return <Bone className='mt-1.5 h-3.5 w-72 max-w-full' />
  if (!digest) return null
  const sentence = digestSentence(digest, new Date())
  const hasList =
    digest.my_records.length > 0 ||
    !!digest.release ||
    digest.people.length > 0 ||
    (digest.failed_jobs ?? 0) > 0
  const colName = (c: string) => {
    const v = labels?.collections?.[c]
    if (typeof v === 'string') return v
    return v?.singular || titleCase(c.replace(/_/g, ' '))
  }
  return (
    <div className='mt-1'>
      {hasList ? (
        <button
          type='button'
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className='inline-flex max-w-full items-start gap-1 rounded text-left text-[12.5px] text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-300 dark:hover:text-white'
        >
          <span>{sentence}</span>
          <ChevronDown
            className={cn(
              'mt-[3px] h-3.5 w-3.5 shrink-0 transition-transform duration-200 ease-out',
              open && 'rotate-180'
            )}
            aria-hidden
          />
        </button>
      ) : (
        <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>{sentence}</p>
      )}
      {open && hasList && (
        <ul
          id={listId}
          className='mt-2 max-w-xl space-y-1 border-l border-slate-200 pl-3 text-[12.5px] text-slate-700 duration-200 animate-in fade-in dark:border-border dark:text-slate-200'
        >
          {digest.my_records.map((r) => {
            const label = labels?.records?.[`${r.collection}:${r.item}`]
            return (
              <li key={`${r.collection}:${r.item}`} className='flex items-baseline gap-2'>
                <Link
                  to={`/collections/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.item)}`}
                  className='min-w-0 truncate rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
                >
                  {label || `${colName(r.collection)} ${r.item}`}
                </Link>
                <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-slate-400'>
                  {plural(r.changes, 'change')} · {formatRelative(r.last_at)}
                </span>
              </li>
            )
          })}
          {digest.my_records_changed > digest.my_records.length && (
            <li className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              and {digest.my_records_changed - digest.my_records.length} more of your records
            </li>
          )}
          {digest.release && (
            <li>
              Nivaro updated from {digest.release.from} to {digest.release.to}
            </li>
          )}
          {isAdmin &&
            digest.people.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/users/${p.id}`}
                  className='rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
                >
                  {p.name}
                </Link>{' '}
                <span className='text-slate-500 dark:text-slate-400'>joined</span>
              </li>
            ))}
          {isAdmin && (digest.failed_jobs ?? 0) > 0 && (
            <li>
              <Link
                to='/jobs'
                className='rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
              >
                {plural(digest.failed_jobs ?? 0, 'job')} failed
              </Link>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
