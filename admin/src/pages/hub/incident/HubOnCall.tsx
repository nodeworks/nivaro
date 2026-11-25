import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  BellRing,
  CalendarPlus,
  Pencil,
  Plus,
  Trash2,
  UserRound
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { MonCombobox } from '@/components/filter-combobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SectionCard } from '../hub-parts'
import { isoToLocalInput, localInputToIso, viewerTimeZone } from '../releases/releases-api'
import {
  ackPage,
  addOverride,
  fetchOnCall,
  fetchOnCallPeople,
  fromNow,
  incidentKeys,
  type OnCallView,
  type Page,
  removeOverride,
  STEP_WORDS,
  type StepKind,
  saveRota,
  WEEKDAYS
} from './incident-api'

/**
 * On-call (Apps hub tab, Hub enhancement 33): pages waiting for the viewer, who is on call for
 * each app now and next, the weekly rota and its overrides. Urgent Hub alerts for an app with a
 * rota go to the person on call first and escalate step by step until someone acknowledges.
 * Administrators set rotas; anyone paged acknowledges. `?page=<id>` opens from the notification.
 */
export default function HubOnCall() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params] = useSearchParams()
  const focus = Number(params.get('page')) || null
  const q = useQuery({
    queryKey: incidentKeys.onCall(),
    queryFn: fetchOnCall,
    refetchInterval: 30_000
  })
  return (
    <section aria-labelledby='hub-oncall-title' className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
        <h2
          id='hub-oncall-title'
          className='m-0 min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'
        >
          On-call
        </h2>
        <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          Times in {viewerTimeZone()}
        </span>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-background'>
        {q.isPending ? (
          <Skeleton className='h-40 w-full' />
        ) : q.isError ? (
          <QueryErrorState error={q.error} what='on-call' onRetry={() => void q.refetch()} />
        ) : (
          <div className='space-y-4'>
            <PagesCard data={q.data} focus={focus} />
            <RotasCard data={q.data} isAdmin={isAdmin} />
          </div>
        )}
      </div>
    </section>
  )
}

const nameOf = (d: OnCallView, id: string | null | undefined) =>
  id ? (d.names[id.toLowerCase()] ?? 'Someone') : '—'

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: incidentKeys.onCall() })
}

// ─── Pages ────────────────────────────────────────────────────────────────────

