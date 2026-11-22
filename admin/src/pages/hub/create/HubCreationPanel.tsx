import { ConfirmButton, ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Circle, Copy, Loader2, Pause, RefreshCw, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { cn, formatRelative } from '@/lib/utils'
import { hubKeys } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SectionCard } from '../hub-parts'
import {
  type ChecklistItem,
  type CreationStepState,
  type CreationView,
  cancelCreation,
  checkCreation,
  confirmInstalled,
  createError,
  createKeys,
  createToast,
  creationPollMs,
  creationStatusWords,
  fetchCreation,
  type HubDatabaseLite,
  type HubDbCheck,
  noteWords,
  retryCreation,
  STEP_LABELS,
  STEP_ORDER,
  STEP_STATE_WORDS,
  saveDbConnection,
  WAIT_WORDS
} from './create-api'

/** Environment statuses a creation leaves while it is not finished. */
const CREATING_STATUSES = new Set(['provisioning', 'waiting_for_name'])

/**
 * One environment's creation (Hub phase 3): the eight steps with their notes, what it waits for
 * (a DBA's database, a hand-made hostname, the operator's deploy key) and what to do about it,
 * Check now / Retry / Cancel, and the run's log under Details. Renders nothing for an environment
 * that is not being created (or whose creation is done).
 */
export function HubCreationPanel({
  envId,
  envStatus,
  appId,
  isAdmin
}: {
  envId: number
  /** The environment's own status: only a creating one asks for its creation. */
  envStatus: string
  appId?: number
  isAdmin: boolean
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: createKeys.creation(envId),
    queryFn: () => fetchCreation(envId),
    enabled: CREATING_STATUSES.has(envStatus),
    retry: false,
    refetchInterval: (query) => creationPollMs(query.state.data?.status)
  })
  // The moment a leg finishes, the app's page reads the environment again (status, address).
  const last = useRef<string | undefined>(undefined)
  const status = q.data?.status
  useEffect(() => {
    if (status === 'done' && last.current && last.current !== 'done' && appId != null)
      void qc.invalidateQueries({ queryKey: hubKeys.app(appId) })
    last.current = status
  }, [status, appId, qc])

  if (!CREATING_STATUSES.has(envStatus) || !q.data || q.data.status === 'done') return null
  return <CreationBody view={q.data} isAdmin={isAdmin} onChanged={() => void q.refetch()} />
}

