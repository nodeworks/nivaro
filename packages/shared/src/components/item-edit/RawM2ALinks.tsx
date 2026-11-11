// Raw edit's view of a field that links to more than one kind of record (an
// M2A alias — e.g. an inventory request's ship-to contact: a person OR an
// external email). The plain M2M picker read every link as a person, so an
// external email showed "Record not found". This reads the field through the
// API's own M2A expansion (each link read from the collection it names, as the
// viewer) and lists every link as it really is. A link can be removed here
// (staged, saved with the sheet's Save); adding one needs a choice of kind, so
// that stays in the normal form.

import { useQuery } from '@tanstack/react-query'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { useM2MStaging } from './M2MStagingContext'

export interface M2ALinkRow {
  id: number | string
  item_id?: unknown
  item?: Record<string, unknown> | null
  [k: string]: unknown
}

/** What kind of record a link points at, in words. */
export function m2aKindLabel(collection: unknown): string {
  const c = String(collection ?? '').toLowerCase()
  if (c === 'directus_users' || c === 'nivaro_users') return 'Person'
  if (c === 'additional_emails') return 'External email'
  return c ? titleCase(c.replace(/_/g, ' ')) : 'Record'
}

/** Name + email of a linked record (people and external emails share these columns). */
export function m2aLinkText(item: Record<string, unknown> | null | undefined): {
  name: string | null
  email: string | null
} {
  if (!item) return { name: null, email: null }
  const first = String(item.first_name ?? '').trim()
  const last = String(item.last_name ?? '').trim()
  const name =
    [first, last].filter(Boolean).join(' ') ||
    (typeof item.name === 'string' && item.name.trim()) ||
    (typeof item.label === 'string' && item.label.trim()) ||
    null
  const email = typeof item.email === 'string' && item.email.trim() ? item.email.trim() : null
  return { name, email }
}

export function RawM2ALinks({
  collection,
  itemId,
  field,
  discriminator
}: {
  collection: string
  itemId: string | number
  field: string
  /** The junction column naming each link's collection (usually `collection`). */
  discriminator: string
}) {
  const client = useNivaroClient()
  const staging = useM2MStaging()
  const q = useQuery({
    queryKey: ['raw-edit-m2a', collection, String(itemId), field],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> | null }>(
          get(`/items/${collection}/${encodeURIComponent(String(itemId))}`, {
            fields: `id,${field}.*`
          })
        )
        .then((r) => {
          const v = r.data?.[field]
          return (Array.isArray(v) ? v : []) as M2ALinkRow[]
        }),
    staleTime: 15_000
  })
  const removed = staging?.getStagedUnlinks(field) ?? new Set<unknown>()

  if (q.isLoading)
    return (
      <p className='flex items-center gap-1.5 pt-1.5 text-[11.5px] text-slate-400'>
        <Loader2 className='h-3 w-3 animate-spin' aria-hidden /> Loading links…
      </p>
    )
  if (q.error)
    return (
      <p className='pt-1.5 text-[11.5px] text-red-600 dark:text-red-400'>
        Couldn’t load the links.
      </p>
    )
  const rows = q.data ?? []

  return (
    <div className='space-y-1.5' data-raw-m2a={field}>
      {rows.length === 0 ? (
        <p className='pt-1.5 text-[11.5px] italic text-slate-400'>No links</p>
      ) : (
        <ul className='flex flex-wrap gap-1.5'>
          {rows.map((r) => {
            const gone = [...removed].some((x) => String(x) === String(r.id))
            const { name, email } = m2aLinkText(r.item)
            const kind = m2aKindLabel(r[discriminator])
            return (
              <li
                key={String(r.id)}
                data-raw-m2a-link={String(r.id)}
                className={cn(
                  'inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1 text-[12px]',
                  gone
                    ? 'border-dashed border-red-300 bg-red-50/60 text-slate-400 line-through dark:border-red-500/40 dark:bg-red-500/10'
                    : 'border-slate-200 bg-white text-slate-800 dark:border-border dark:bg-card dark:text-foreground'
                )}
              >
                <span className='shrink-0 rounded bg-slate-100 px-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 no-underline dark:bg-muted dark:text-muted-foreground'>
                  {kind}
                </span>
                {r.item ? (
                  <span className='min-w-0 truncate'>
                    {name && <span className='font-medium'>{name}</span>}
                    {name && email && <span className='text-slate-400'> · </span>}
                    {email && <span className='font-mono text-[11.5px]'>{email}</span>}
                    {!name && !email && (
                      <span className='italic text-slate-400'>No name or email</span>
                    )}
                  </span>
                ) : (
                  <span className='italic text-slate-400'>
                    {kind} #{String(r.item_id ?? '')} is gone or hidden from you
                  </span>
                )}
                {staging &&
                  (gone ? (
                    <button
                      type='button'
                      aria-label='Keep this link'
                      data-tip='Keep this link'
                      onClick={() => staging.unstageUnlink(field, r.id)}
                      className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                    >
                      <RotateCcw className='h-3 w-3' />
                    </button>
                  ) : (
                    <button
                      type='button'
                      aria-label={`Remove ${name ?? email ?? 'this link'}`}
                      data-tip='Remove this link (saved with Save)'
                      onClick={() => staging.stageUnlink(field, r.id)}
                      className='rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
      <p className='text-[10.5px] text-slate-400'>
        Links to a person or an external email. Add one through the normal form.
      </p>
    </div>
  )
}
