import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  EyeOff,
  Flag,
  Headphones,
  Megaphone,
  MessagesSquare,
  Pencil,
  ShieldOff,
  Zap
} from 'lucide-react'
import { type RefObject, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  type ChaosRunEvent,
  type ChaosStatus,
  chaosKeys,
  countdown,
  errText,
  fetchStatus,
  VERDICT_TONE
} from './api'
import {
  fetchGameday,
  fmtDuration,
  fmtEastern,
  fmtOffset,
  type GamedayDetail,
  type GamedayInject,
  gamedayAction,
  gamedayKeys,
  MARK_LABEL,
  type NoteMark,
  planOf
} from './gameday-api'
import { RunChip } from './RunsTab'
import { NoteMarkers, ScribeBar } from './Scribe'

/**
 * One game day (#2852): the plan, the people and the channel, the inject track with each
 * inject's state, the scribe bar while it runs (#2853), blind reveal (#2854), the timeline and
 * the child runs. Polls every 5 s while running (the cockpit's rhythm).
 */

const KIND_ICON = { fault: Zap, announce: Megaphone, checkpoint: Flag }

const btn =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40'
const btnPrimary = cn(btn, 'bg-nvr-cyan text-white hover:bg-[#00b8e0]')
const btnSecondary = cn(
  btn,
  'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
)

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })

