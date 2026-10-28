import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { UserCombobox } from '@/components/user-combobox'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'

/**
 * Search item 25 — "Why can't they find it?" (admin only, Search analytics).
 * Pick a person and the text they searched for: GET /global-search/why counts
 * the search as you and as them per collection and, where they find fewer,
 * names what hides the rest — their role, a row rule, an access filter (User
 * Scope) or a field their role cannot read — with up to three example records.
 */

interface WhyReason {
  type: 'permission' | 'not_found' | 'row_filter' | 'scope' | 'scope_strict' | 'unknown' | 'fields'
  message: string
  dimension_label?: string
  samples: number
}

interface WhySample {
  id: string
  label: string
  reasons: Array<{ type: string; message: string }>
}

interface WhyRow {
  collection: string
  display_name: string | null
  admin_count: number
  user_count: number
  hidden: number
  reasons: WhyReason[]
  samples: WhySample[]
}

interface WhyAnswer {
  q: string
  labels_only: boolean
  user: {
    id: string
    name: string
    email: string | null
    status: string | null
    role_name: string | null
    is_admin: boolean
  }
  totals: { admin: number; user: number; hidden: number }
  collections: WhyRow[]
}

const REASON_TAG: Record<WhyReason['type'], string> = {
  permission: 'Role',
  row_filter: 'Row rule',
  scope: 'Access filter',
  scope_strict: 'Access filter',
  fields: 'Field access',
  not_found: 'Missing',
  unknown: 'Check'
}

const errorText = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  'The check could not be run.'