function CreationBody({
  view: v,
  isAdmin,
  onChanged
}: {
  view: CreationView
  isAdmin: boolean
  onChanged: () => void
}) {
  const envId = v.environment_id
  const check = useMutation({
    mutationFn: () => checkCreation(envId),
    onSuccess: (out) => {
      if (out.status === 'waiting') toast.message('Still waiting', { description: 'See the note.' })
      onChanged()
    },
    onError: (e) => createToast(e, 'Could not check now')
  })
  const retry = useMutation({
    mutationFn: () => retryCreation(envId),
    onSuccess: onChanged,
    onError: (e) => createToast(e, 'Could not retry')
  })
  const cancel = useMutation({
    mutationFn: () => cancelCreation(envId),
    onSuccess: onChanged,
    onError: (e) => createToast(e, 'Could not cancel')
  })

  const canRetry = isAdmin && ['failed', 'interrupted', 'cancelled'].includes(v.status)
  const canCancel = isAdmin && ['running', 'queued', 'waiting'].includes(v.status)
  const waitingStep = v.steps.find((s) => s.status === 'waiting') ?? null

  return (
    <SectionCard
      title={`Creating ${v.app_key}/${v.env_key}`}
      description={
        <>
          <span className={statusTone(v.status)}>{creationStatusWords(v.status)}</span>
          {v.status === 'waiting' && v.waiting_for ? ` · ${WAIT_WORDS[v.waiting_for]}` : ''}
          {` · Nivaro ${v.version}`}
          {v.base_url ? ` · ${v.base_url}` : ''}
        </>
      }
      actions={
        <>
          {v.status === 'waiting' && v.waiting_for !== 'operator' && (
            <button
              type='button'
              className={ghostButton}
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', check.isPending && 'animate-spin')}
                aria-hidden
              />
              Check now
            </button>
          )}
          {canRetry && (
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <RotateCcw className='h-3.5 w-3.5' aria-hidden /> Retry
            </Button>
          )}
          {canCancel && (
            <ConfirmButton
              title='Cancel creation'
              confirmLabel='Stop creating?'
              className={dangerGhost}
              armedClassName={dangerArmed}
              disabled={cancel.isPending}
              onConfirm={() => cancel.mutate()}
            >
              <X className='h-3.5 w-3.5' aria-hidden /> Cancel
            </ConfirmButton>
          )}
        </>
      }
    >
      <div className='space-y-4 px-4 py-3'>
        <StepTrack steps={v.steps} />

        {v.error && (
          <ErrorNotice
            description={{
              title: v.status === 'failed' ? 'This step failed' : 'Stopped',
              hint: v.error
            }}
            action={null}
          />
        )}
        {v.status === 'interrupted' && !v.error && (
          <p className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
            The Hub restarted while this ran. Retry picks up at the unfinished step.
          </p>
        )}
        {v.status === 'cancelled' && (
          <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
            Cancelled. What was already made stays; Retry continues from here.
          </p>
        )}

        {v.status === 'waiting' && v.waiting_for === 'database' && (
          <DatabaseWait view={v} isAdmin={isAdmin} onSaved={onChanged} />
        )}
        {v.status === 'waiting' && v.waiting_for === 'name' && (
          <NameWait view={v} step={waitingStep} />
        )}
        {v.status === 'waiting' && v.waiting_for === 'operator' && (
          <OperatorWait view={v} onInstalled={onChanged} />
        )}

        {v.redirect_uri && (
          <p className='m-0 flex flex-wrap items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
            <span>Add this redirect URI to the app registration in Entra:</span>
            <code className='break-all rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-800 dark:bg-muted dark:text-slate-200'>
              {v.redirect_uri}
            </code>
            <CopyButton value={v.redirect_uri} label='Copy redirect URI' />
          </p>
        )}

        <LogDetails view={v} />
      </div>
    </SectionCard>
  )
}

function statusTone(s: string) {
  if (s === 'failed') return 'font-medium text-red-700 dark:text-red-300'
  if (s === 'waiting' || s === 'interrupted')
    return 'font-medium text-amber-800 dark:text-amber-300'
  if (s === 'running' || s === 'queued') return 'font-medium text-sky-700 dark:text-sky-300'
  return 'font-medium'
}

// ─── Step track ───────────────────────────────────────────────────────────────

function StepIcon({ state }: { state: CreationStepState['status'] }) {
  if (state === 'done')
    return <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' aria-hidden />
  if (state === 'running')
    return (
      <Loader2 className='h-3.5 w-3.5 animate-spin text-sky-600 dark:text-sky-400' aria-hidden />
    )
  if (state === 'waiting')
    return <Pause className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400' aria-hidden />
  if (state === 'failed')
    return <X className='h-3.5 w-3.5 text-red-600 dark:text-red-400' aria-hidden />
  return <Circle className='h-3 w-3 text-slate-300 dark:text-slate-600' aria-hidden />
}

