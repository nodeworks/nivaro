import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Globe, Lock, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { MonCombobox } from '@/components/filter-combobox'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { fetchHubApps, hubKeys, hubToast } from '../hub-api'
import { CopyButton, dangerArmed, dangerGhost, Field, ghostButton, SectionCard } from '../hub-parts'
import {
  createStatusPage,
  deleteStatusPage,
  fetchStatusPages,
  fetchStatusView,
  fromNow,
  incidentKeys,
  rotateStatusPage,
  STATE_TONE,
  type StatusAnswer,
  type StatusPageRow,
  statusPageUrl
} from './incident-api'

/**
 * Status pages (Apps hub tab, Hub enhancement 34): each app's health and planned maintenance for
 * people outside the Hub — a public link with a token (shown once; only its hash is kept; it
 * expires), or an internal page every signed-in person opens here. Neither shows hostnames,
 * versions or error text. Administrators make and replace links; the preview is what readers see.
 */
export default function HubStatusPages() {
  const q = useQuery({ queryKey: incidentKeys.statusPages(), queryFn: fetchStatusPages })
  const [selected, setSelected] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [fresh, setFresh] = useState<{ id: number; token: string } | null>(null)
  const pages = q.data?.data ?? []
  const canWrite = !!q.data?.can_write
  useEffect(() => {
    if (selected == null && pages.length) setSelected(pages[0].id)
  }, [pages, selected])
  const current = pages.find((p) => p.id === selected) ?? null
  return (
    <section aria-labelledby='hub-status-title' className='flex flex-1 min-h-0 flex-col'>
      <h2 id='hub-status-title' className='sr-only'>
        Status pages
      </h2>
      <HubToolbar
        description='Each app’s health and planned maintenance for people outside the Hub: a public link with a token, or an internal page for signed-in people. Neither shows hostnames, versions or error text.'
        actions={
          canWrite &&
          !creating && (
            <button type='button' className={ghostButton} onClick={() => setCreating(true)}>
              <Plus className='h-3.5 w-3.5' aria-hidden /> New status page
            </button>
          )
        }
      />
      <div className='relative flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {q.isPending ? (
          <Skeleton className='h-40 w-full' />
        ) : q.isError ? (
          <QueryErrorState
            error={q.error}
            what='the status pages'
            onRetry={() => void q.refetch()}
          />
        ) : (
          <div className='space-y-4'>
            {creating && (
              <CreateForm
                onDone={(made) => {
                  setCreating(false)
                  if (made) {
                    setSelected(made.id)
                    if (made.token) setFresh({ id: made.id, token: made.token })
                  }
                }}
              />
            )}
            {fresh && <TokenOnce token={fresh.token} onClose={() => setFresh(null)} />}
            {pages.length === 0 && !creating ? (
              <SectionCard title='No status pages yet'>
                <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {canWrite
                    ? 'Make a public link for customers, or an internal page for everyone at the company.'
                    : 'Nobody has made an internal status page yet.'}
                </p>
              </SectionCard>
            ) : (
              <div className='grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]'>
                <ul className='m-0 list-none space-y-2 p-0' aria-label='Status pages'>
                  {pages.map((p) => (
                    <li key={p.id}>
                      <PageCard
                        page={p}
                        active={p.id === selected}
                        onSelect={() => setSelected(p.id)}
                        canWrite={canWrite}
                        onToken={(token) => setFresh({ id: p.id, token })}
                      />
                    </li>
                  ))}
                </ul>
                {current && <Preview page={current} />}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: incidentKeys.statusPages() })
}

function CreateForm({
  onDone
}: {
  onDone: (made: { id: number; token: string | null } | null) => void
}) {
  const refresh = useRefresh()
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const [name, setName] = useState('')
  const [audience, setAudience] = useState<'public' | 'internal'>('public')
  const [days, setDays] = useState('90')
  const [picked, setPicked] = useState<number[]>([])
  const [pick, setPick] = useState('')
  const save = useMutation({
    mutationFn: () =>
      createStatusPage({
        name,
        audience,
        app_ids: picked.length ? picked : null,
        expires_in_days: Number(days)
      }),
    onSuccess: (p) => {
      refresh()
      toast.success('Status page made')
      onDone({ id: p.id, token: p.token })
    },
    onError: (err) => hubToast(err, 'Could not make the status page')
  })
  const appName = (id: number) => {
    const a = apps.data?.find((x) => x.id === id)
    return a ? a.name || a.key : `App ${id}`
  }
  return (
    <SectionCard
      title='New status page'
      description='It shows each app’s health from the Hub’s probes and the planned maintenance — never addresses, versions or errors.'
    >
      <form
        className='grid gap-4 p-4 md:grid-cols-3'
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <Field id='sp-name' label='Title on the page'>
          <Input
            id='sp-name'
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder='Acme service status'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id='sp-aud' label='Who can open it'>
          <SimpleSelect
            value={audience}
            onChange={(v) => setAudience(v as 'public' | 'internal')}
            ariaLabel='Who can open it'
            className='h-8 text-[13px]'
            options={[
              { value: 'public', label: 'Anyone with the link' },
              { value: 'internal', label: 'People signed in to the Hub' }
            ]}
          />
        </Field>
        {audience === 'public' ? (
          <Field
            id='sp-days'
            label='Link works for (days)'
            hint='1 to 366. Replace the link to extend it.'
          >
            <Input
              id='sp-days'
              type='number'
              min={1}
              max={366}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className='h-8 text-[13px] tabular-nums'
            />
          </Field>
        ) : (
          <div />
        )}
        <div className='md:col-span-3'>
          <Field
            id='sp-apps'
            label='Apps on the page'
            hint='None picked = every app the Hub looks after.'
          >
            <div className='flex flex-wrap items-center gap-2'>
              {picked.map((id) => (
                <span
                  key={id}
                  className='inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[12px] dark:bg-muted'
                >
                  {appName(id)}
                  <button
                    type='button'
                    className='rounded text-slate-500 hover:text-slate-900 dark:hover:text-foreground'
                    aria-label={`Remove ${appName(id)}`}
                    onClick={() => setPicked(picked.filter((x) => x !== id))}
                  >
                    <X className='h-3 w-3' aria-hidden />
                  </button>
                </span>
              ))}
              <MonCombobox
                value={pick}
                onChange={(v) => {
                  if (v) setPicked([...new Set([...picked, Number(v)])])
                  setPick('')
                }}
                options={(apps.data ?? [])
                  .filter((a) => !picked.includes(a.id))
                  .map((a) => ({ value: String(a.id), label: a.name || a.key }))}
                placeholder='Add an app'
                className='w-[220px]'
              />
            </div>
          </Field>
        </div>
        <div className='flex gap-2 md:col-span-3'>
          <Button type='submit' size='sm' className='h-8' disabled={!name.trim() || save.isPending}>
            Make status page
          </Button>
          <button type='button' className={ghostButton} onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </SectionCard>
  )
}

function TokenOnce({ token, onClose }: { token: string; onClose: () => void }) {
  const url = statusPageUrl(token)
  return (
    <section
      role='status'
      className='rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-400/40 dark:bg-amber-400/10'
    >
      <h3 className='m-0 text-[13px] font-semibold text-amber-950 dark:text-amber-100'>
        Copy the link now
      </h3>
      <p className='m-0 mt-1 text-[12px] text-amber-900 dark:text-amber-200'>
        The Hub keeps only a fingerprint of it, so this is the one time it can be shown. Lost it?
        Replace the link.
      </p>
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <code className='min-w-0 max-w-full flex-1 overflow-x-auto whitespace-nowrap rounded border border-amber-200 bg-white px-2 py-1.5 font-mono text-[11.5px] text-slate-900 dark:border-amber-400/30 dark:bg-card dark:text-foreground'>
          {url}
        </code>
        <CopyButton value={url} label='Copy the link' />
        <a href={url} target='_blank' rel='noreferrer' className={ghostButton}>
          <ExternalLink className='h-3.5 w-3.5' aria-hidden /> Open
        </a>
        <button type='button' className={ghostButton} onClick={onClose}>
          Done
        </button>
      </div>
    </section>
  )
}

function PageCard({
  page,
  active,
  onSelect,
  canWrite,
  onToken
}: {
  page: StatusPageRow
  active: boolean
  onSelect: () => void
  canWrite: boolean
  onToken: (token: string) => void
}) {
  const refresh = useRefresh()
  const rotate = useMutation({
    mutationFn: () => rotateStatusPage(page.id, 90),
    onSuccess: (p) => {
      refresh()
      onToken(p.token)
    },
    onError: (err) => hubToast(err, 'Could not replace the link')
  })
  const del = useMutation({
    mutationFn: () => deleteStatusPage(page.id),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not delete the status page')
  })
  const Icon = page.audience === 'public' ? Globe : Lock
  return (
    <div
      className={cn(
        'rounded-lg border bg-white dark:bg-card',
        active
          ? 'border-slate-300 ring-1 ring-slate-300 dark:border-slate-500 dark:ring-slate-500'
          : 'border-slate-200 dark:border-border'
      )}
    >
      <button
        type='button'
        onClick={onSelect}
        aria-pressed={active}
        className='block w-full rounded-lg px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
      >
        <span className='flex items-center gap-2'>
          <Icon className='h-3.5 w-3.5 shrink-0 text-slate-500' aria-hidden />
          <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            {page.name}
          </span>
          {!page.live && (
            <span className='text-[11px] font-medium text-red-700 dark:text-red-300'>Expired</span>
          )}
        </span>
        <span className='mt-1 block text-[11px] text-slate-500 dark:text-muted-foreground'>
          {page.audience === 'public'
            ? `Public link …${page.token_hint ?? ''}${page.expires_at ? (page.live ? ` · expires ${fromNow(page.expires_at)}` : ` · expired ${formatRelative(page.expires_at)}`) : ''}`
            : 'Internal · signed-in people'}
          {page.last_viewed_at && ` · opened ${formatRelative(page.last_viewed_at)}`}
        </span>
      </button>
      {canWrite && (
        <div className='flex flex-wrap gap-1 border-t border-slate-100 px-2 py-1.5 dark:border-border'>
          {page.audience === 'public' && (
            <ConfirmButton
              className={ghostButton}
              armedClassName={dangerArmed}
              confirmLabel='The old link stops working. Replace?'
              onConfirm={() => rotate.mutate()}
            >
              <RefreshCw className='h-3.5 w-3.5' aria-hidden /> Replace link
            </ConfirmButton>
          )}
          <ConfirmButton
            className={dangerGhost}
            armedClassName={dangerArmed}
            confirmLabel='Delete the page?'
            onConfirm={() => del.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
          </ConfirmButton>
        </div>
      )}
    </div>
  )
}

/** State dot that never rides on colour alone: down is a diamond, unknown a hollow ring. */
function StateDot({ state, size = 10 }: { state: keyof typeof STATE_TONE; size?: number }) {
  const t = STATE_TONE[state]
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block shrink-0',
        t === 'ok' && 'rounded-full bg-emerald-500',
        t === 'warn' && 'rounded-full bg-amber-500',
        t === 'down' && 'rotate-45 rounded-[2px] bg-red-600 dark:bg-red-500',
        t === 'unknown' && 'rounded-full border-2 border-slate-400 dark:border-slate-500'
      )}
      style={{ width: size, height: size }}
    />
  )
}