function Reasons({ row }: { row: WhyRow }) {
  if (row.hidden === 0)
    return (
      <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        They find all of these.
      </span>
    )
  return (
    <div className='space-y-1.5'>
      <ul className='space-y-1'>
        {row.reasons.map((r) => (
          <li key={`${r.type}|${r.dimension_label ?? ''}`} className='flex items-start gap-1.5'>
            <span className='mt-px inline-flex shrink-0 items-center rounded bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'>
              {REASON_TAG[r.type] ?? 'Reason'}
            </span>
            <span className='text-[12px] text-slate-700 dark:text-slate-200'>{r.message}</span>
          </li>
        ))}
      </ul>
      {row.samples.length > 0 && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          For example{' '}
          {row.samples.map((s, i) => (
            <span key={s.id}>
              {i > 0 && (i === row.samples.length - 1 ? ' and ' : ', ')}
              <Link
                to={`/collections/${row.collection}/${encodeURIComponent(s.id)}`}
                className='font-medium text-cyan-700 hover:underline dark:text-nvr-cyan'
                data-tip={s.reasons.map((r) => r.message).join(' ')}
              >
                {s.label || s.id}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  )
}

export function SearchWhyCard() {
  const id = useId()
  const [userId, setUserId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [labelsOnly, setLabelsOnly] = useState(false)
  const [asked, setAsked] = useState<{ userId: string; q: string; labels: boolean } | null>(null)

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['search-analytics', 'why', asked],
    queryFn: () =>
      api
        .get<{ data: WhyAnswer }>('/global-search/why', {
          params: { q: asked!.q, user_id: asked!.userId, ...(asked!.labels ? { labels: 1 } : {}) }
        })
        .then((r) => r.data.data),
    enabled: !!asked,
    staleTime: 30_000,
    retry: false
  })

  const canAsk = !!userId && text.trim().length >= 2
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (canAsk) setAsked({ userId: userId!, q: text.trim(), labels: labelsOnly })
  }

  return (
    <section
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      aria-labelledby={`why-title-${id}`}
      data-search-why
    >
      <h2
        id={`why-title-${id}`}
        className='text-[13px] font-semibold text-slate-800 dark:text-foreground'
      >
        Why can’t they find it?
      </h2>
      <p className='mt-0.5 max-w-[72ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Pick a person and type what they searched for. For each collection where you find more than
        they do, this says what hides the rest: their role, a row rule, an access filter, or a field
        they may not read.
      </p>
      <form onSubmit={submit} className='mt-3 flex flex-wrap items-center gap-2'>
        <div className='w-[260px]'>
          <UserCombobox
            value={userId}
            onChange={setUserId}
            searchServer
            hideNone
            placeholder='Choose a person…'
            className='h-8 text-[12.5px]'
          />
        </div>
        <label htmlFor={`why-q-${id}`} className='sr-only'>
          What they searched for
        </label>
        <Input
          id={`why-q-${id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='What they searched for'
          maxLength={200}
          className='h-8 w-[240px] text-[12.5px]'
        />
        <label
          htmlFor={`why-labels-${id}`}
          className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'
          data-tip='Match only what record labels show, like the portal search bar'
        >
          <Switch id={`why-labels-${id}`} checked={labelsOnly} onCheckedChange={setLabelsOnly} />
          Labels only
        </label>
        <Button
          type='submit'
          size='sm'
          disabled={!canAsk || isFetching}
          className='h-8 text-[12.5px]'
        >
          {isFetching ? 'Checking…' : 'Check'}
        </Button>
      </form>

      {asked && isFetching && !data && (
        <div className='mt-4 space-y-2'>
          <Skeleton className='h-4 w-72' />
          <Skeleton className='h-24 w-full' />
        </div>
      )}
      {asked && isError && (
        <p className='mt-4 text-[12.5px] text-red-600 dark:text-red-400'>{errorText(error)}</p>
      )}
      {data && <WhyResult data={data} />}
    </section>
  )
}

function WhyResult({ data }: { data: WhyAnswer }) {
  const who = data.user.name
  const inactive = data.user.status && data.user.status !== 'active'
  return (
    <div className='mt-4 space-y-3' aria-live='polite'>
      {inactive && (
        <p className='rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'>
          {who}’s account is {data.user.status} — they cannot sign in to search at all.
        </p>
      )}
      <p className='text-[12.5px] text-slate-700 dark:text-slate-200'>
        {data.collections.length === 0 ? (
          <>
            Nothing matches <span className='font-mono'>{data.q}</span> for you either — check the
            spelling, or add a synonym above.
          </>
        ) : data.user.is_admin ? (
          <>
            {who} has an administrator role ({data.user.role_name ?? 'admin'}) and finds the same{' '}
            {formatNumber(data.totals.admin)} records you do.
          </>
        ) : (
          <>
            You find <strong className='font-semibold'>{formatNumber(data.totals.admin)}</strong>{' '}
            records for <span className='font-mono'>{data.q}</span>; {who}
            {data.user.role_name ? ` (${data.user.role_name})` : ''} finds{' '}
            <strong className='font-semibold'>{formatNumber(data.totals.user)}</strong>.
            {data.totals.hidden > 0
              ? ` ${formatNumber(data.totals.hidden)} are hidden from them.`
              : ' Nothing is hidden from them.'}
          </>
        )}
      </p>
      {data.collections.length > 0 && !data.user.is_admin && (
        <div className='overflow-x-auto'>
          <table className='w-full text-[12px] tabular-nums'>
            <thead>
              <tr className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
                <th className='py-1 pr-3 font-medium'>Collection</th>
                <th className='py-1 pr-3 text-right font-medium'>You</th>
                <th className='py-1 pr-3 text-right font-medium'>They</th>
                <th className='py-1 pr-3 text-right font-medium'>Hidden</th>
                <th className='py-1 font-medium'>Why</th>
              </tr>
            </thead>
            <tbody>
              {data.collections.map((r) => (
                <tr
                  key={r.collection}
                  className='border-t border-slate-100 align-top dark:border-border'
                >
                  <td className='py-1.5 pr-3'>
                    <span className='block text-slate-800 dark:text-foreground'>
                      {r.display_name || r.collection}
                    </span>
                    <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                      {r.collection}
                    </span>
                  </td>
                  <td className='py-1.5 pr-3 text-right text-slate-600 dark:text-slate-300'>
                    {formatNumber(r.admin_count)}
                  </td>
                  <td className='py-1.5 pr-3 text-right text-slate-600 dark:text-slate-300'>
                    {formatNumber(r.user_count)}
                  </td>
                  <td
                    className={cn(
                      'py-1.5 pr-3 text-right',
                      r.hidden > 0
                        ? 'font-semibold text-amber-700 dark:text-amber-300'
                        : 'text-slate-500 dark:text-muted-foreground'
                    )}
                  >
                    {r.hidden > 0 ? formatNumber(r.hidden) : '—'}
                  </td>
                  <td className='max-w-[520px] py-1.5'>
                    <Reasons row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
