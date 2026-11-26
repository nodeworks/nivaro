import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Download, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import {
  dangerArmed,
  dangerGhost,
  Field,
  ghostButton,
  SectionCard,
  segmentButton,
  segmentGroup
} from '../hub-parts'
import { localInputToIso, viewerTimeZone } from '../releases/releases-api'
import { type CalendarView, ChangeCalendar, KIND_META, LEGEND } from './ChangeCalendar'
import { ChecklistItemsCard } from './ChecklistItemsCard'
import {
  type CalendarKind,
  type ChangesOverview,
  changeKeys,
  downloadIcs,
  fetchCalendar,
  fetchChanges,
  KIND_WORDS
} from './changes-api'
import { DeployWindowsCard } from './DeployWindowsCard'
import { PreDeployChecklist } from './PreDeployChecklist'

/**
 * Changes (Apps hub tab): the change calendar of every app the person may see — promotions,
 * schedules, release trains, moves, shared upgrades, freezes, planned maintenance, and the open
 * hours of the deploy windows — with an .ics download; the deploy windows themselves; the
 * pre-deploy checklists per app, and the checklists unattended starts wait for. Owners read and
 * tick what they may; administrators change the rules. Times in the viewer's own zone.
 */
export default function HubChanges() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<CalendarView>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [appId, setAppId] = useState<number | null>(null)
  const [hidden, setHidden] = useState<Set<CalendarKind>>(() => new Set())
  const q = useQuery({
    queryKey: changeKeys.overview(),
    queryFn: fetchChanges,
    refetchInterval: 60_000
  })
  const focusRun = Number(params.get('checklist')) || null
  const ics = useMutation({
    mutationFn: () =>
      downloadIcs(
        appId != null
          ? { appId }
          : isAdmin
            ? {}
            : { owner: String((user as { id?: string } | null)?.id ?? '') }
      ),
    onError: (err) => hubToast(err, 'Could not download the calendar')
  })
  const toggle = (k: CalendarKind) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  return (
    <section aria-labelledby='hub-changes-title' className='flex flex-1 min-h-0 flex-col'>
      <h2 id='hub-changes-title' className='sr-only'>
        Changes
      </h2>
      <HubToolbar
        description={`Promotions, schedules, release trains, moves, shared upgrades, freezes and planned maintenance of every app you can see. Times in ${viewerTimeZone()}.`}
      />
      <div className='relative flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {q.isPending ? (
          <Skeleton className='h-40 w-full' />
        ) : q.isError ? (
          <QueryErrorState
            error={q.error}
            what='the change calendar'
            onRetry={() => void q.refetch()}
          />
        ) : (
          <div className='space-y-4'>
            {focusRun && (
              <SectionCard
                title='Checklist to tick'
                description='A start is waiting for this pre-deploy checklist.'
                actions={
                  <button
                    type='button'
                    className={ghostButton}
                    onClick={() => {
                      params.delete('checklist')
                      setParams(params, { replace: true })
                    }}
                  >
                    Close
                  </button>
                }
              >
                <div className='p-3'>
                  <PreDeployChecklist runId={focusRun} />
                </div>
              </SectionCard>
            )}
            <WaitingCard data={q.data} skip={focusRun} />
            <section
              aria-label='Change calendar'
              className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
            >
              <div className='flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
                <fieldset className={segmentGroup}>
                  <legend className='sr-only'>View</legend>
                  {(['month', 'week', 'list'] as CalendarView[]).map((v) => (
                    <button
                      key={v}
                      type='button'
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={cn(segmentButton(view === v), 'capitalize')}
                    >
                      {v}
                    </button>
                  ))}
                </fieldset>
                <div className='w-[200px]'>
                  <SimpleSelect
                    value={appId == null ? 'all' : String(appId)}
                    onChange={(v) => setAppId(v === 'all' ? null : Number(v))}
                    options={[
                      { value: 'all', label: isAdmin ? 'Every app' : 'My apps' },
                      ...q.data.apps.map((a) => ({ value: String(a.id), label: a.key }))
                    ]}
                    ariaLabel='App'
                    className='h-8 bg-white text-left text-[13px] dark:bg-background'
                  />
                </div>
                <div className='ml-auto flex items-center gap-1'>
                  <button
                    type='button'
                    className={ghostButton}
                    disabled={ics.isPending}
                    onClick={() => ics.mutate()}
                    data-tip='The last 30 days and the next 180, as a file for Outlook or Google Calendar'
                  >
                    <Download className='h-3.5 w-3.5' aria-hidden />
                    {ics.isPending ? 'Preparing…' : 'Export .ics'}
                  </button>
                </div>
              </div>
              <div className='flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2 dark:border-border/60'>
                {LEGEND.filter((k) => k !== 'window' || view === 'week').map((k) => (
                  <button
                    key={k}
                    type='button'
                    aria-pressed={!hidden.has(k)}
                    onClick={() => toggle(k)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                      KIND_META[k].chip,
                      hidden.has(k) && 'opacity-40'
                    )}
                  >
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full', KIND_META[k].bar)}
                      aria-hidden
                    />
                    {KIND_WORDS[k]}
                  </button>
                ))}
              </div>
              <div className='p-4'>
                <ChangeCalendar
                  view={view}
                  anchor={anchor}
                  onAnchor={setAnchor}
                  appId={appId}
                  hidden={hidden}
                />
              </div>
            </section>
            <DeployWindowsCard data={q.data} isAdmin={isAdmin} />
            <ChecklistItemsCard data={q.data} isAdmin={isAdmin} appFilter={appId} />
            <MaintenanceCard data={q.data} isAdmin={isAdmin} />
          </div>
        )}
      </div>
    </section>
  )
}