function PagesCard({ data, focus }: { data: OnCallView; focus: number | null }) {
  const refresh = useRefresh()
  const ack = useMutation({
    mutationFn: (id: number) => ackPage(id),
    onSuccess: () => {
      toast.success('Acknowledged — the escalation stopped')
      refresh()
    },
    onError: (err) => hubToast(err, 'Could not acknowledge the page')
  })
  const active = data.pages
  const recent = data.recent.filter((p) => p.status === 'closed').slice(0, 10)
  return (
    <SectionCard
      title='Pages'
      description='Alerts sent to on-call. Acknowledge to stop the escalation; the Hub moves to the next step when nobody does.'
    >
      {active.length === 0 ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No open pages.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {active.map((p) => (
            <PageRow
              key={p.id}
              p={p}
              data={data}
              focus={focus === p.id}
              onAck={() => ack.mutate(p.id)}
              busy={ack.isPending}
            />
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <details className='border-t border-slate-100 dark:border-border'>
          <summary className='cursor-pointer px-4 py-2 text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'>
            Recently closed ({recent.length})
          </summary>
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {recent.map((p) => (
              <PageRow key={p.id} p={p} data={data} focus={false} />
            ))}
          </ul>
        </details>
      )}
    </SectionCard>
  )
}

function PageRow({
  p,
  data,
  focus,
  onAck,
  busy
}: {
  p: Page
  data: OnCallView
  focus: boolean
  onAck?: () => void
  busy?: boolean
}) {
  const last = p.sent_to.at(-1)
  return (
    <li
      className={cn(
        'flex flex-wrap items-start gap-3 px-4 py-3',
        focus && 'bg-amber-50 dark:bg-amber-400/10'
      )}
    >
      <BellRing
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          p.status === 'open' ? 'text-red-600 dark:text-red-400' : 'text-slate-400'
        )}
        aria-hidden
      />
      <div className='min-w-0 flex-[1_1_260px]'>
        <p className='m-0 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {p.subject}
        </p>
        <p className='m-0 mt-0.5 text-[12px] text-slate-600 dark:text-slate-300'>{p.message}</p>
        <p className='m-0 mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
          {formatRelative(p.created_at)}
          {last &&
            ` · reached ${STEP_WORDS[last.step].toLowerCase()} (${last.users.map((u) => nameOf(data, u)).join(', ')})`}
          {p.status === 'open' && p.next_at && ` · escalates ${fromNow(p.next_at)}`}
          {p.status === 'acked' && ` · acknowledged by ${nameOf(data, p.acknowledged_by)}`}
        </p>
      </div>
      <div className='flex items-center gap-2'>
        {p.incident_id && (
          <Link to={`/hub/incidents?incident=${p.incident_id}`} className={ghostButton}>
            Incident
          </Link>
        )}
        {p.status === 'open' && onAck && (
          <Button size='sm' className='h-8 gap-1.5' onClick={onAck} disabled={busy}>
            Acknowledge
          </Button>
        )}
      </div>
    </li>
  )
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

function RotasCard({ data, isAdmin }: { data: OnCallView; isAdmin: boolean }) {
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const withRota = new Set(data.rotas.map((r) => r.rota.app_id))
  const appName = (id: number) => data.apps.find((a) => a.id === id)?.name ?? `App ${id}`
  return (
    <SectionCard
      title='Rotas'
      description='One weekly rota per app. Urgent alerts for an app without a rota still go to its owners and the administrators.'
      actions={
        isAdmin &&
        editing == null &&
        data.apps.some((a) => !withRota.has(a.id)) && (
          <button type='button' className={ghostButton} onClick={() => setEditing('new')}>
            <Plus className='h-3.5 w-3.5' aria-hidden /> New rota
          </button>
        )
      }
    >
      {editing === 'new' && <RotaForm data={data} appId={null} onDone={() => setEditing(null)} />}
      {data.rotas.length === 0 && editing !== 'new' ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No rotas yet{isAdmin ? ' — add one so alerts reach a person first.' : '.'}
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {data.rotas.map((r) => (
            <li key={r.rota.app_id}>
              {editing === r.rota.app_id ? (
                <RotaForm data={data} appId={r.rota.app_id} onDone={() => setEditing(null)} />
              ) : (
                <RotaView
                  data={data}
                  item={r}
                  appName={appName(r.rota.app_id)}
                  onEdit={isAdmin ? () => setEditing(r.rota.app_id) : undefined}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function RotaView({
  data,
  item,
  appName,
  onEdit
}: {
  data: OnCallView
  item: OnCallView['rotas'][number]
  appName: string
  onEdit?: () => void
}) {
  const r = item.rota
  const oc = item.on_call
  const refresh = useRefresh()
  const [adding, setAdding] = useState(false)
  const del = useMutation({
    mutationFn: (id: number) => removeOverride(id),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not remove the override')
  })
  return (
    <div className='space-y-3 px-4 py-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <h4 className='m-0 min-w-0 flex-1 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {appName}
          {!r.enabled && <span className='ml-2 text-[11px] font-medium text-slate-500'>Off</span>}
          {item.limited && (
            <span className='ml-2 text-[11px] font-normal text-slate-500 dark:text-muted-foreground'>
              You are on this rota — your shifts only
            </span>
          )}
        </h4>
        {onEdit && (
          <>
            <button type='button' className={ghostButton} onClick={() => setAdding((v) => !v)}>
              <CalendarPlus className='h-3.5 w-3.5' aria-hidden /> Override
            </button>
            <button type='button' className={ghostButton} onClick={onEdit}>
              <Pencil className='h-3.5 w-3.5' aria-hidden /> Edit
            </button>
          </>
        )}
      </div>
      <dl className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-[12px] sm:grid-cols-3 dark:border-border dark:bg-border'>
        <div className='bg-white px-3 py-2 dark:bg-card'>
          <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>On call now</dt>
          <dd className='m-0 mt-0.5 flex items-center gap-1.5 font-medium text-slate-900 dark:text-foreground'>
            <UserRound className='h-3.5 w-3.5 text-slate-400' aria-hidden />
            {oc.user_id ? nameOf(data, oc.user_id) : 'Nobody'}
            {oc.override && (
              <span className='text-[11px] font-normal text-amber-800 dark:text-amber-300'>
                override
              </span>
            )}
          </dd>
          {oc.until && (
            <dd className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
              until {formatDateTime(oc.until)}
            </dd>
          )}
        </div>
        <div className='bg-white px-3 py-2 dark:bg-card'>
          <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Next on the rota
          </dt>
          <dd className='m-0 mt-0.5 text-slate-800 dark:text-foreground'>
            {oc.next_user_id ? nameOf(data, oc.next_user_id) : '—'}
          </dd>
        </div>
        <div className='bg-white px-3 py-2 dark:bg-card'>
          <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>Escalation</dt>
          <dd className='m-0 mt-0.5 text-slate-800 dark:text-foreground'>
            {r.steps.map((s) => STEP_WORDS[s]).join(' → ')}
            <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
              every {r.escalate_minutes} min unacknowledged
            </span>
          </dd>
        </div>
      </dl>
      {adding && <OverrideForm data={data} appId={r.app_id} onDone={() => setAdding(false)} />}
      <div className='grid gap-3 md:grid-cols-2'>
        <div>
          <h5 className='m-0 mb-1 text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
            Coming shifts · {WEEKDAYS[r.handover_weekday]} {r.handover_time} ({r.time_zone})
          </h5>
          <ol className='m-0 list-none space-y-0.5 p-0 text-[12px]'>
            {item.shifts.slice(0, 6).map((s, i) => (
              <li key={`${s.from}-${i}`} className='flex gap-2'>
                <span className='w-[130px] shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {formatDateTime(s.from)}
                </span>
                <span
                  className={cn(
                    'text-slate-800 dark:text-foreground',
                    s.override && 'text-amber-800 dark:text-amber-300'
                  )}
                >
                  {nameOf(data, s.user_id)}
                  {s.override ? ' (override)' : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h5 className='m-0 mb-1 text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
            Overrides
          </h5>
          {item.overrides.length === 0 ? (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              None coming up.
            </p>
          ) : (
            <ul className='m-0 list-none space-y-1 p-0 text-[12px]'>
              {item.overrides.map((o) => (
                <li key={o.id} className='flex flex-wrap items-center gap-2'>
                  <span className='font-medium text-slate-800 dark:text-foreground'>
                    {nameOf(data, o.user_id)}
                  </span>
                  <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                    {formatDateTime(o.starts_at)} → {formatDateTime(o.ends_at)}
                  </span>
                  {o.note && <span className='text-slate-500'>· {o.note}</span>}
                  {onEdit && (
                    <ConfirmButton
                      className={dangerGhost}
                      armedClassName={dangerArmed}
                      confirmLabel='Remove?'
                      onConfirm={() => del.mutate(o.id)}
                      title='Remove override'
                    >
                      <Trash2 className='h-3.5 w-3.5' aria-hidden />
                    </ConfirmButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function usePeople() {
  return useQuery({ queryKey: incidentKeys.people(), queryFn: fetchOnCallPeople })
}

const ALL_STEPS: StepKind[] = ['on_call', 'next', 'owners', 'admins']
/** Always in the chain (the server adds owners and admins when a rota leaves them out). */
const LOCKED: ReadonlySet<StepKind> = new Set(['on_call', 'owners', 'admins'])

function RotaForm({
  data,
  appId,
  onDone
}: {
  data: OnCallView
  appId: number | null
  onDone: () => void
}) {
  const refresh = useRefresh()
  const current = data.rotas.find((r) => r.rota.app_id === appId)?.rota
  const people = usePeople()
  const [app, setApp] = useState(appId ? String(appId) : '')
  const [enabled, setEnabled] = useState(current?.enabled ?? true)
  const [list, setList] = useState<string[]>(current?.people ?? [])
  const [zone, setZone] = useState(current?.time_zone ?? viewerTimeZone())
  const [weekday, setWeekday] = useState(String(current?.handover_weekday ?? 1))
  const [time, setTime] = useState(current?.handover_time ?? '09:00')
  const [starts, setStarts] = useState(
    isoToLocalInput(current?.starts_on ?? new Date().toISOString())
  )
  const [minutes, setMinutes] = useState(String(current?.escalate_minutes ?? 15))
  const [steps, setSteps] = useState<StepKind[]>(current?.steps ?? ALL_STEPS)
  const [pick, setPick] = useState('')
  const names = useMemo(
    () => new Map((people.data ?? []).map((p) => [p.id.toLowerCase(), p.name])),
    [people.data]
  )
  const label = (id: string) => names.get(id.toLowerCase()) ?? data.names[id.toLowerCase()] ?? id
  const move = (i: number, d: -1 | 1) => {
    const next = [...list]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setList(next)
  }
  const save = useMutation({
    mutationFn: () =>
      saveRota(Number(app), {
        enabled,
        people: list,
        time_zone: zone,
        handover_weekday: Number(weekday),
        handover_time: time,
        starts_on: localInputToIso(starts),
        escalate_minutes: Number(minutes),
        steps
      }),
    onSuccess: () => {
      toast.success('Rota saved')
      refresh()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the rota')
  })
  const taken = new Set(data.rotas.map((r) => r.rota.app_id))
  return (
    <form
      className='space-y-4 border-b border-slate-100 bg-slate-50/60 p-4 dark:border-border dark:bg-muted/20'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className='grid gap-4 md:grid-cols-3'>
        <Field id='rota-app' label='App'>
          {appId ? (
            <p className='m-0 py-1.5 text-[13px] font-medium'>
              {data.apps.find((a) => a.id === appId)?.name}
            </p>
          ) : (
            <MonCombobox
              value={app}
              onChange={setApp}
              options={data.apps
                .filter((a) => !taken.has(a.id))
                .map((a) => ({ value: String(a.id), label: a.name }))}
              placeholder='Pick the app'
              className='w-full'
            />
          )}
        </Field>
        <Field
          id='rota-zone'
          label='Time zone'
          hint='The hand-over keeps this clock across daylight saving.'
        >
          <Input
            id='rota-zone'
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            className='h-8 text-[13px]'
          />
        </Field>
        <div className='flex items-end gap-2 pb-1'>
          <label htmlFor='rota-on' className='flex items-center gap-2 text-[12.5px]'>
            <Switch id='rota-on' checked={enabled} onCheckedChange={setEnabled} /> Rota on
          </label>
        </div>
        <Field id='rota-day' label='Hand-over day'>
          <SimpleSelect
            value={weekday}
            onChange={setWeekday}
            ariaLabel='Hand-over day'
            className='h-8 text-[13px]'
            options={WEEKDAYS.map((w, i) => ({ value: String(i), label: w }))}
          />
        </Field>
        <Field id='rota-time' label='Hand-over time'>
          <Input
            id='rota-time'
            type='time'
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id='rota-start' label='First person starts' hint='In your own zone.'>
          <Input
            id='rota-start'
            type='datetime-local'
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
            className='h-8 text-[13px]'
          />
        </Field>
      </div>
      <Field
        id='rota-people'
        label='People, in rota order'
        hint='Hub accounts: administrators, app owners and people who signed in through the Hub.'
      >
        <div className='space-y-1.5'>
          <ol className='m-0 list-none space-y-1 p-0'>
            {list.map((id, i) => (
              <li
                key={id}
                className='flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-border dark:bg-card'
              >
                <span className='w-5 text-right tabular-nums text-slate-400'>{i + 1}</span>
                <span className='min-w-0 flex-1 truncate'>{label(id)}</span>
                <button
                  type='button'
                  className={ghostButton}
                  aria-label={`Move ${label(id)} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className='h-3.5 w-3.5' aria-hidden />
                </button>
                <button
                  type='button'
                  className={ghostButton}
                  aria-label={`Move ${label(id)} down`}
                  disabled={i === list.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className='h-3.5 w-3.5' aria-hidden />
                </button>
                <button
                  type='button'
                  className={dangerGhost}
                  aria-label={`Remove ${label(id)}`}
                  onClick={() => setList(list.filter((x) => x !== id))}
                >
                  <Trash2 className='h-3.5 w-3.5' aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          <MonCombobox
            value={pick}
            onChange={(v) => {
              if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) setList([...list, v])
              setPick('')
            }}
            options={(people.data ?? [])
              .filter((p) => !list.includes(p.id))
              .map((p) => ({ value: p.id, label: p.email ? `${p.name} · ${p.email}` : p.name }))}
            placeholder={people.isPending ? 'Loading people…' : 'Add a person'}
            className='w-full md:w-[360px]'
          />
        </div>
      </Field>
      <div className='grid gap-4 md:grid-cols-[160px_minmax(0,1fr)]'>
        <Field id='rota-min' label='Escalate after (min)'>
          <Input
            id='rota-min'
            type='number'
            min={1}
            max={240}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className='h-8 text-[13px] tabular-nums'
          />
        </Field>
        <fieldset className='m-0 border-0 p-0'>
          <legend className='mb-1.5 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Escalation steps
          </legend>
          <p className='m-0 mb-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            The person on call is always first; app owners and then the administrators always end
            the chain, so a page always reaches someone who can act.
          </p>
          <div className='flex flex-wrap gap-3'>
            {ALL_STEPS.map((s) => (
              <label
                key={s}
                htmlFor={`rota-step-${s}`}
                className='flex items-center gap-2 text-[12.5px]'
              >
                <Switch
                  id={`rota-step-${s}`}
                  checked={LOCKED.has(s) || steps.includes(s)}
                  disabled={LOCKED.has(s)}
                  onCheckedChange={(v) =>
                    setSteps(ALL_STEPS.filter((x) => (x === s ? v : steps.includes(x))))
                  }
                />
                {STEP_WORDS[s]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          type='submit'
          size='sm'
          className='h-8'
          disabled={!app || !list.length || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save rota'}
        </Button>
        <button type='button' className={ghostButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function OverrideForm({
  data,
  appId,
  onDone
}: {
  data: OnCallView
  appId: number
  onDone: () => void
}) {
  const refresh = useRefresh()
  const people = usePeople()
  const [who, setWho] = useState('')
  const [from, setFrom] = useState(isoToLocalInput(new Date().toISOString()))
  const [to, setTo] = useState(isoToLocalInput(new Date(Date.now() + 86_400_000).toISOString()))
  const [note, setNote] = useState('')
  const save = useMutation({
    mutationFn: () =>
      addOverride(appId, {
        user_id: who,
        starts_at: localInputToIso(from),
        ends_at: localInputToIso(to),
        note
      }),
    onSuccess: () => {
      toast.success('Override added')
      refresh()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not add the override')
  })
  void data
  return (
    <form
      className='grid gap-3 rounded-md border border-slate-200 bg-white p-3 md:grid-cols-[minmax(0,1fr)_180px_180px] dark:border-border dark:bg-card'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <Field id={`ov-who-${appId}`} label='Who covers'>
        <MonCombobox
          value={who}
          onChange={setWho}
          options={(people.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          placeholder='Pick a person'
          className='w-full'
        />
      </Field>
      <Field id={`ov-from-${appId}`} label='From'>
        <Input
          id={`ov-from-${appId}`}
          type='datetime-local'
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className='h-8 text-[13px]'
        />
      </Field>
      <Field id={`ov-to-${appId}`} label='Until'>
        <Input
          id={`ov-to-${appId}`}
          type='datetime-local'
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className='h-8 text-[13px]'
        />
      </Field>
      <div className='md:col-span-3'>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          placeholder='Why (optional): holiday swap, conference…'
          aria-label='Note'
          className='h-8 text-[13px]'
        />
      </div>
      <div className='flex gap-2 md:col-span-3'>
        <Button type='submit' size='sm' className='h-8' disabled={!who || save.isPending}>
          Add override
        </Button>
        <button type='button' className={ghostButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