export function StepTrack({ steps }: { steps: CreationStepState[] }) {
  const byKey = new Map(steps.map((s) => [s.key, s]))
  return (
    <ol
      aria-label='Steps'
      className='m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-4'
    >
      {STEP_ORDER.map((key, i) => {
        const s = byKey.get(key) ?? { key, status: 'pending' as const, at: null, note: null }
        return (
          <li
            key={key}
            aria-label={`${STEP_LABELS[key]}: ${STEP_STATE_WORDS[s.status]}`}
            className={cn(
              'min-w-0 rounded-md border px-2.5 py-2',
              s.status === 'failed'
                ? 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30'
                : s.status === 'waiting'
                  ? 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30'
                  : 'border-slate-200 bg-white dark:border-border dark:bg-card'
            )}
          >
            <div className='flex items-center gap-1.5'>
              <span className='flex h-4 w-4 shrink-0 items-center justify-center'>
                <StepIcon state={s.status} />
              </span>
              <span className='min-w-0 truncate text-[12px] font-medium text-slate-800 dark:text-foreground'>
                {i + 1}. {STEP_LABELS[key]}
              </span>
            </div>
            {s.note && (
              <p className='m-0 mt-1 break-words text-[11px] leading-snug text-slate-600 dark:text-slate-300'>
                {noteWords(s.note)}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ─── Waits ────────────────────────────────────────────────────────────────────

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type='button'
      variant='outline'
      size='sm'
      aria-label={label}
      data-tip={label}
      className='h-7 shrink-0 gap-1 px-2 text-[11.5px]'
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => toast.error('Could not copy — select the text and copy it yourself.')
        )
      }}
    >
      {copied ? (
        <Check className='h-3 w-3' aria-hidden />
      ) : (
        <Copy className='h-3 w-3' aria-hidden />
      )}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function WaitBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className='space-y-3 rounded-md border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/60 dark:bg-amber-950/20'>
      <p className='m-0 text-[12px] font-semibold text-slate-900 dark:text-foreground'>{title}</p>
      {children}
    </div>
  )
}

/** A copyable block of text (a ticket, a key line, a config file). */
function CopyBlock({
  label,
  value,
  copyLabel
}: {
  label: string
  value: string
  copyLabel: string
}) {
  return (
    <div className='space-y-1'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='min-w-0 flex-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
          {label}
        </span>
        <CopyButton value={value} label={copyLabel} />
      </div>
      <pre className='m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-slate-200 bg-white px-2.5 py-2 font-mono text-[11px] text-slate-800 dark:border-border dark:bg-card dark:text-slate-200'>
        {value}
      </pre>
    </div>
  )
}

// merge: reuse DbaChecklist from databases/ (Task 11) in place of this small list.
function Checklist({ items }: { items: ChecklistItem[] }) {
  return (
    <ul aria-label='DBA checklist' className='m-0 list-none space-y-1.5 p-0'>
      {items.map((it) => (
        <li
          key={`${it.label}:${it.value}`}
          className='flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 dark:border-border dark:bg-card'
        >
          <span className='min-w-[120px] text-[12px] text-slate-600 dark:text-slate-300'>
            {it.label}
          </span>
          <code className='min-w-0 flex-1 break-all font-mono text-[12px] text-slate-900 dark:text-foreground'>
            {it.value}
          </code>
          <CopyButton value={it.value} label={`Copy ${it.label}`} />
          {it.note && (
            <span className='w-full text-[11px] text-slate-500 dark:text-muted-foreground'>
              {it.note}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function DatabaseWait({
  view,
  isAdmin,
  onSaved
}: {
  view: CreationView
  isAdmin: boolean
  onSaved: () => void
}) {
  const d = view.database
  return (
    <WaitBox title='Waiting for the database'>
      <p className='m-0 text-[12px] leading-relaxed text-slate-700 dark:text-slate-200'>
        This server is set up so a DBA makes databases by hand. Send them the list below; once the
        database and its login exist, enter the connection here. The Hub checks it is empty and that
        the login owns it, then carries on.
      </p>
      {view.checklist?.length ? <Checklist items={view.checklist} /> : null}
      {d?.last_check && <LastCheck check={d.last_check} />}
      {/* merge: with Task 11's DbConnectionForm, pass serverTls from the creation's database/server data (owners cannot read /db-servers). */}
      {d && <ConnectionForm db={d} lockPlace={!isAdmin} onSaved={onSaved} />}
    </WaitBox>
  )
}

function LastCheck({ check }: { check: HubDbCheck }) {
  return (
    <p className='m-0 text-[12px] text-slate-700 dark:text-slate-200'>
      <span className='font-medium'>
        Last check{check.at ? ` ${formatRelative(check.at)}` : ''}:
      </span>{' '}
      {check.text}
    </p>
  )
}

const SSL_OPTIONS = [
  { value: '', label: "Server's default" },
  { value: 'disable', label: 'Off' },
  { value: 'require', label: 'Required' },
  { value: 'verify-ca', label: 'Verify the authority' },
  { value: 'verify-full', label: 'Verify the authority and name' }
]

// merge: reuse DbConnectionForm (lockPlace) from databases/ (Task 11) in place of this form.
/**
 * The connection the DBA made. The password starts empty and is never filled from the Hub.
 * `lockPlace` (owners, ruling P3-24): host and port are the database's own server, read-only.
 */
export function ConnectionForm({
  db,
  lockPlace,
  onSaved
}: {
  db: HubDatabaseLite
  lockPlace: boolean
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const [host, setHost] = useState(db.host ?? '')
  const [port, setPort] = useState(db.port != null ? String(db.port) : '')
  const [database, setDatabase] = useState(db.database_name ?? '')
  const [user, setUser] = useState(db.login_name ?? '')
  const [password, setPassword] = useState('')
  const [ssl, setSsl] = useState('')
  const [failure, setFailure] = useState<unknown>(null)
  const [result, setResult] = useState<HubDbCheck | null>(null)
  const missing = !host.trim() || !database.trim() || !user.trim() || !password
  const portBad = port.trim() !== '' && !/^\d{1,5}$/.test(port.trim())

  const save = useMutation({
    mutationFn: () =>
      saveDbConnection(db.id, db.engine, {
        host: host.trim(),
        port: port.trim() ? Number(port.trim()) : null,
        database: database.trim(),
        user: user.trim(),
        password,
        ssl_mode: ssl || undefined
      }),
    onSuccess: (out) => {
      setFailure(null)
      setPassword('')
      setResult(out.check)
      void qc.invalidateQueries({ queryKey: createKeys.databases() })
      onSaved()
    },
    onError: (e) => {
      setPassword('')
      setFailure(e)
    }
  })

  const id = (f: string) => `hub-creation-db-${db.id}-${f}`
  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
        <Field
          id={id('host')}
          label='Host'
          hint={lockPlace ? "The database's server (only a Hub admin can change it)." : undefined}
        >
          <Input
            id={id('host')}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            readOnly={lockPlace}
            className={cn('h-8 font-mono text-[13px]', lockPlace && 'bg-slate-50 dark:bg-muted')}
          />
        </Field>
        <Field id={id('port')} label='Port' error={portBad ? 'A port number' : null}>
          <Input
            id={id('port')}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            readOnly={lockPlace}
            inputMode='numeric'
            placeholder="Engine's default"
            className={cn('h-8 font-mono text-[13px]', lockPlace && 'bg-slate-50 dark:bg-muted')}
          />
        </Field>
        <Field id={id('database')} label='Database'>
          <Input
            id={id('database')}
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field id={id('user')} label='Login'>
          <Input
            id={id('user')}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete='off'
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field id={id('password')} label='Password' hint='Sent once and stored sealed.'>
          <Input
            id={id('password')}
            type='password'
            autoComplete='new-password'
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field id={id('ssl')} label='TLS'>
          <SimpleSelect
            value={ssl}
            onChange={setSsl}
            options={SSL_OPTIONS}
            ariaLabel='TLS'
            className='h-8 text-[13px]'
          />
        </Field>
      </div>
      {failure != null && (
        <ErrorNotice description={createError(failure, 'Could not save the connection')} />
      )}
      {result && (
        <p
          role='status'
          className={cn(
            'm-0 text-[12px]',
            result.state === 'empty'
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-amber-800 dark:text-amber-300'
          )}
        >
          {result.text}
        </p>
      )}
      <Button
        size='sm'
        className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
        disabled={missing || portBad || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? 'Checking…' : 'Save and check'}
      </Button>
    </div>
  )
}

function NameWait({ view, step }: { view: CreationView; step: CreationStepState | null }) {
  return (
    <WaitBox title='Waiting for the hostname'>
      <p className='m-0 text-[12px] leading-relaxed text-slate-700 dark:text-slate-200'>
        This target makes hostnames by hand. Send the ticket below to whoever runs your DNS and
        certificates. The Hub looks every 5 minutes and carries on once{' '}
        {view.hostname ?? 'the name'} answers with Nivaro {view.version}.
      </p>
      {view.ticket && <CopyBlock label='Ticket' value={view.ticket} copyLabel='Copy ticket' />}
      {step?.note && (
        <p className='m-0 text-[12px] text-slate-700 dark:text-slate-200'>
          <span className='font-medium'>
            Last check{step.at ? ` ${formatRelative(step.at)}` : ''}:
          </span>{' '}
          {noteWords(step.note)}
        </p>
      )}
    </WaitBox>
  )
}

function OperatorWait({ view, onInstalled }: { view: CreationView; onInstalled: () => void }) {
  const installed = useMutation({
    mutationFn: () => confirmInstalled(view.environment_id),
    onSuccess: onInstalled,
    onError: (e) => createToast(e, 'Could not record that the key is installed')
  })
  const k = view.deploy_key
  return (
    <WaitBox title='Waiting for the deploy key to be installed'>
      <p className='m-0 text-[12px] leading-relaxed text-slate-700 dark:text-slate-200'>
        The swarm manager only runs deploys for apps it knows. Someone with access to the manager
        does this once for this app:
      </p>
      <ol className='m-0 list-decimal space-y-1 pl-5 text-[12px] text-slate-700 dark:text-slate-200'>
        <li>
          Add the line below to <code className='font-mono'>~deploy/.ssh/authorized_keys</code> on
          the manager.
        </li>
        <li>
          Save the key configuration below as{' '}
          <code className='font-mono'>{k?.key_conf_path ?? `the app's key file`}</code>.
        </li>
        <li>Press Installed. The Hub then runs the first deploy.</li>
      </ol>
      {k ? (
        <>
          <CopyBlock
            label='authorized_keys line'
            value={k.authorized_keys}
            copyLabel='Copy authorized_keys line'
          />
          <CopyBlock
            label={`Key configuration (${k.key_conf_path})`}
            value={k.key_conf}
            copyLabel='Copy key configuration'
          />
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            Key fingerprint {k.keyid}. Both are public: neither holds a secret.
          </p>
        </>
      ) : (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          The key is not made yet. Reload in a moment.
        </p>
      )}
      <Button
        size='sm'
        className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
        disabled={installed.isPending}
        onClick={() => installed.mutate()}
      >
        {installed.isPending ? 'Recording…' : 'Installed'}
      </Button>
    </WaitBox>
  )
}

function LogDetails({ view }: { view: CreationView }) {
  return (
    <details className='group rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <summary className='cursor-pointer select-none px-3 py-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-300'>
        Details
      </summary>
      {view.log.length === 0 ? (
        <p className='m-0 px-3 pb-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Nothing logged yet.
        </p>
      ) : (
        <ol className='m-0 max-h-64 list-none space-y-0.5 overflow-y-auto px-3 pb-2 font-mono text-[11px] leading-snug'>
          {view.log.map((l) => (
            <li
              key={l.seq}
              className={cn(
                'break-all',
                l.level === 'error'
                  ? 'text-red-700 dark:text-red-300'
                  : l.level === 'warn'
                    ? 'text-amber-800 dark:text-amber-300'
                    : 'text-slate-600 dark:text-slate-300'
              )}
            >
              <span className='text-slate-400 dark:text-slate-500'>
                {new Date(l.at).toLocaleTimeString()}{' '}
              </span>
              {l.line}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
