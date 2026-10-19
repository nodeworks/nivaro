import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Copy, ExternalLink, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatNumber, formatRelative } from '@/lib/utils'
import {
  CHECK_LABEL,
  CHECK_WHY,
  errorText,
  type FindingDetail,
  type FindingRow,
  objectHref,
  objectLabel,
  SeverityPill,
  StatusText,
  TYPE_LABEL
} from './shared'

const PAGE = 50

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Expected' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' }
]
const SEVERITY_OPTIONS = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' }
]
const CHECK_OPTIONS = [
  { value: '', label: 'Any check' },
  ...Object.entries(CHECK_LABEL).map(([value, label]) => ({ value, label }))
]

export function FindingsTab({ initialObject }: { initialObject?: string | null }) {
  const [status, setStatus] = useState('open')
  const [severity, setSeverity] = useState('')
  const [check, setCheck] = useState('')
  const [draftQ, setDraftQ] = useState('')
  const [q, setQ] = useState('')
  const [object, setObject] = useState(initialObject ?? '')
  const [pageNo, setPageNo] = useState(1)
  const [selected, setSelected] = useState<number | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(draftQ.trim())
      setPageNo(1)
    }, 300)
    return () => clearTimeout(t)
  }, [draftQ])
  useEffect(() => {
    if (initialObject != null) {
      setObject(initialObject)
      setPageNo(1)
    }
  }, [initialObject])

  const list = useQuery({
    queryKey: ['sql-checks', 'findings', status, severity, check, q, object, pageNo],
    queryFn: () =>
      api
        .get<{ data: FindingRow[]; meta: { total: number } }>('/sql-checks/findings', {
          params: {
            status,
            severity: severity || undefined,
            check: check || undefined,
            q: q || undefined,
            object: object || undefined,
            page: pageNo,
            limit: PAGE
          }
        })
        .then((r) => r.data),
    placeholderData: (prev) => prev
  })
  const rows = list.data?.data ?? []
  const total = list.data?.meta.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  const reset = (fn: () => void) => {
    fn()
    setPageNo(1)
    setSelected(null)
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col lg:flex-row'>
      <section
        aria-label='Findings'
        className={cn(
          'flex min-h-0 flex-col border-slate-200 dark:border-border lg:w-[440px] lg:shrink-0 lg:border-r',
          selected != null && 'hidden lg:flex'
        )}
      >
        <div className='grid gap-2 border-b border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
          <div className='relative'>
            <Search
              className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground'
              aria-hidden='true'
            />
            <Input
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              placeholder='Search messages and objects'
              aria-label='Search findings'
              className='h-8 pl-8 text-[12.5px]'
            />
          </div>
          <div className='grid grid-cols-3 gap-2'>
            <SimpleSelect
              value={status}
              onChange={(v) => reset(() => setStatus(v))}
              options={STATUS_OPTIONS}
              ariaLabel='Status'
              className='h-8 text-[12px]'
            />
            <SimpleSelect
              value={severity}
              onChange={(v) => reset(() => setSeverity(v))}
              options={SEVERITY_OPTIONS}
              ariaLabel='Severity'
              className='h-8 text-[12px]'
            />
            <SimpleSelect
              value={check}
              onChange={(v) => reset(() => setCheck(v))}
              options={CHECK_OPTIONS}
              ariaLabel='Check'
              className='h-8 text-[12px]'
            />
          </div>
          {object && (
            <div className='flex items-center gap-2 text-[12px]'>
              <span className='min-w-0 truncate text-muted-foreground'>
                Object: <span className='font-mono text-foreground'>{object}</span>
              </span>
              <button
                type='button'
                onClick={() => reset(() => setObject(''))}
                className='shrink-0 rounded px-1.5 py-0.5 text-nvr-cyan hover:bg-nvr-cyan/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
              >
                Clear
              </button>
            </div>
          )}
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto bg-white dark:bg-card'>
          {list.isLoading ? (
            <div className='grid gap-2 p-3' role='status' aria-label='Loading findings'>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className='h-12 rounded-md' />
              ))}
            </div>
          ) : list.isError ? (
            <p className='m-0 p-4 text-[12.5px] text-red-600 dark:text-red-400'>
              {errorText(list.error, 'Couldn’t load the findings.')}
            </p>
          ) : rows.length === 0 ? (
            <p className='m-0 p-4 text-[12.5px] text-muted-foreground'>
              {status === 'open' && !severity && !check && !q && !object
                ? 'No open findings.'
                : 'Nothing matches these filters.'}
            </p>
          ) : (
            <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
              {rows.map((f) => (
                <li key={f.id}>
                  <button
                    type='button'
                    onClick={() => setSelected(f.id)}
                    aria-current={selected === f.id ? 'true' : undefined}
                    className={cn(
                      'grid w-full gap-1 px-3 py-2.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                      selected === f.id && 'bg-accent'
                    )}
                  >
                    <span className='flex min-w-0 items-center gap-2'>
                      <SeverityPill severity={f.severity} />
                      <span className='min-w-0 truncate text-[12px] font-medium'>
                        {CHECK_LABEL[f.check_key] ?? f.check_key}
                      </span>
                      {f.status !== 'open' && (
                        <span className='ml-auto shrink-0'>
                          <StatusText status={f.status} />
                        </span>
                      )}
                    </span>
                    <span className='min-w-0 truncate font-mono text-[11.5px] text-muted-foreground'>
                      {objectLabel(f)}
                      {f.line ? `:${f.line}` : ''}
                    </span>
                    <span className='line-clamp-2 text-[12px] text-foreground/90'>{f.message}</span>
                    <span className='text-[11px] text-muted-foreground'>
                      First seen {formatRelative(f.first_seen_at)} · seen in {f.seen_count}{' '}
                      {f.seen_count === 1 ? 'run' : 'runs'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {total > PAGE && (
          <div className='flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-border dark:bg-card'>
            <span className='text-muted-foreground'>
              {formatNumber(total)} findings · page {pageNo} of {pages}
            </span>
            <span className='flex gap-1'>
              <Button
                size='sm'
                variant='outline'
                className='h-7 px-2 text-[12px]'
                disabled={pageNo <= 1}
                onClick={() => setPageNo((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                size='sm'
                variant='outline'
                className='h-7 px-2 text-[12px]'
                disabled={pageNo >= pages}
                onClick={() => setPageNo((p) => p + 1)}
              >
                Next
              </Button>
            </span>
          </div>
        )}
      </section>
      <section
        aria-label='Finding detail'
        className={cn(
          'min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
          selected == null && 'hidden lg:block'
        )}
      >
        {selected == null ? (
          <div className='p-6 text-[12.5px] text-muted-foreground'>
            Pick a finding to see the statement, why it matters and how to fix it.
          </div>
        ) : (
          <FindingPanel key={selected} id={selected} onBack={() => setSelected(null)} />
        )}
      </section>
    </div>
  )
}

function FindingPanel({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient()
  const heading = useRef<HTMLHeadingElement>(null)
  const q = useQuery({
    queryKey: ['sql-checks', 'finding', id],
    queryFn: () =>
      api.get<{ data: FindingDetail }>(`/sql-checks/findings/${id}`).then((r) => r.data.data)
  })
  const [note, setNote] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [copied, setCopied] = useState(false)
  // the panel is keyed by finding id, so its state starts fresh; focus the heading once loaded
  const loadedId = q.data?.id
  useEffect(() => {
    if (loadedId != null) heading.current?.focus()
  }, [loadedId])

  const patch = useMutation({
    mutationFn: (body: { status: 'accepted' | 'open'; note?: string }) =>
      api.patch(`/sql-checks/findings/${id}`, body),
    onSuccess: (_r, body) => {
      toast.success(body.status === 'accepted' ? 'Marked as expected' : 'Reopened')
      setAccepting(false)
      setNote('')
      void qc.invalidateQueries({ queryKey: ['sql-checks'] })
    },
    onError: (err) => toast.error(errorText(err, 'Couldn’t save that.'))
  })

  const f = q.data
  const href = f ? objectHref(f) : null
  const snippetLines = useMemo(() => (f?.snippet ?? '').split('\n'), [f?.snippet])
  const figures = f?.detail as
    | {
        null_counts?: Record<string, number>
        extra_rows?: number
        table_rows?: number | null
        data?: string
        data_note?: string
        count?: number
        lines?: number[]
      }
    | null
    | undefined

  return (
    <div className='grid gap-4 p-4 sm:p-6'>
      <button
        type='button'
        onClick={onBack}
        className='inline-flex w-fit items-center gap-1 rounded text-[12px] text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan lg:hidden'
      >
        <ArrowLeft className='h-3.5 w-3.5' aria-hidden='true' /> All findings
      </button>
      {q.isLoading || !f ? (
        q.isError ? (
          <p className='m-0 text-[12.5px] text-red-600 dark:text-red-400'>
            {errorText(q.error, 'Couldn’t load this finding.')}
          </p>
        ) : (
          <div className='grid gap-3' role='status' aria-label='Loading finding'>
            <Skeleton className='h-6 w-2/3' />
            <Skeleton className='h-24' />
          </div>
        )
      ) : (
        <>
          <header className='grid gap-1.5'>
            <div className='flex flex-wrap items-center gap-2'>
              <SeverityPill severity={f.severity} />
              <StatusText status={f.status} />
              <span className='text-[12px] text-muted-foreground'>
                {CHECK_LABEL[f.check_key] ?? f.check_key}
              </span>
            </div>
            <h2
              ref={heading}
              tabIndex={-1}
              className='m-0 text-[15px] font-semibold leading-snug outline-none'
            >
              {f.message}
            </h2>
            <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]'>
              <span className='text-muted-foreground'>{TYPE_LABEL[f.object_type]}</span>
              <span className='min-w-0 break-all font-mono'>
                {objectLabel(f)}
                {f.line ? `, line ${f.line}` : ''}
              </span>
              {href && (
                <Link
                  to={href}
                  className='inline-flex items-center gap-1 rounded text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                >
                  Open in editor <ExternalLink className='h-3 w-3' aria-hidden='true' />
                </Link>
              )}
            </div>
          </header>

          <dl className='m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-[12px] dark:border-border dark:bg-border sm:grid-cols-4'>
            {[
              ['First seen', formatDateTime(f.first_seen_at)],
              ['Runs seen', String(f.seen_count)],
              ['Last seen in run', `#${f.last_seen_run}`],
              [
                f.status === 'resolved' ? 'Resolved' : 'Status',
                f.resolved_at
                  ? formatDateTime(f.resolved_at)
                  : f.status === 'accepted'
                    ? 'Expected'
                    : 'Open'
              ]
            ].map(([k, v]) => (
              <div key={k} className='bg-white px-3 py-2 dark:bg-card'>
                <dt className='text-[11px] text-muted-foreground'>{k}</dt>
                <dd className='m-0 mt-0.5 font-medium'>{v}</dd>
              </div>
            ))}
          </dl>

          <section className='grid gap-1.5'>
            <h3 className='m-0 text-[12.5px] font-semibold'>Why it matters</h3>
            <p className='m-0 text-[12.5px] text-foreground/90'>{CHECK_WHY[f.check_key] ?? ''}</p>
            {figures?.null_counts && (
              <ul className='m-0 grid gap-0.5 pl-4 text-[12.5px]'>
                {Object.entries(figures.null_counts).map(([col, n]) => (
                  <li key={col}>
                    <span className='font-mono'>{col}</span>: {formatNumber(n)} rows hold NULL now
                  </li>
                ))}
                {typeof figures.extra_rows === 'number' && (
                  <li>
                    {formatNumber(figures.extra_rows)} extra rows sit in NULL-key groups (copies a
                    NULL-safe match would have updated)
                  </li>
                )}
                {figures.table_rows != null && (
                  <li>{formatNumber(figures.table_rows)} rows in the table</li>
                )}
              </ul>
            )}
            {figures?.data === 'skipped' && (
              <p className='m-0 text-[12px] text-muted-foreground'>
                Live counts skipped: {figures.data_note}
              </p>
            )}
            {f.check_key === 'local-time' && figures?.lines && (
              <p className='m-0 text-[12px] text-muted-foreground'>
                {figures.count} calls, on lines {figures.lines.join(', ')}
              </p>
            )}
          </section>

          {f.snippet && (
            <section className='grid gap-1.5'>
              <h3 className='m-0 text-[12.5px] font-semibold'>Statement</h3>
              <pre className='m-0 max-h-[320px] overflow-auto rounded-md border border-slate-200 bg-white p-0 text-[11.5px] leading-[1.55] dark:border-border dark:bg-card'>
                <code className='block min-w-max py-2'>
                  {snippetLines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of source lines, never reordered
                    <span key={i} className='block whitespace-pre pr-3'>
                      <span
                        aria-hidden='true'
                        className='inline-block w-12 select-none pr-3 text-right text-muted-foreground'
                      >
                        {(f.line ?? 1) + i}
                      </span>
                      {l}
                    </span>
                  ))}
                </code>
              </pre>
            </section>
          )}

          {f.suggested_fix && (
            <section className='grid gap-1.5'>
              <div className='flex items-center gap-2'>
                <h3 className='m-0 text-[12.5px] font-semibold'>How to fix it</h3>
                <Button
                  size='sm'
                  variant='ghost'
                  className='ml-auto h-7 px-2 text-[12px] [&_svg]:size-3.5'
                  onClick={() => {
                    void navigator.clipboard?.writeText(f.suggested_fix ?? '').then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    })
                  }}
                >
                  {copied ? <Check aria-hidden='true' /> : <Copy aria-hidden='true' />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className='m-0 whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-3 text-[12.5px] dark:border-border dark:bg-card'>
                {f.suggested_fix}
              </p>
            </section>
          )}

          <section className='grid gap-2'>
            <h3 className='m-0 text-[12.5px] font-semibold'>History</h3>
            <ol className='m-0 grid list-none gap-1.5 border-l border-slate-200 p-0 pl-3 dark:border-border'>
              {f.events.map((e) => (
                <li key={e.id} className='text-[12px]'>
                  <span className='font-medium capitalize'>
                    {e.event === 'accepted'
                      ? 'Marked as expected'
                      : e.event === 'unaccepted'
                        ? 'Reopened by a person'
                        : e.event}
                  </span>
                  <span className='text-muted-foreground'>
                    {' '}
                    · {formatDateTime(e.at)}
                    {e.run_id ? ` · run #${e.run_id}` : ''}
                  </span>
                  {e.note && <div className='text-foreground/80'>“{e.note}”</div>}
                </li>
              ))}
            </ol>
          </section>

          <section
            className='grid gap-2 border-t border-slate-200 pt-3 dark:border-border'
            aria-live='polite'
          >
            {f.status === 'open' &&
              (accepting ? (
                <div className='grid gap-2'>
                  <label htmlFor='sql-check-note' className='text-[12px] font-medium'>
                    Why is this expected?
                  </label>
                  <Textarea
                    id='sql-check-note'
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                    rows={2}
                    className='text-[12.5px]'
                    placeholder='e.g. clears the work table on purpose'
                  />
                  <div className='flex flex-wrap gap-2'>
                    <Button
                      size='sm'
                      className='h-8 bg-nvr-cyan text-[12.5px] text-white hover:bg-nvr-cyan/90'
                      disabled={!note.trim() || patch.isPending}
                      onClick={() => patch.mutate({ status: 'accepted', note: note.trim() })}
                    >
                      Mark as expected
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-8 text-[12.5px]'
                      onClick={() => setAccepting(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-8 w-fit text-[12.5px]'
                  onClick={() => setAccepting(true)}
                >
                  Mark as expected…
                </Button>
              ))}
            {f.status === 'accepted' && (
              <div className='grid gap-2'>
                <p className='m-0 text-[12px] text-muted-foreground'>
                  Marked as expected{f.accepted_at ? ` ${formatRelative(f.accepted_at)}` : ''}: “
                  {f.accepted_note}”
                </p>
                <Button
                  size='sm'
                  variant='outline'
                  className='h-8 w-fit text-[12.5px]'
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ status: 'open' })}
                >
                  Reopen
                </Button>
              </div>
            )}
            {f.status === 'resolved' && (
              <p className='m-0 text-[12px] text-muted-foreground'>
                Not seen in the latest run. It reopens if it comes back.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