const SOURCE_WORDS = {
  schedule: 'Scheduled promotion',
  train: 'Release train step',
  person: 'A start'
}

function WaitingCard({ data, skip }: { data: ChangesOverview; skip: number | null }) {
  const [open, setOpen] = useState<number | null>(null)
  const list = data.waiting.filter((w) => w.id !== skip)
  if (!list.length) return null
  const appOf = (id: number | null) => data.apps.find((a) => a.id === id)?.key ?? ''
  return (
    <SectionCard
      title='Waiting for a checklist'
      description='These unattended starts begin once their required items are ticked.'
    >
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {list.map((w) => (
          <li key={w.id} className='space-y-2 px-4 py-2.5 text-[12px]'>
            <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
              <span className='font-medium text-slate-900 dark:text-foreground'>
                {SOURCE_WORDS[w.source]} · {appOf(w.app_id)}
                {w.env_key ? ` · ${w.env_key}` : ''}
                {w.version ? ` → ${w.version}` : ''}
              </span>
              {w.created_at && (
                <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  waiting since {formatDateTime(w.created_at)}
                </span>
              )}
              <button
                type='button'
                className={cn(ghostButton, 'ml-auto')}
                aria-expanded={open === w.id}
                onClick={() => setOpen(open === w.id ? null : w.id)}
              >
                {open === w.id ? 'Hide' : 'Tick it'}
              </button>
            </div>
            {open === w.id && <PreDeployChecklist runId={w.id} />}
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

function MaintenanceCard({ data, isAdmin }: { data: ChangesOverview; isAdmin: boolean }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const range = useMemo(() => {
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + 90 * 86_400_000).toISOString()
    }
  }, [])
  const q = useQuery({
    queryKey: changeKeys.calendar(range.from, range.to, null),
    queryFn: () => fetchCalendar(range.from, range.to, null)
  })
  const entries = (q.data?.events ?? []).filter(
    (e) => (e.kind === 'maintenance' || e.kind === 'note') && e.id.startsWith('entry:')
  )
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/hub/calendar/entries/${id.replace('entry:', '')}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: changeKeys.all }),
    onError: (err) => hubToast(err, 'Could not delete the entry')
  })
  return (
    <SectionCard
      title='Planned maintenance'
      description='Work that is not a deploy but people should plan around. It shows on the calendar and in the .ics.'
      actions={
        isAdmin &&
        !adding && (
          <button type='button' className={ghostButton} onClick={() => setAdding(true)}>
            <Wrench className='h-3.5 w-3.5' aria-hidden /> Add maintenance
          </button>
        )
      }
    >
      {adding && <EntryForm data={data} onDone={() => setAdding(false)} />}
      {q.isPending ? (
        <Skeleton className='m-4 h-8' />
      ) : entries.length === 0 ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Nothing planned in the next 90 days.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {entries.map((e) => (
            <li key={e.id} className='flex items-center gap-3 px-4 py-2.5 text-[12px]'>
              <CalendarDays
                className='h-3.5 w-3.5 shrink-0 text-orange-600 dark:text-orange-400'
                aria-hidden
              />
              <div className='min-w-0 flex-1'>
                <div className='font-medium text-slate-900 dark:text-foreground'>{e.title}</div>
                <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {formatDateTime(e.start)}
                  {e.end ? ` → ${formatDateTime(e.end)}` : ''}
                  {e.app_key ? ` · ${e.app_key}` : ' · every app'}
                  {e.detail ? ` — ${e.detail}` : ''}
                </div>
              </div>
              {isAdmin && (
                <ConfirmButton
                  className={dangerGhost}
                  armedClassName={dangerArmed}
                  confirmLabel='Delete it?'
                  onConfirm={() => remove.mutate(e.id)}
                >
                  Delete
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function EntryForm({ data, onDone }: { data: ChangesOverview; onDone: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [appId, setAppId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [desc, setDesc] = useState('')
  const save = useMutation({
    mutationFn: () =>
      api.post('/hub/calendar/entries', {
        title,
        kind: 'maintenance',
        app_id: appId ? Number(appId) : null,
        starts_at: localInputToIso(start),
        ends_at: localInputToIso(end),
        description: desc.trim() || null
      }),
    onSuccess: () => {
      toast.success('Maintenance added to the calendar')
      void qc.invalidateQueries({ queryKey: changeKeys.all })
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not add the maintenance')
  })
  return (
    <div className='space-y-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-muted/40'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field id='mt-title' label='What'>
          <Input
            id='mt-title'
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder='Database server patching'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id='mt-app' label='App'>
          <SimpleSelect
            value={appId || 'all'}
            onChange={(v) => setAppId(v === 'all' ? '' : v)}
            options={[
              { value: 'all', label: 'Every app' },
              ...data.apps.map((a) => ({ value: String(a.id), label: a.key }))
            ]}
            ariaLabel='App'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'mt-app' }}
          />
        </Field>
        <Field id='mt-start' label='From' hint={`Your time (${viewerTimeZone()}).`}>
          <Input
            id='mt-start'
            type='datetime-local'
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id='mt-end' label='Until (optional)'>
          <Input
            id='mt-end'
            type='datetime-local'
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className='h-8 text-[13px]'
          />
        </Field>
      </div>
      <Field id='mt-desc' label='Details (optional)'>
        <Input
          id='mt-desc'
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          maxLength={1000}
          className='h-8 text-[13px]'
        />
      </Field>
      <div className='flex gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!title.trim() || !start || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Adding…' : 'Add to the calendar'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