function Preview({ page }: { page: StatusPageRow }) {
  const q = useQuery({
    queryKey: incidentKeys.statusView(page.id),
    queryFn: () => fetchStatusView(page.id),
    refetchInterval: 60_000
  })
  return (
    <SectionCard
      title={`What readers see${page.audience === 'public' ? ' on the public link' : ''}`}
      description='Refreshes every minute. Times in your zone here; the public page shows UTC.'
    >
      {q.isPending ? (
        <Skeleton className='m-4 h-40' />
      ) : q.isError ? (
        <div className='p-4'>
          <QueryErrorState
            error={q.error}
            what='the status page'
            onRetry={() => void q.refetch()}
          />
        </div>
      ) : (
        <StatusView a={q.data} />
      )}
    </SectionCard>
  )
}

function StatusView({ a }: { a: StatusAnswer }) {
  return (
    <div className='space-y-4 p-4'>
      <div className='flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-border dark:bg-muted/30'>
        <StateDot state={a.overall} size={12} />
        <span className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
          {a.overall_word}
        </span>
      </div>
      <ul className='m-0 list-none divide-y divide-slate-100 rounded-lg border border-slate-200 p-0 dark:divide-border dark:border-border'>
        {a.apps.map((x) => (
          <li key={x.name} className='space-y-2 px-3 py-3'>
            <div className='flex items-center gap-2'>
              <StateDot state={x.state} />
              <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                {x.name}
              </span>
              <span className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>
                {x.state_word}
              </span>
            </div>
            {x.incident && (
              <p
                className={cn(
                  'm-0 rounded-md px-2.5 py-1.5 text-[12px]',
                  STATE_TONE[x.incident.state] === 'warn'
                    ? 'bg-amber-50 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100'
                    : 'bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-100'
                )}
              >
                {x.incident.text}{' '}
                <span className='whitespace-nowrap opacity-80'>
                  · since {formatDateTime(x.incident.since)}
                </span>
              </p>
            )}
            <div
              className='flex h-6 gap-[2px]'
              role='img'
              aria-label={`${x.name}: daily uptime, last ${x.days.length} days`}
            >
              {x.days.map((d) => (
                <span
                  key={d.date}
                  data-tip={`${d.date}: ${d.uptime == null ? 'no data' : `${d.uptime.toFixed(2)}% up`}`}
                  className={cn(
                    'min-w-[3px] flex-1 rounded-[2px]',
                    d.uptime == null
                      ? 'bg-slate-200 dark:bg-slate-700'
                      : d.uptime >= 99.9
                        ? 'bg-emerald-500'
                        : d.uptime >= 99
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                  )}
                />
              ))}
            </div>
            <div className='flex justify-between text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
              <span>{x.days.length} days ago</span>
              <span>{x.uptime_30d == null ? 'No data' : `${x.uptime_30d.toFixed(2)}% uptime`}</span>
              <span>Today</span>
            </div>
          </li>
        ))}
      </ul>
      <div>
        <h4 className='m-0 mb-1.5 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
          Planned maintenance
        </h4>
        {a.planned.length === 0 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Nothing planned in the next two weeks.
          </p>
        ) : (
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 text-[12px] dark:divide-border'>
            {a.planned.map((p, i) => (
              <li key={`${p.starts_at}-${i}`} className='flex flex-wrap gap-x-4 gap-y-0.5 py-1.5'>
                <span className='w-[260px] shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {formatDateTime(p.starts_at)}
                  {p.ends_at ? ` – ${formatDateTime(p.ends_at)}` : ''}
                </span>
                <span className='text-slate-800 dark:text-foreground'>
                  {p.app ?? 'All apps'}: {p.title}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
