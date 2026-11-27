import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  Download,
  FileText,
  Megaphone,
  Plus,
  Siren,
  Snowflake,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { MonCombobox } from '@/components/filter-combobox'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { AppFilterNote, useAppFilter } from '../app-filter'
import { fetchHubApp, fetchHubApps, hubKeys, hubToast } from '../hub-api'
import {
  countLabel,
  dangerArmed,
  dangerGhost,
  Field,
  ghostButton,
  ListPaneHeader,
  listPaneClass,
  SectionCard,
  segmentButton,
  segmentGroup
} from '../hub-parts'
import {
  ackIncident,
  addNote,
  draftPostMortem,
  fetchIncident,
  fetchIncidents,
  fromNow,
  type IncidentDetail,
  type IncidentRow,
  incidentKeys,
  markdownUrl,
  openIncident,
  type PostMortem,
  pdfUrl,
  resolveIncident,
  SEV_HINT,
  SEV_WORDS,
  type Severity,
  STEP_WORDS,
  savePostMortem,
  setBanner,
  setFreeze,
  type TimelineItem
} from './incident-api'

/**
 * Incidents (Apps hub tab, Hub enhancements 32 + 35): open an incident for an app (freezes its
 * deploys, puts a plain-text banner in the app, pages on-call), follow its timeline, resolve it,
 * then write the post-mortem the Hub drafts from its own records. Owners read their apps;
 * administrators change things. `?incident=<id>` opens one (the page notification links here).
 */
