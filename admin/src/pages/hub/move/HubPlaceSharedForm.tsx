import { ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDatabases } from '../databases/db-api'
import { type HubEnvironment, hubKeys } from '../hub-api'
import { Field, ghostButton } from '../hub-parts'
import { sharedKeys } from '../shared/shared-api'
import { HubAppKeyField } from './HubAppKeyField'
import { MoveRunError, OptionCombobox } from './HubMovePanel'
import { fetchJobRun, moveError, moveKeys, placeShared, useSharedList } from './move-api'

/**
 * Nivaro Hub (phase 6) — place a NEW environment (one that never served) on a shared deployment:
 * the deployment, the database it gets (ready, used by no other environment), how many database
 * connections it may open there, and its first administrator. The Hub writes the placement at
 * once, then in the background asks every replica to take the app, waits for its migrations and
 * creates the administrator; the environment turns Active when that is done. An environment
 * that has served moves instead (Move…).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
const POOL_MIN = 2
const POOL_MAX = 20

/** Job run statuses that are still going. */
const RUN_LIVE = new Set(['running', 'queued', 'pending'])

export function HubPlaceSharedForm({
  appId,
  env,
  idPrefix,
  onClose,
  onBusy
}: {
  appId: number
  env: HubEnvironment
  idPrefix: string
  onClose: () => void
  /** The place request is out: the host keeps its row controls still. */
  onBusy?: (busy: boolean) => void
}) {
  const qc = useQueryClient()
  const shared = useSharedList()
  const databases = useDatabases()
  const [sharedId, setSharedId] = useState('')
  const [dbId, setDbId] = useState('')
  const [pool, setPool] = useState('5')
  const [email, setEmail] = useState('')
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [tried, setTried] = useState(false)
  const [refusal, setRefusal] = useState<{ code?: string; error: unknown } | null>(null)
  const [runId, setRunId] = useState<number | null>(null)

  const poolN = Number(pool)
  const poolBad = !Number.isInteger(poolN) || poolN < POOL_MIN || poolN > POOL_MAX
  const emailBad = !EMAIL_RE.test(email.trim())
  const picked = shared.data?.find((s) => String(s.id) === sharedId)

  const sharedOptions = (shared.data ?? [])
    .filter((s) => s.status !== 'retired')
    .map((s) => ({
      value: String(s.id),
      // Named as the move picker names it (design N9).
      label: `Shared · ${s.key}`,
      hint: [s.name, s.version_pin, s.status === 'active' ? null : s.status]
        .filter(Boolean)
        .join(' · ')
    }))
  const dbOptions = (databases.data ?? [])
    .filter((d) => d.status === 'ready' && (!d.environment || d.environment.id === env.id))
    .map((d) => ({
      value: String(d.id),
      label: d.database_name,
      hint:
        d.engine === 'sqlite'
          ? 'SQLite file · a shared deployment of size small only'
          : [d.server_name ?? d.host, d.engine].filter(Boolean).join(' · ')
    }))

  const place = useMutation({
    mutationFn: () =>
      placeShared(env.id, {
        shared_id: Number(sharedId),
        database_id: Number(dbId),
        pool_max: poolN,
        first_admin: {
          email: email.trim(),
          ...(first.trim() ? { first_name: first.trim() } : {}),
          ...(last.trim() ? { last_name: last.trim() } : {})
        }
      }),
    onSuccess: (r) => {
      setRefusal(null)
      setRunId(r.job_run_id)
      void qc.invalidateQueries({ queryKey: hubKeys.app(appId) })
      void qc.invalidateQueries({ queryKey: sharedKeys.list() })
    },
    onError: (err) => {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code
      setRefusal({ code, error: err })
    }
  })

  const ready = !!sharedId && !!dbId && !poolBad && !emailBad && !place.isPending
  const placing = place.isPending
  useEffect(() => onBusy?.(placing), [placing, onBusy])
  // biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only
  useEffect(() => () => onBusy?.(false), [])

  if (runId != null)
    return (
      <PlaceProgress
        runId={runId}
        appId={appId}
        envKey={env.key}
        sharedKey={picked?.key ?? 'the shared deployment'}
        onClose={onClose}
      />
    )

  return (
    <section
      aria-label={`Place ${env.key} on a shared deployment`}
      className='min-w-0 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4 dark:border-border dark:bg-muted/40'
    >
      <div className='flex items-center gap-2'>
        <h4 className='m-0 min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Place <span className='font-mono'>{env.key}</span> on a shared deployment
        </h4>
        <button
          type='button'
          aria-label='Close'
          className={ghostButton}
          disabled={place.isPending}
          onClick={onClose}
        >
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
        For an environment that has never served. The app runs inside the shared deployment's
        process with its own database and files; it turns Active once its database is ready and its
        first administrator exists.
      </p>

      {(shared.isError || databases.isError) && (
        <ErrorNotice
          description={moveError(shared.error ?? databases.error, 'Could not load the choices')}
          onRetry={() => {
            void shared.refetch()
            void databases.refetch()
          }}
        />
      )}

      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
        <Field
          id={`${idPrefix}-shared`}
          label='Shared deployment'
          error={tried && !sharedId ? 'Pick one' : null}
        >
          <OptionCombobox
            id={`${idPrefix}-shared`}
            label='Shared deployment'
            value={sharedId}
            onChange={setSharedId}
            options={sharedOptions}
            placeholder='Pick a shared deployment…'
            emptyText='No shared deployment yet'
          />
        </Field>
        <Field
          id={`${idPrefix}-db`}
          label='Database'
          hint='Ready databases no other environment uses.'
          error={tried && !dbId ? 'Pick one' : null}
        >
          <OptionCombobox
            id={`${idPrefix}-db`}
            label='Database'
            value={dbId}
            onChange={setDbId}
            options={dbOptions}
            placeholder='Pick a database…'
            emptyText='No ready database is free — add one on the Databases tab'
          />
        </Field>
        <Field
          id={`${idPrefix}-pool`}
          label='Database connections'
          hint='How many the app may open on the deployment (counts against its budget).'
          error={poolBad ? `Between ${POOL_MIN} and ${POOL_MAX}.` : null}
        >
          <Input
            id={`${idPrefix}-pool`}
            inputMode='numeric'
            value={pool}
            onChange={(e) => setPool(e.target.value)}
            className='h-8 max-w-[120px] bg-white font-mono text-[13px] dark:bg-background'
          />
        </Field>
        <Field
          id={`${idPrefix}-email`}
          label='First administrator email'
          hint='They sign in with it and get full rights in the app.'
          error={tried && emailBad ? 'Enter a valid email address' : null}
        >
          <Input
            id={`${idPrefix}-email`}
            type='email'
            autoComplete='off'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className='h-8 bg-white text-[13px] dark:bg-background'
          />
        </Field>
        <Field id={`${idPrefix}-first`} label='First name (optional)'>
          <Input
            id={`${idPrefix}-first`}
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            className='h-8 bg-white text-[13px] dark:bg-background'
          />
        </Field>
        <Field id={`${idPrefix}-last`} label='Last name (optional)'>
          <Input
            id={`${idPrefix}-last`}
            value={last}
            onChange={(e) => setLast(e.target.value)}
            className='h-8 bg-white text-[13px] dark:bg-background'
          />
        </Field>
      </div>

      {refusal && (
        <ErrorNotice description={moveError(refusal.error, `Could not place ${env.key}`)} />
      )}
      {refusal?.code === 'APP_KEY_UNKNOWN' && (
        <HubAppKeyField envId={env.id} idPrefix={`${idPrefix}-key`} />
      )}

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={place.isPending || poolBad}
          onClick={() => {
            setTried(true)
            if (ready) place.mutate()
          }}
        >
          {place.isPending ? 'Placing…' : 'Place on shared deployment'}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-8'
          disabled={place.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </section>
  )
}

/** The background run: polls its job run; the environment turns Active when it is done. */
function PlaceProgress({
  runId,
  appId,
  envKey,
  sharedKey,
  onClose
}: {
  runId: number
  appId: number
  envKey: string
  sharedKey: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const run = useQuery({
    queryKey: moveKeys.jobRun(runId),
    queryFn: () => fetchJobRun(runId),
    refetchInterval: (q) => {
      const s = q.state.data?.status
      if (q.state.status === 'error' && !q.state.data) return false
      return !s || RUN_LIVE.has(s) ? 4000 : false
    }
  })
  const status = run.data?.status
  const live = !status || RUN_LIVE.has(status)
  const failed = status === 'failed' || status === 'error' || status === 'cancelled'

  const wasLive = useRef(true)
  useEffect(() => {
    if (!status) return
    if (wasLive.current && !RUN_LIVE.has(status))
      void qc.invalidateQueries({ queryKey: hubKeys.app(appId) })
    wasLive.current = RUN_LIVE.has(status)
  }, [status, appId, qc])

  // The run's error is "CODE: sentence": the code maps to copy, the sentence shows under it.
  const errorText = run.data?.error ?? null

  return (
    <section
      aria-label={`Placing ${envKey}`}
      className='min-w-0 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4 dark:border-border dark:bg-muted/40'
    >
      <p
        role='status'
        className='m-0 flex items-center gap-2 text-[12px] text-slate-800 dark:text-foreground'
      >
        {live && (
          <Loader2
            className='h-3.5 w-3.5 animate-spin text-sky-600 dark:text-sky-400'
            aria-hidden
          />
        )}
        {live
          ? `Placing ${envKey} on ${sharedKey}. The deployment takes the app, migrates its database and creates its first administrator — usually a few minutes, at most about 12.`
          : failed
            ? `Placing ${envKey} on ${sharedKey} stopped.`
            : `${envKey} runs on ${sharedKey}.`}
      </p>
      {failed && (
        <div className='space-y-1 text-[12px] text-red-700 dark:text-red-300'>
          {/* Plain text shows as is; raw text (a stack, a driver error) becomes one plain
              sentence with the text under "Details for support". */}
          {errorText ? (
            <MoveRunError text={errorText} />
          ) : (
            <p className='m-0'>It stopped on an error.</p>
          )}
          <p className='m-0'>The environment stays new; place it again to retry.</p>
        </div>
      )}
      {run.isError && !run.data && (
        <ErrorNotice
          description={moveError(run.error, 'Could not read how the placement goes')}
          onRetry={() => void run.refetch()}
        />
      )}
      {!live && (
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          Close
        </Button>
      )}
    </section>
  )
}