export function GameDayDetail({ id, onEdit }: { id: string; onEdit: () => void }) {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<GamedayDetail>({
    queryKey: gamedayKeys.detail(id),
    queryFn: () => fetchGameday(id),
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 5_000 : 60_000)
  })
  const [now, setNow] = useState(Date.now())
  const running = data?.run.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const [confirm, setConfirm] = useState<'cancel' | 'abort' | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const abortRef = useRef<HTMLButtonElement>(null)
  const confirmId = useId()
  const gateNoteId = useId()
  // The page's gate read (same key): a refused gate disables what would arm a fault.
  const { data: gate } = useQuery<ChaosStatus>({ queryKey: chaosKeys.status, queryFn: fetchStatus })
  const refused = gate && !gate.allowed ? (gate.reason ?? 'The chaos gate refused.') : null

  const act = useMutation({
    mutationFn: (a: { action: 'start' | 'end' | 'cancel' | 'reveal' | 'step'; body?: object }) =>
      gamedayAction(id, a.action, (a.body ?? {}) as Record<string, unknown>),
    onSuccess: (_d, a) => {
      setConfirm(null)
      const msg: Record<string, string> = {
        start: 'Game day started',
        end: 'Game day ended',
        cancel: 'Game day cancelled',
        reveal: 'Revealed to everyone',
        step: 'Inject fired'
      }
      toast.success(msg[a.action])
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    },
    onError: (e) => toast.error(errText(e, 'That did not work'))
  })

  if (isLoading)
    return (
      <div className='space-y-4 p-6'>
        <Skeleton className='h-5 w-64' />
        <Skeleton className='h-3.5 w-40' />
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
    )
  if (isError || !data)
    return (
      <p className='p-6 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        This game day did not load. It may have been removed.
      </p>
    )

  const { run, events, children, people, points, blind } = data
  const plan = planOf(run)
  const nameOf = (uid: string | null | undefined) =>
    uid ? (people.find((p) => p.id === uid.toLowerCase())?.name ?? 'Someone') : '—'
  const room = typeof run.meta.channel_room === 'string' ? run.meta.channel_room : null
  const startMs = Date.parse(run.started_at ?? plan.starts_at)
  const endMs = startMs + plan.duration_min * 60_000
  const steps = new Map<string, ChaosRunEvent>()
  for (const e of events) {
    const iid = e.data?.inject_id
    if (e.kind === 'step' && typeof iid === 'string') steps.set(iid, e)
  }
  const notes = events.filter((e) => e.kind === 'note')
  const ended = ['completed', 'stopped', 'aborted', 'refused'].includes(run.status)
  const phase: InjectPhase = running ? 'running' : ended ? 'ended' : 'planned'
  const nextId = typeof run.meta.next_id === 'string' ? run.meta.next_id : null

  return (
    <div className='min-h-full'>
      <header className='border-b border-slate-200 bg-white px-4 py-4 sm:px-6 sm:py-5 dark:border-border dark:bg-card'>
        <div className='flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-4'>
          <div className='min-w-0 lg:flex-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <h2 className='text-[16px] font-semibold tracking-[-0.01em] text-balance text-slate-900 dark:text-foreground'>
                {plan.title}
              </h2>
              <RunChip run={run} />
              {plan.blind && (
                <span
                  data-tip={
                    blind.revealed
                      ? 'Revealed: everyone sees the faults now'
                      : 'Responders see no drill banner until the lead reveals'
                  }
                  className='inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-700 dark:bg-muted dark:text-foreground'
                >
                  <EyeOff className='h-3 w-3' aria-hidden />
                  {blind.revealed ? 'Blind · revealed' : 'Blind'}
                </span>
              )}
              {plan.repeat === 'monthly' && (
                <span className='rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-700 dark:bg-muted dark:text-foreground'>
                  Monthly
                </span>
              )}
            </div>
            <p className='mt-1 text-[12.5px] text-slate-500 tabular-nums dark:text-muted-foreground'>
              {fmtEastern(run.started_at ?? plan.starts_at)} · {plan.duration_min} min
              {running && (
                <>
                  {' · '}
                  <span className='font-medium text-slate-800 dark:text-foreground'>
                    ends in {countdown(endMs, now)}
                  </span>
                </>
              )}
              {plan.auto_start && run.status === 'planned' && ' · starts automatically'}
            </p>
            {refused && (run.status === 'planned' || running) && (
              <p
                id={gateNoteId}
                className='mt-1.5 flex items-start gap-1.5 text-[12px] text-amber-800 dark:text-amber-300'
              >
                <ShieldOff className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
                <span>
                  Faults cannot be armed on this instance, so{' '}
                  {running ? 'fault injects are' : 'Start now and fault injects are'} off.
                </span>
              </p>
            )}
          </div>
          <div className='flex shrink-0 flex-wrap items-center gap-2'>
            {run.status === 'planned' && (
              <>
                <button
                  type='button'
                  className={btnPrimary}
                  disabled={act.isPending || !!refused}
                  aria-describedby={refused ? gateNoteId : undefined}
                  onClick={() => act.mutate({ action: 'start' })}
                >
                  Start now
                </button>
                <button type='button' className={btnSecondary} onClick={onEdit}>
                  <Pencil className='h-3.5 w-3.5' aria-hidden /> Edit
                </button>
                <button
                  ref={cancelRef}
                  type='button'
                  className={btnSecondary}
                  aria-expanded={confirm === 'cancel'}
                  aria-controls={confirm === 'cancel' ? confirmId : undefined}
                  onClick={() => setConfirm((c) => (c === 'cancel' ? null : 'cancel'))}
                >
                  Cancel day
                </button>
              </>
            )}
            {running && (
              <>
                {plan.blind && !blind.revealed && (
                  <button
                    type='button'
                    className={btnSecondary}
                    disabled={act.isPending}
                    onClick={() => act.mutate({ action: 'reveal' })}
                  >
                    Reveal to everyone
                  </button>
                )}
                <button
                  type='button'
                  className={btnSecondary}
                  disabled={act.isPending}
                  onClick={() => act.mutate({ action: 'end', body: { how: 'completed' } })}
                >
                  End day
                </button>
                <button
                  ref={abortRef}
                  type='button'
                  className={cn(
                    btn,
                    'border border-red-200 bg-white text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:bg-card dark:text-red-400 dark:hover:bg-red-950/40'
                  )}
                  aria-expanded={confirm === 'abort'}
                  aria-controls={confirm === 'abort' ? confirmId : undefined}
                  onClick={() => setConfirm((c) => (c === 'abort' ? null : 'abort'))}
                >
                  Abort
                </button>
              </>
            )}
            {ended && (
              <Link to={`/chaos/runs/${run.id}`} className={btnSecondary}>
                Open the report
              </Link>
            )}
          </div>
        </div>
        {/* The confirm gets its own row so opening it never reflows the title or the buttons. */}
        {confirm === 'cancel' && run.status === 'planned' && (
          <div className='mt-3 flex lg:justify-end'>
            <ConfirmInline
              id={confirmId}
              text='Cancel this day and tell everyone?'
              yes='Cancel day'
              returnFocus={cancelRef}
              onYes={() => act.mutate({ action: 'cancel' })}
              onNo={() => setConfirm(null)}
            />
          </div>
        )}
        {confirm === 'abort' && running && (
          <div className='mt-3 flex lg:justify-end'>
            <ConfirmInline
              id={confirmId}
              text='Stop every fault and abort?'
              yes='Abort'
              danger
              returnFocus={abortRef}
              onYes={() => act.mutate({ action: 'end', body: { how: 'aborted' } })}
              onNo={() => setConfirm(null)}
            />
          </div>
        )}
      </header>

      <div className='space-y-6 p-4 sm:p-6'>
        <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 md:grid-cols-4 dark:border-border dark:bg-border'>
          <Cell label='Lead'>{nameOf(plan.lead)}</Cell>
          <Cell label='Scribe'>{plan.scribe ? nameOf(plan.scribe) : 'None'}</Cell>
          <Cell label='Responders'>
            {plan.responders.length
              ? plan.responders.map((r) => nameOf(r)).join(', ')
              : 'None named'}
          </Cell>
          <Cell label='Channel'>
            {room ? (
              <span className='flex flex-wrap gap-x-3 gap-y-1'>
                <Link
                  to={`/chat?room=${encodeURIComponent(room)}`}
                  className='inline-flex items-center gap-1 text-slate-900 underline-offset-2 hover:underline dark:text-foreground'
                >
                  <MessagesSquare className='h-3.5 w-3.5 text-slate-400' aria-hidden /> Open
                </Link>
                <Link
                  to={`/chat?room=${encodeURIComponent(room)}`}
                  data-tip='Opens the channel — press the huddle button in its header'
                  className='inline-flex items-center gap-1 text-slate-900 underline-offset-2 hover:underline dark:text-foreground'
                >
                  <Headphones className='h-3.5 w-3.5 text-slate-400' aria-hidden /> Start huddle
                </Link>
              </span>
            ) : plan.channel ? (
              'Not created (chat unavailable)'
            ) : (
              'No channel'
            )}
          </Cell>
        </dl>

        {running && (
          <section aria-labelledby='scribe-h' className='space-y-2'>
            <h3
              id='scribe-h'
              className='text-[13px] font-semibold text-slate-900 dark:text-foreground'
            >
              Scribe
            </h3>
            <ScribeBar runId={run.id} />
          </section>
        )}

        {(running || ended) && (
          <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 md:grid-cols-4 dark:border-border dark:bg-border'>
            <Cell label='Time to detect'>{fmtDuration(points.ttd_s)}</Cell>
            <Cell label='Time to find the cause'>{fmtDuration(points.ttc_s)}</Cell>
            <Cell label='Time to fix'>{fmtDuration(points.ttf_s)}</Cell>
            <Cell label='Notes'>{points.notes}</Cell>
          </dl>
        )}

        <section aria-labelledby='injects-h' className='space-y-2'>
          <h3
            id='injects-h'
            className='text-[13px] font-semibold text-slate-900 dark:text-foreground'
          >
            Injects
          </h3>
          <Track
            injects={plan.injects}
            steps={steps}
            notes={notes}
            from={startMs}
            to={endMs}
            now={running ? now : null}
          />
          {plan.injects.length === 0 ? (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              This plan has no injects — the day is a free exercise.
            </p>
          ) : (
            <ol className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
              {plan.injects.map((inj) => (
                <InjectRow
                  key={inj.id}
                  inj={inj}
                  step={steps.get(inj.id) ?? null}
                  phase={phase}
                  canFire={running && !steps.has(inj.id)}
                  refused={inj.kind === 'fault' ? refused : null}
                  gateNoteId={gateNoteId}
                  busy={act.isPending}
                  now={now}
                  onFire={() => act.mutate({ action: 'step', body: { inject_id: inj.id } })}
                />
              ))}
            </ol>
          )}
        </section>

        {plan.notes && (
          <section className='space-y-1'>
            <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
              Notes for the team
            </h3>
            <p className='max-w-[75ch] text-[12.5px] leading-relaxed whitespace-pre-line text-slate-700 dark:text-foreground/90'>
              {plan.notes}
            </p>
          </section>
        )}

        {children.length > 0 && (
          <section className='space-y-2'>
            <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
              Fault runs
            </h3>
            <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
              {children.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/chaos/runs/${c.id}`}
                    className='flex items-center gap-3 px-3 py-2 text-[12.5px] transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-muted'
                  >
                    <span className='min-w-0 flex-1 truncate text-slate-900 dark:text-foreground'>
                      {c.label}
                    </span>
                    <span className='text-[11.5px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                      {c.started_at ? time(c.started_at) : ''}
                    </span>
                    <RunChip run={c} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby='timeline-h' className='space-y-2'>
          <h3
            id='timeline-h'
            className='text-[13px] font-semibold text-slate-900 dark:text-foreground'
          >
            Timeline
          </h3>
          {events.length === 0 ? (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>Nothing yet.</p>
          ) : (
            <ol className='space-y-1.5'>
              {events.map((e) => (
                <li key={e.id} className='flex gap-3 text-[12.5px]'>
                  <span className='w-[86px] shrink-0 text-right font-mono text-[11.5px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                    {time(e.at)}
                  </span>
                  <span className='min-w-0 text-slate-800 dark:text-foreground/90'>
                    {describeEvent(e, plan.injects)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {nextId && (
          <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Next month's day is planned —{' '}
            <Link
              to={`/chaos?tab=gamedays&gameday=${nextId}`}
              className='text-slate-900 underline underline-offset-2 dark:text-foreground'
            >
              open it
            </Link>
            .
          </p>
        )}
        {ended && run.verdict && (
          <p className='text-[12.5px] text-slate-600 dark:text-muted-foreground'>
            Verdict{' '}
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] font-medium capitalize',
                VERDICT_TONE[run.verdict]
              )}
            >
              {run.verdict}
            </span>{' '}
            — the worst of its fault runs.
          </p>
        )}
      </div>
    </div>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='bg-white px-3.5 py-2.5 dark:bg-card'>
      <dt className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 text-[13px] font-medium text-slate-900 tabular-nums dark:text-foreground'>
        {children}
      </dd>
    </div>
  )
}

/**
 * Inline two-step confirm. Opening it moves focus to Keep (the safe answer); Keep or Escape
 * hands focus back to the button that opened it.
 */
function ConfirmInline({
  id,
  text,
  yes,
  danger,
  returnFocus,
  onYes,
  onNo
}: {
  id?: string
  text: string
  yes: string
  danger?: boolean
  returnFocus?: RefObject<HTMLElement | null>
  onYes: () => void
  onNo: () => void
}) {
  const keepRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    keepRef.current?.focus()
  }, [])
  const keep = () => {
    onNo()
    requestAnimationFrame(() => returnFocus?.current?.focus())
  }
  return (
    <fieldset
      id={id}
      aria-label={text}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          keep()
        }
      }}
      className='m-0 inline-flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0 text-[12px]'
    >
      <span className='text-slate-600 dark:text-muted-foreground'>{text}</span>
      {/* The answer pair never splits across lines. */}
      <span className='inline-flex items-center gap-1.5 whitespace-nowrap'>
        <button
          type='button'
          onClick={onYes}
          className={cn(
            btn,
            'h-7 px-2.5',
            danger
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
          )}
        >
          {yes}
        </button>
        <button
          ref={keepRef}
          type='button'
          onClick={keep}
          className={cn(
            btn,
            'h-7 px-2 font-normal text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
          )}
        >
          Keep
        </button>
      </span>
    </fieldset>
  )
}

const STATE: Record<string, { label: string; tone: string }> = {
  armed: { label: 'Armed', tone: 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300' },
  refused: {
    label: 'Refused',
    tone: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
  },
  ran: {
    label: 'Ran',
    tone: 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-foreground'
  },
  missed: {
    label: 'Missed',
    tone: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
  },
  announced: {
    label: 'Posted',
    tone: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
  },
  announce_failed: {
    label: 'Not posted',
    tone: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
  },
  checkpoint: {
    label: 'Reached',
    tone: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
  }
}

type InjectPhase = 'planned' | 'running' | 'ended'

/** A fault inject is live-armed while the day runs and its window has not closed. */
function armedNow(step: ChaosRunEvent | null | undefined, phase: InjectPhase, now: number) {
  if (phase !== 'running' || step?.data?.outcome !== 'armed') return false
  const secs = Number(step.data.seconds)
  return !Number.isFinite(secs) || Date.parse(step.at) + secs * 1000 > now
}

/** What an inject with no step yet says: nothing before the day, waiting during, and after it
 * ended the kind's own verb. */
const NOT_DONE: Record<GamedayInject['kind'], string> = {
  fault: 'Not armed',
  announce: 'Not posted',
  checkpoint: 'Not reached'
}
const unfired = (phase: InjectPhase, kind: GamedayInject['kind']) =>
  phase === 'running' ? 'Waiting' : phase === 'ended' ? NOT_DONE[kind] : null

function InjectRow({
  inj,
  step,
  phase,
  canFire,
  refused,
  gateNoteId,
  busy,
  now,
  onFire
}: {
  inj: GamedayInject
  step: ChaosRunEvent | null
  phase: InjectPhase
  canFire: boolean
  /** The gate's refusal, for a fault inject on a refused instance. */
  refused: string | null
  /** The header's visible "faults cannot be armed" line, for aria-describedby. */
  gateNoteId: string
  busy: boolean
  now: number
  onFire: () => void
}) {
  const [arming, setArming] = useState(false)
  const armRef = useRef<HTMLButtonElement>(null)
  const Icon = KIND_ICON[inj.kind]
  const raw = typeof step?.data?.outcome === 'string' ? step.data.outcome : null
  // Red only while the fault is still in its window; afterwards it simply ran.
  const outcome = raw === 'armed' && !armedNow(step, phase, now) ? 'ran' : raw
  const st = outcome ? STATE[outcome] : null
  const child = typeof step?.data?.child_run_id === 'string' ? step.data.child_run_id : null
  const reason = typeof step?.data?.reason === 'string' ? step.data.reason : null
  return (
    <li className='flex flex-wrap items-center gap-3 px-3 py-2 text-[12.5px]'>
      <span className='w-12 shrink-0 font-mono text-[12px] text-slate-500 tabular-nums dark:text-muted-foreground'>
        +{fmtOffset(inj.at_s)}
      </span>
      <Icon
        className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground'
        aria-hidden
      />
      <span className='min-w-0 flex-1 basis-[11rem]'>
        <span className='text-slate-900 dark:text-foreground'>{inj.label}</span>
        {inj.kind === 'fault' && inj.fault && (
          <span className='block font-mono text-[11.5px] break-all text-slate-500 sm:ml-2 sm:inline dark:text-muted-foreground'>
            {inj.fault.fault_key}
            {inj.fault.seconds ? ` · ${inj.fault.seconds}s` : ''}
          </span>
        )}
        {inj.kind === 'announce' && inj.text && (
          <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            “{inj.text}”
          </span>
        )}
      </span>
      {/* State, run link and action stay together; on a narrow row they wrap as one group. */}
      <span className='ml-auto flex shrink-0 items-center gap-3'>
        {st ? (
          <span
            data-tip={reason ?? undefined}
            className={cn('rounded px-1.5 py-0.5 text-[10.5px] font-medium', st.tone)}
          >
            {st.label}
            {step?.data?.manual ? ' by hand' : ''}
          </span>
        ) : unfired(phase, inj.kind) ? (
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {unfired(phase, inj.kind)}
          </span>
        ) : null}
        {child && (
          <Link
            to={`/chaos/runs/${child}`}
            className='text-[11.5px] text-slate-700 underline underline-offset-2 dark:text-foreground'
          >
            Open run
          </Link>
        )}
        {canFire && (
          <button
            ref={armRef}
            type='button'
            disabled={busy || !!refused}
            aria-describedby={refused ? gateNoteId : undefined}
            aria-expanded={inj.kind === 'fault' ? arming : undefined}
            onClick={() => (inj.kind === 'fault' ? setArming((a) => !a) : onFire())}
            className='h-7 rounded-md border border-slate-200 bg-white px-2 text-[11.5px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
          >
            {inj.kind === 'fault'
              ? 'Arm now'
              : inj.kind === 'announce'
                ? 'Post now'
                : 'Mark reached'}
          </button>
        )}
      </span>
      {canFire && arming && (
        <div className='flex basis-full justify-end'>
          <ConfirmInline
            text={`Arm it for ${inj.fault?.seconds ?? 60} s now?`}
            yes='Arm now'
            danger
            returnFocus={armRef}
            onYes={() => {
              setArming(false)
              onFire()
            }}
            onNo={() => setArming(false)}
          />
        </div>
      )}
    </li>
  )
}

/** The day as one horizontal track: injects as ticks, scribe marks above, "now" while running. */
function Track({
  injects,
  steps,
  notes,
  from,
  to,
  now
}: {
  injects: GamedayInject[]
  steps: Map<string, ChaosRunEvent>
  notes: ChaosRunEvent[]
  from: number
  to: number
  now: number | null
}) {
  const span = Math.max(1, to - from)
  const pct = (ms: number) => `${Math.min(100, Math.max(0, ((ms - from) / span) * 100))}%`
  const quarters = [0, 0.25, 0.5, 0.75, 1]
  // Decorative: the list below carries every inject and its state for assistive tech.
  return (
    <div
      aria-hidden
      className='rounded-lg border border-slate-200 bg-white px-4 pt-4 pb-6 dark:border-border dark:bg-card'
    >
      <div className='relative h-6'>
        <div className='absolute top-1/2 right-0 left-0 h-px bg-slate-200 dark:bg-border' />
        {quarters.slice(1, -1).map((q) => (
          <div
            key={q}
            className='absolute top-1 bottom-1 w-px bg-slate-100 dark:bg-border/60'
            style={{ left: `${q * 100}%` }}
          />
        ))}
        {now != null && now >= from && (
          <>
            <div
              className='absolute top-0 bottom-0 left-0 rounded-l bg-nvr-cyan/10 dark:bg-nvr-cyan/15'
              style={{ width: pct(now) }}
            />
            <div
              className='absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-nvr-cyan'
              style={{ left: pct(now) }}
            />
          </>
        )}
        <NoteMarkers notes={notes} from={from} to={to} />
        {injects.map((inj) => {
          const Icon = KIND_ICON[inj.kind]
          const step = steps.get(inj.id)
          const done = step?.data?.outcome
          const live = now != null && armedNow(step, 'running', now)
          return (
            <span
              key={inj.id}
              data-tip={`+${fmtOffset(inj.at_s)} ${inj.label}`}
              className={cn(
                'absolute top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-white dark:bg-card',
                live
                  ? 'border-red-300 text-red-600 dark:border-red-800 dark:text-red-400'
                  : done
                    ? 'border-slate-300 text-slate-500 dark:border-slate-600'
                    : 'border-slate-200 text-slate-400 dark:border-border'
              )}
              style={{ left: pct(from + inj.at_s * 1000) }}
            >
              <Icon className='h-3 w-3' aria-hidden />
            </span>
          )
        })}
      </div>
      <div className='relative mt-1 text-[10.5px] text-slate-500 tabular-nums dark:text-muted-foreground'>
        {quarters.map((q) => (
          <span
            key={q}
            className={cn(
              'absolute',
              q === 0 ? 'left-0' : q === 1 ? 'right-0' : '-translate-x-1/2',
              q !== 0 && q !== 1 && 'max-sm:hidden'
            )}
            style={q !== 0 && q !== 1 ? { left: `${q * 100}%` } : undefined}
          >
            +{fmtOffset((span * q) / 1000)}
          </span>
        ))}
      </div>
    </div>
  )
}

function describeEvent(e: ChaosRunEvent, injects: GamedayInject[]): string {
  const d = e.data ?? {}
  const inj = typeof d.inject_id === 'string' ? injects.find((i) => i.id === d.inject_id) : null
  if (e.kind === 'note') {
    const mark = d.mark as NoteMark | null
    const by = typeof d.by_name === 'string' ? d.by_name : 'Someone'
    const text = typeof d.text === 'string' ? d.text : ''
    return `${by}: ${mark ? MARK_LABEL[mark] : 'Note'}${text ? ` — ${text}` : ''}`
  }
  if (inj) {
    const what = `+${fmtOffset(inj.at_s)} ${inj.label}`
    switch (d.outcome) {
      case 'armed':
        return `${what} — armed for ${d.seconds ?? '?'} s`
      case 'refused':
        return `${what} — refused${typeof d.reason === 'string' ? `: ${d.reason}` : ''}`
      case 'missed':
        return `${what} — missed (the scheduler was more than ten minutes late)`
      case 'announced':
        return `${what} — posted to the channel`
      case 'announce_failed':
        return `${what} — could not be posted`
      case 'checkpoint':
        return `${what} — checkpoint reached`
      default:
        return what
    }
  }
  switch (d.phase) {
    case 'planned':
      return 'Planned; invitations sent'
    case 'started':
      return d.how === 'auto' ? 'Started by the scheduler' : 'Started'
    case 'revealed':
      return 'Revealed to everyone'
    case 'cancelled':
      return 'Cancelled'
    case 'start_refused':
      return `The automatic start was refused${typeof d.reason === 'string' ? `: ${d.reason}` : ''}`
    case 'ended':
      return `Ended (${String(d.how ?? '')})${d.verdict ? ` — verdict ${d.verdict}` : ''}`
  }
  if (e.kind === 'abort') return 'Aborted'
  return e.kind
}