export default function HubIncidents() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const selected = Number(params.get('incident')) || null
  const creating = params.get('new') === '1'
  const [show, setShow] = useState<'open' | 'resolved'>('open')
  const list = useQuery({
    queryKey: incidentKeys.list(),
    queryFn: fetchIncidents,
    refetchInterval: 30_000
  })
  const select = (id: number | null, isNew = false) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        n.delete('incident')
        n.delete('new')
        if (id) n.set('incident', String(id))
        if (isNew) n.set('new', '1')
        return n
      },
      { replace: true }
    )
  // A link to a resolved incident opens the list on Resolved (once per selection).
  const selectedStatus = list.data?.find((r) => r.id === selected)?.status
  useEffect(() => {
    if (selectedStatus) setShow(selectedStatus)
  }, [selectedStatus])
  // `?app=<id>`: one app's incidents (the link on an app's page).
  const { appId, clear } = useAppFilter()
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps, enabled: appId != null })
  const appName =
    appId == null
      ? null
      : (apps.data?.find((a) => a.id === appId)?.name ??
        list.data?.find((r) => r.app_id === appId)?.app_name ??
        null)
  const mine = (list.data ?? []).filter((r) => appId == null || r.app_id === appId)
  const rows = mine.filter((r) => r.status === show)
  const openCount = mine.filter((r) => r.status === 'open').length
  const detailOpen = creating || selected != null
  return (
    <section aria-labelledby='hub-incidents-title' className='flex flex-1 min-h-0 flex-col'>
      <h2 id='hub-incidents-title' className='sr-only'>
        Incidents
      </h2>
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside
          className={cn(listPaneClass, detailOpen ? 'hidden md:flex' : 'flex')}
          aria-label='Incidents'
        >
          <ListPaneHeader
            label={
              list.data
                ? show === 'open'
                  ? countLabel(rows.length, 'open incident', 'open incidents')
                  : countLabel(rows.length, 'resolved incident', 'resolved incidents')
                : 'Incidents'
            }
            actions={
              isAdmin && (
                <button
                  type='button'
                  aria-pressed={creating}
                  className={cn(ghostButton, creating && 'bg-accent')}
                  onClick={() => select(null, true)}
                >
                  <Siren className='h-3.5 w-3.5' aria-hidden /> Open incident
                </button>
              )
            }
          />
          {appId != null && (apps.isSuccess || appName) && (
            <div className='border-b border-slate-200 p-2 dark:border-border'>
              <AppFilterNote name={appName} onClear={clear} />
            </div>
          )}
          <div className='border-b border-slate-200 px-3 py-2 dark:border-border'>
            <fieldset className={cn(segmentGroup, 'flex w-full')}>
              <legend className='sr-only'>Show</legend>
              {(['open', 'resolved'] as const).map((s) => (
                <button
                  key={s}
                  type='button'
                  aria-pressed={show === s}
                  onClick={() => setShow(s)}
                  className={cn(segmentButton(show === s), 'flex-1 justify-center')}
                >
                  {s === 'open' ? `Open${openCount ? ` · ${openCount}` : ''}` : 'Resolved'}
                </button>
              ))}
            </fieldset>
          </div>
          {list.isPending ? (
            <div className='space-y-2 p-3'>
              <Skeleton className='h-12 w-full' />
              <Skeleton className='h-12 w-full' />
            </div>
          ) : list.isError ? (
            <div className='p-3'>
              <QueryErrorState
                error={list.error}
                what='the incidents'
                onRetry={() => void list.refetch()}
              />
            </div>
          ) : rows.length === 0 ? (
            <p className='m-0 px-4 py-6 text-[12px] text-slate-500 dark:text-muted-foreground'>
              {show === 'open'
                ? 'Nothing is on fire. Open incidents show here.'
                : 'No resolved incidents yet.'}
            </p>
          ) : (
            <ul className='m-0 list-none p-0'>
              {rows.map((r) => (
                <li key={r.id}>
                  <IncidentListItem
                    row={r}
                    active={r.id === selected}
                    onClick={() => select(r.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div
          className={cn(
            'relative min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
            !detailOpen && 'hidden md:block'
          )}
        >
          {detailOpen && (
            <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
              <button type='button' className={ghostButton} onClick={() => select(null)}>
                <ArrowLeft className='h-3.5 w-3.5' aria-hidden /> All incidents
              </button>
            </div>
          )}
          {creating && isAdmin ? (
            <OpenIncidentForm
              initialAppId={appId}
              onDone={(id) => select(id)}
              onCancel={() => select(null)}
            />
          ) : selected ? (
            <IncidentPanel id={selected} />
          ) : (
            <div className='flex h-full items-center justify-center p-8'>
              <p className='m-0 max-w-[360px] text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                Pick an incident to follow its timeline.
                {isAdmin &&
                  ' Opening one freezes the app’s deploys, shows a banner in the app and pages whoever is on call.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

const SEV_CHIP: Record<Severity, string> = {
  sev1: 'bg-red-600 text-white dark:bg-red-700 dark:text-white',
  sev2: 'bg-orange-100 text-orange-900 ring-1 ring-inset ring-orange-300 dark:bg-orange-500/15 dark:text-orange-200 dark:ring-orange-400/40',
  sev3: 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300 dark:bg-muted dark:text-slate-200 dark:ring-border'
}

function SevChip({ sev, className }: { sev: Severity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10.5px] font-semibold tabular-nums tracking-wide',
        SEV_CHIP[sev],
        className
      )}
    >
      {SEV_WORDS[sev]}
    </span>
  )
}

function IncidentListItem({
  row,
  active,
  onClick
}: {
  row: IncidentRow
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'block w-full border-b border-slate-100 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:border-border',
        active ? 'bg-accent' : 'hover:bg-muted'
      )}
    >
      <span className='flex items-center gap-2'>
        <SevChip sev={row.severity} />
        <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {row.title}
        </span>
      </span>
      <span className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
        <span className='truncate'>
          {row.app_name ?? `App ${row.app_id}`}
          {row.environment_key ? ` · ${row.environment_key}` : ''}
        </span>
        <span>{formatRelative(row.opened_at)}</span>
        {row.status === 'open' && !row.acknowledged_at && (
          <span className='font-medium text-red-700 dark:text-red-300'>Not acknowledged</span>
        )}
        {row.frozen && (
          <span className='inline-flex items-center gap-0.5'>
            <Snowflake className='h-3 w-3' aria-hidden /> Frozen
          </span>
        )}
      </span>
    </button>
  )
}

// ─── Open an incident ─────────────────────────────────────────────────────────

function OpenIncidentForm({
  onDone,
  onCancel,
  initialAppId
}: {
  onDone: (id: number) => void
  onCancel: () => void
  /** The app the page is narrowed to, picked already. */
  initialAppId?: number | null
}) {
  const qc = useQueryClient()
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const [appId, setAppId] = useState(initialAppId ? String(initialAppId) : '')
  const app = useQuery({
    queryKey: hubKeys.app(Number(appId)),
    queryFn: () => fetchHubApp(Number(appId)),
    enabled: !!appId
  })
  const [envId, setEnvId] = useState('')
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<Severity>('sev2')
  const [summary, setSummary] = useState('')
  const [banner, setBannerText] = useState('')
  const [freeze, setFreezeOn] = useState(true)
  const [page, setPage] = useState(true)
  const go = useMutation({
    mutationFn: () =>
      openIncident(Number(appId), {
        title,
        severity,
        environment_id: envId ? Number(envId) : null,
        summary: summary || null,
        banner_text: banner || null,
        freeze,
        page
      }),
    onSuccess: (inc) => {
      toast.success('Incident opened')
      void qc.invalidateQueries({ queryKey: incidentKeys.list() })
      onDone(inc.id)
    },
    onError: (err) => hubToast(err, 'Could not open the incident')
  })
  const envs = (app.data?.environments ?? []).filter((e) => e.status !== 'archived')
  return (
    <div className='p-4'>
      <SectionCard
        title='Open an incident'
        description='Everything below can be changed while the incident is open.'
      >
        <form
          className='grid gap-4 p-4 md:grid-cols-2'
          onSubmit={(e) => {
            e.preventDefault()
            go.mutate()
          }}
        >
          <Field id='inc-app' label='App'>
            <MonCombobox
              value={appId}
              onChange={(v) => {
                setAppId(v)
                setEnvId('')
              }}
              options={(apps.data ?? []).map((a) => ({
                value: String(a.id),
                label: a.name || a.key
              }))}
              placeholder='Pick the app'
              className='w-full'
            />
          </Field>
          <Field
            id='inc-env'
            label='Environment'
            hint='Leave empty for the whole app (the banner goes to production).'
          >
            <MonCombobox
              value={envId}
              onChange={setEnvId}
              options={envs.map((e) => ({ value: String(e.id), label: e.key }))}
              placeholder={appId ? 'The whole app' : 'Pick the app first'}
              className='w-full'
            />
          </Field>
          <div className='md:col-span-2'>
            <Field id='inc-title' label='What is wrong'>
              <Input
                id='inc-title'
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder='Orders fail to submit to Fusion'
                className='h-8 text-[13px]'
              />
            </Field>
          </div>
          <Field id='inc-sev' label='Severity'>
            <SimpleSelect
              value={severity}
              onChange={(v) => setSeverity(v as Severity)}
              ariaLabel='Severity'
              className='h-8 text-[13px]'
              options={(['sev1', 'sev2', 'sev3'] as const).map((s) => ({
                value: s,
                label: `${SEV_WORDS[s]} — ${SEV_HINT[s]}`
              }))}
            />
          </Field>
          <div className='space-y-2 self-end pb-1'>
            <label
              htmlFor='inc-freeze'
              className='flex items-center gap-2 text-[12.5px] text-slate-700 dark:text-foreground'
            >
              <Switch id='inc-freeze' checked={freeze} onCheckedChange={setFreezeOn} />
              Freeze deploys for this app (rollbacks still allowed)
            </label>
            <label
              htmlFor='inc-page'
              className='flex items-center gap-2 text-[12.5px] text-slate-700 dark:text-foreground'
            >
              <Switch id='inc-page' checked={page} onCheckedChange={setPage} />
              Page whoever is on call
            </label>
          </div>
          <div className='md:col-span-2'>
            <BannerInput value={banner} onChange={setBannerText} />
          </div>
          <div className='md:col-span-2'>
            <Field
              id='inc-summary'
              label='Internal summary'
              hint='For the Hub only; never shown in the app or on a status page.'
            >
              <Textarea
                id='inc-summary'
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                className='text-[13px]'
              />
            </Field>
          </div>
          <div className='flex flex-wrap gap-2 md:col-span-2'>
            <Button
              type='submit'
              size='sm'
              className='h-8 gap-1.5'
              disabled={!appId || !title.trim() || go.isPending}
            >
              <Siren className='h-3.5 w-3.5' aria-hidden />
              {go.isPending ? 'Opening…' : 'Open incident'}
            </Button>
            <button type='button' className={ghostButton} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </SectionCard>
    </div>
  )
}

const BANNER_MAX = 280

function BannerInput({
  value,
  onChange,
  id = 'inc-banner',
  label = 'Banner in the app'
}: {
  value: string
  onChange: (v: string) => void
  id?: string
  label?: string
}) {
  const left = BANNER_MAX - value.length
  return (
    <Field
      id={id}
      label={label}
      hint={
        <>
          Plain text every signed-in person of the app sees, and the line a status page shows. Keep
          it to what users need to know. <span className='tabular-nums'>{left} left</span>
        </>
      }
    >
      <Input
        id={id}
        value={value}
        maxLength={BANNER_MAX}
        onChange={(e) => onChange(e.target.value.replace(/[<>]/g, ''))}
        placeholder='e.g. Orders are delayed. We are on it; nothing you entered is lost.'
        className='h-8 text-[13px]'
      />
    </Field>
  )
}

// ─── One incident ─────────────────────────────────────────────────────────────

function useIncident(id: number) {
  return useQuery({
    queryKey: incidentKeys.one(id),
    queryFn: () => fetchIncident(id),
    refetchInterval: (q) => (q.state.data?.status === 'open' ? 15_000 : false)
  })
}

function IncidentPanel({ id }: { id: number }) {
  const q = useIncident(id)
  if (q.isPending) return <Skeleton className='m-4 h-64' />
  if (q.isError)
    return (
      <div className='p-4'>
        <QueryErrorState error={q.error} what='the incident' onRetry={() => void q.refetch()} />
      </div>
    )
  return <IncidentBody inc={q.data} />
}

function useInvalidate(id: number) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: incidentKeys.one(id) })
    void qc.invalidateQueries({ queryKey: incidentKeys.list() })
  }
}

function IncidentBody({ inc }: { inc: IncidentDetail }) {
  const refresh = useInvalidate(inc.id)
  const open = inc.status === 'open'
  const [note, setNote] = useState('')
  const act = useMutation({
    mutationFn: async (
      a: { kind: 'ack' } | { kind: 'freeze'; on: boolean } | { kind: 'resolve'; note: string }
    ) => {
      if (a.kind === 'ack') return ackIncident(inc.id)
      if (a.kind === 'freeze') return setFreeze(inc.id, a.on)
      return resolveIncident(inc.id, a.note)
    },
    onSuccess: (_d, a) => {
      toast.success(
        a.kind === 'ack'
          ? 'Acknowledged'
          : a.kind === 'freeze'
            ? a.on
              ? 'Deploys frozen'
              : 'Freeze lifted'
            : 'Incident resolved'
      )
      refresh()
    },
    onError: (err) => hubToast(err, 'That did not go through')
  })
  return (
    <div className='space-y-4 p-4'>
      <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-start gap-3'>
          <div className='min-w-0 flex-[1_1_320px]'>
            <h3 className='m-0 flex items-start gap-2 text-[16px] font-semibold leading-snug text-slate-900 [text-wrap:balance] dark:text-foreground'>
              <SevChip sev={inc.severity} className='mt-[3px]' />
              <span className='min-w-0'>{inc.title}</span>
            </h3>
            <p className='m-0 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
              <span
                className={cn(
                  'font-semibold',
                  open ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'
                )}
              >
                {open ? 'Open' : 'Resolved'}
              </span>
              <span aria-hidden>·</span>
              <span className='font-medium text-slate-700 dark:text-slate-200'>
                {inc.app_name ?? `App ${inc.app_id}`}
              </span>
              {inc.environment_key && (
                <>
                  <span aria-hidden>·</span>
                  <span>{inc.environment_key}</span>
                  <HubEnvTag envKey={inc.environment_key} />
                </>
              )}
              <span aria-hidden>·</span>
              <span>
                opened {formatRelative(inc.opened_at)}
                {inc.opened_by_name ? ` by ${inc.opened_by_name}` : ''}
              </span>
              {inc.resolved_at && (
                <>
                  <span aria-hidden>·</span>
                  <span>resolved {formatRelative(inc.resolved_at)}</span>
                </>
              )}
            </p>
          </div>
          {open && (
            <div className='flex flex-wrap items-center gap-2'>
              {!inc.acknowledged_at && (
                <Button
                  size='sm'
                  className='h-8 gap-1.5'
                  onClick={() => act.mutate({ kind: 'ack' })}
                  disabled={act.isPending}
                >
                  <BellRing className='h-3.5 w-3.5' aria-hidden /> Acknowledge
                </Button>
              )}
              {inc.can_write &&
                (inc.frozen ? (
                  <ConfirmButton
                    className={ghostButton}
                    armedClassName={dangerArmed}
                    confirmLabel='Let deploys through?'
                    onConfirm={() => act.mutate({ kind: 'freeze', on: false })}
                  >
                    <Snowflake className='h-3.5 w-3.5' aria-hidden /> Lift freeze
                  </ConfirmButton>
                ) : (
                  <button
                    type='button'
                    className={ghostButton}
                    onClick={() => act.mutate({ kind: 'freeze', on: true })}
                  >
                    <Snowflake className='h-3.5 w-3.5' aria-hidden /> Freeze deploys
                  </button>
                ))}
            </div>
          )}
        </div>
        <dl className='mt-3 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-[12px] sm:grid-cols-3 dark:border-border dark:bg-border'>
          <Meta label='Deploys'>
            {inc.frozen
              ? 'Frozen (rollbacks allowed)'
              : open && inc.freeze_id
                ? 'Freeze lifted'
                : open
                  ? 'Not frozen'
                  : 'Not frozen'}
          </Meta>
          <Meta label='Acknowledged'>
            {inc.acknowledged_at
              ? `${inc.acknowledged_by_name ?? 'Someone'}, ${formatRelative(inc.acknowledged_at)}`
              : open
                ? 'Not yet'
                : '—'}
          </Meta>
          <Meta label='Paging'>
            <PagingLine inc={inc} />
          </Meta>
        </dl>
      </section>

      {open && inc.can_write && <BannerCard inc={inc} onDone={refresh} />}
      {open && inc.can_write && (
        <ResolveCard
          onResolve={(n) => act.mutate({ kind: 'resolve', note: n })}
          busy={act.isPending}
        />
      )}

      <SectionCard
        title='Timeline'
        description='Everything the Hub did for this incident, and the notes people added.'
      >
        {inc.can_write && open && (
          <form
            className='flex flex-wrap gap-2 border-b border-slate-100 p-3 dark:border-border'
            onSubmit={(e) => {
              e.preventDefault()
              if (!note.trim()) return
              addNote(inc.id, note.trim()).then(
                () => {
                  setNote('')
                  refresh()
                },
                (err) => hubToast(err, 'Could not add the note')
              )
            }}
          >
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              placeholder='Add a note: what you checked, what you changed'
              aria-label='Note'
              className='h-8 min-w-[200px] flex-1 text-[13px]'
            />
            <Button
              type='submit'
              size='sm'
              variant='outline'
              className='h-8'
              disabled={!note.trim()}
            >
              Add note
            </Button>
          </form>
        )}
        <ol className='m-0 list-none p-0'>
          {[...inc.events].reverse().map((e) => (
            <li
              key={e.id}
              className='grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-b border-slate-100 px-4 py-2 last:border-0 dark:border-border'
            >
              <time
                dateTime={e.at}
                className='text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'
                data-tip={formatDateTime(e.at)}
              >
                {new Date(e.at).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit'
                })}
                <span className='block'>
                  {new Date(e.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </time>
              <p className='m-0 text-[12.5px] text-slate-800 dark:text-foreground'>
                <span className='font-medium'>{EVENT_WORDS[e.kind] ?? e.kind}</span>
                {e.text ? (
                  <span className='text-slate-600 dark:text-slate-300'> — {e.text}</span>
                ) : null}
                {e.user_name && (
                  <span className='text-slate-500 dark:text-muted-foreground'>
                    {' '}
                    · {e.user_name}
                  </span>
                )}
              </p>
            </li>
          ))}
        </ol>
      </SectionCard>

      <PostMortemCard inc={inc} />
    </div>
  )
}

const EVENT_WORDS: Record<string, string> = {
  opened: 'Opened',
  note: 'Note',
  changed: 'Changed',
  banner: 'Banner',
  freeze: 'Freeze',
  page: 'Paged',
  escalated: 'Escalated',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  postmortem: 'Post-mortem'
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd className='m-0 mt-0.5 text-slate-800 dark:text-foreground'>{children}</dd>
    </div>
  )
}

function PagingLine({ inc }: { inc: IncidentDetail }) {
  const p = inc.page
  if (!p) return <>No on-call rota (owners and administrators were told)</>
  const last = p.sent_to.at(-1)
  return (
    <span>
      {last ? `${STEP_WORDS[last.step]}: ${last.names.join(', ')}` : 'Nobody reached'}
      {p.status === 'open' && p.next_at && (
        <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
          Escalates {fromNow(p.next_at)} unless acknowledged
        </span>
      )}
    </span>
  )
}

const BANNER_STATE: Record<string, string> = {
  shown: 'Showing',
  cleared: 'Removed',
  no_link: 'No hub link',
  too_old: 'App too old (0.3.215+)',
  refused: 'Link refused',
  unreachable: 'Not answering — retrying',
  failed: 'Failed — retrying'
}

function BannerCard({ inc, onDone }: { inc: IncidentDetail; onDone: () => void }) {
  const [text, setText] = useState(inc.banner_text ?? '')
  useEffect(() => setText(inc.banner_text ?? ''), [inc.banner_text])
  const save = useMutation({
    mutationFn: (t: string | null) => setBanner(inc.id, t),
    onSuccess: (_d, t) => {
      toast.success(t ? 'Banner sent to the app' : 'Banner removed')
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not change the banner')
  })
  const changed = text.trim() !== (inc.banner_text ?? '')
  return (
    <SectionCard
      title='Banner in the app'
      description='Shown to everyone signed in, until the incident is resolved. The Hub refreshes it every 30 minutes.'
    >
      <div className='space-y-3 p-4'>
        <BannerInput id={`banner-${inc.id}`} label='Text' value={text} onChange={setText} />
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            className='h-8 gap-1.5'
            disabled={!text.trim() || !changed || save.isPending}
            onClick={() => save.mutate(text.trim())}
          >
            <Megaphone className='h-3.5 w-3.5' aria-hidden />
            {inc.banner_text ? 'Update banner' : 'Show banner'}
          </Button>
          {inc.banner_text && (
            <button
              type='button'
              className={dangerGhost}
              onClick={() => save.mutate(null)}
              disabled={save.isPending}
            >
              <Trash2 className='h-3.5 w-3.5' aria-hidden /> Remove
            </button>
          )}
        </div>
        {inc.banner_envs.length > 0 && (
          <ul className='m-0 flex list-none flex-wrap gap-2 p-0 text-[11.5px]'>
            {inc.banner_envs.map((b) => (
              <li
                key={b.environment_id}
                className={cn(
                  'rounded-md px-2 py-1 ring-1 ring-inset',
                  b.state === 'shown'
                    ? 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/30'
                    : b.state === 'cleared'
                      ? 'bg-slate-50 text-slate-700 ring-slate-200 dark:bg-muted dark:text-slate-200 dark:ring-border'
                      : 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/30'
                )}
              >
                <span className='font-medium'>{b.environment_key ?? `#${b.environment_id}`}</span>:{' '}
                {BANNER_STATE[b.state] ?? b.state}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  )
}

function ResolveCard({ onResolve, busy }: { onResolve: (note: string) => void; busy: boolean }) {
  const [note, setNote] = useState('')
  return (
    <SectionCard
      title='Resolve'
      description='Lifts the deploy freeze, removes the banner, stops the paging and tells whoever was paged.'
    >
      <div className='flex flex-wrap items-center gap-2 p-4'>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          placeholder='What fixed it (goes on the timeline)'
          aria-label='What fixed it'
          className='h-8 min-w-[220px] flex-1 text-[13px]'
        />
        <ConfirmButton
          className={cn(ghostButton, 'text-emerald-700 dark:text-emerald-300')}
          armedClassName='bg-emerald-600 text-white hover:bg-emerald-700'
          confirmLabel='Resolve now?'
          disabled={busy}
          onConfirm={() => onResolve(note)}
        >
          <CheckCircle2 className='h-3.5 w-3.5' aria-hidden /> Resolve incident
        </ConfirmButton>
      </div>
    </SectionCard>
  )
}

// ─── Post-mortem ──────────────────────────────────────────────────────────────

const KIND_WORDS: Record<TimelineItem['kind'], string> = {
  incident: 'Incident',
  deploy: 'Deploy',
  move: 'Move',
  alert: 'Alert',
  page: 'Page',
  error: 'Error',
  uptime: 'Uptime',
  note: 'Note'
}

function PostMortemCard({ inc }: { inc: IncidentDetail }) {
  const refresh = useInvalidate(inc.id)
  const [doc, setDoc] = useState<PostMortem | null>(inc.postmortem)
  useEffect(() => setDoc(inc.postmortem), [inc.postmortem])
  const draft = useMutation({
    mutationFn: (replace: boolean) => draftPostMortem(inc.id, replace),
    onSuccess: (d) => {
      setDoc(d)
      toast.success(`Drafted ${d.timeline.length} timeline entries`)
      refresh()
    },
    onError: (err) => hubToast(err, 'Could not draft the post-mortem')
  })
  const save = useMutation({
    mutationFn: (d: PostMortem) => savePostMortem(inc.id, d),
    onSuccess: () => {
      toast.success('Post-mortem saved')
      refresh()
    },
    onError: (err) => hubToast(err, 'Could not save the post-mortem')
  })
  const dirty = useMemo(
    () => JSON.stringify(doc) !== JSON.stringify(inc.postmortem),
    [doc, inc.postmortem]
  )
  const set = (patch: Partial<PostMortem>) => setDoc((d) => (d ? { ...d, ...patch } : d))
  const write = inc.can_write
  return (
    <SectionCard
      title='Post-mortem'
      description={
        doc
          ? `Drafted from the Hub’s records${inc.postmortem_by_name ? `, last saved by ${inc.postmortem_by_name}` : ''}. Times on exports are UTC.`
          : 'The Hub drafts a timeline from deploys, alerts, errors, moves, pages and uptime in the window, then you write the rest.'
      }
      actions={
        <>
          {doc && (
            <>
              <a href={markdownUrl(inc.id)} className={ghostButton} download>
                <Download className='h-3.5 w-3.5' aria-hidden /> Markdown
              </a>
              <a href={pdfUrl(inc.id)} className={ghostButton} download>
                <FileText className='h-3.5 w-3.5' aria-hidden /> PDF
              </a>
            </>
          )}
          {write && !doc && (
            <Button
              size='sm'
              variant='outline'
              className='h-8 gap-1.5'
              onClick={() => draft.mutate(false)}
              disabled={draft.isPending}
            >
              <FileText className='h-3.5 w-3.5' aria-hidden />{' '}
              {draft.isPending ? 'Drafting…' : 'Draft post-mortem'}
            </Button>
          )}
        </>
      }
    >
      {!doc ? null : (
        <div className='space-y-4 p-4'>
          <Field id='pm-title' label='Title'>
            <Input
              id='pm-title'
              value={doc.title}
              onChange={(e) => set({ title: e.target.value })}
              readOnly={!write}
              className='h-8 text-[13px]'
            />
          </Field>
          {(
            [
              ['summary', 'Summary', 'What happened, in two or three sentences.'],
              ['impact', 'Impact', 'Who was affected, for how long, what they could not do.'],
              ['root_cause', 'Root cause', 'Why it happened, and why it was not caught sooner.']
            ] as const
          ).map(([k, label, hint]) => (
            <Field key={k} id={`pm-${k}`} label={label} hint={hint}>
              <Textarea
                id={`pm-${k}`}
                value={doc[k]}
                rows={3}
                readOnly={!write}
                onChange={(e) => set({ [k]: e.target.value } as Partial<PostMortem>)}
                className='text-[13px]'
              />
            </Field>
          ))}
          <div>
            <h4 className='m-0 mb-2 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
              Follow-up actions
            </h4>
            <ul className='m-0 list-none space-y-1.5 p-0'>
              {doc.actions.map((a, i) => (
                <li key={i} className='flex flex-wrap items-center gap-2'>
                  <Checkbox
                    checked={a.done}
                    disabled={!write}
                    aria-label={`Done: ${a.text || 'action'}`}
                    onCheckedChange={(v) =>
                      set({
                        actions: doc.actions.map((x, j) =>
                          j === i ? { ...x, done: v === true } : x
                        )
                      })
                    }
                  />
                  <Input
                    value={a.text}
                    readOnly={!write}
                    aria-label='Action'
                    onChange={(e) =>
                      set({
                        actions: doc.actions.map((x, j) =>
                          j === i ? { ...x, text: e.target.value } : x
                        )
                      })
                    }
                    className='h-8 min-w-[200px] flex-[3_1_240px] text-[13px]'
                  />
                  <Input
                    value={a.owner ?? ''}
                    readOnly={!write}
                    aria-label='Owner'
                    placeholder='Owner'
                    onChange={(e) =>
                      set({
                        actions: doc.actions.map((x, j) =>
                          j === i ? { ...x, owner: e.target.value || null } : x
                        )
                      })
                    }
                    className='h-8 min-w-[120px] flex-[1_1_120px] text-[13px]'
                  />
                  {write && (
                    <button
                      type='button'
                      className={dangerGhost}
                      aria-label='Remove action'
                      onClick={() => set({ actions: doc.actions.filter((_, j) => j !== i) })}
                    >
                      <Trash2 className='h-3.5 w-3.5' aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {write && (
              <button
                type='button'
                className={cn(ghostButton, 'mt-1.5')}
                onClick={() =>
                  set({ actions: [...doc.actions, { text: '', owner: null, done: false }] })
                }
              >
                <Plus className='h-3.5 w-3.5' aria-hidden /> Add action
              </button>
            )}
          </div>
          <div>
            <h4 className='m-0 mb-2 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
              Timeline{' '}
              <span className='font-normal text-slate-500 dark:text-muted-foreground'>
                ({doc.timeline.length})
              </span>
            </h4>
            <ol className='m-0 list-none divide-y divide-slate-100 rounded-md border border-slate-200 p-0 dark:divide-border dark:border-border'>
              {doc.timeline.map((t, i) => (
                <li key={`${t.at}-${i}`} className='flex flex-wrap items-start gap-2 px-3 py-1.5'>
                  <time
                    dateTime={t.at}
                    className='w-[150px] shrink-0 pt-1.5 text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'
                  >
                    {formatDateTime(t.at)}
                  </time>
                  <span className='w-[64px] shrink-0 pt-1.5 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
                    {KIND_WORDS[t.kind]}
                  </span>
                  {write ? (
                    <Input
                      value={t.text}
                      aria-label='Timeline entry'
                      onChange={(e) =>
                        set({
                          timeline: doc.timeline.map((x, j) =>
                            j === i ? { ...x, text: e.target.value } : x
                          )
                        })
                      }
                      className='h-8 min-w-[200px] flex-1 text-[12.5px]'
                    />
                  ) : (
                    <span className='min-w-0 flex-1 pt-1 text-[12.5px] text-slate-800 dark:text-foreground'>
                      {t.text}
                    </span>
                  )}
                  {write && (
                    <button
                      type='button'
                      className={dangerGhost}
                      aria-label='Remove entry'
                      onClick={() => set({ timeline: doc.timeline.filter((_, j) => j !== i) })}
                    >
                      <Trash2 className='h-3.5 w-3.5' aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {write && (
              <button
                type='button'
                className={cn(ghostButton, 'mt-1.5')}
                onClick={() =>
                  set({
                    timeline: [
                      ...doc.timeline,
                      { at: new Date().toISOString(), kind: 'note', text: '' }
                    ]
                  })
                }
              >
                <Plus className='h-3.5 w-3.5' aria-hidden /> Add entry
              </button>
            )}
          </div>
          {write && (
            <div className='flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-border'>
              <Button
                size='sm'
                className='h-8'
                disabled={!dirty || save.isPending}
                onClick={() =>
                  doc &&
                  save.mutate({
                    ...doc,
                    timeline: doc.timeline.filter((t) => t.text.trim()),
                    actions: doc.actions.filter((a) => a.text.trim())
                  })
                }
              >
                {save.isPending ? 'Saving…' : 'Save post-mortem'}
              </Button>
              <ConfirmButton
                className={ghostButton}
                armedClassName={dangerArmed}
                confirmLabel='Replace with a fresh draft?'
                onConfirm={() => draft.mutate(true)}
              >
                Draft again
              </ConfirmButton>
              {dirty && (
                <span className='text-[11.5px] text-amber-800 dark:text-amber-300'>
                  Unsaved changes
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}
