import { ConfirmButton, type ErrorDescription, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import { fetchHubApps, hubKeys, useHubApp } from '../hub-api'
import { CopyButton, dangerArmed, dangerGhost, Field, SecretInput, SectionCard } from '../hub-parts'
import {
  type ChecklistItem,
  type ConnectionInput,
  checkWords,
  DB_STATUS_TONE,
  type DbCheck,
  type DbEngine,
  type DbServer,
  dbError,
  dbKeys,
  dbToast,
  describeFailure,
  ENGINE_LABEL,
  ENGINE_PORT,
  type HubDatabaseFull,
  type HubDatabaseRow,
  SERVER_ENGINES,
  SSL_LABEL,
  type SslMode,
  STATUS_LABEL,
  useDatabase,
  useDbServers
} from './db-api'
import { attachEnvDatabase, detachEnvDatabase, EnvDbFailure, envDbError } from './env-db-api'

/** The Databases tab's right side for one database, and the forms an app's creation panel reuses. */

export function DbStatusChip({ status }: { status: HubDatabaseRow['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        DB_STATUS_TONE[status]
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}

/** Where a database is used, in words. */
export const environmentWords = (d: HubDatabaseRow): string =>
  d.environment ? `${d.environment.app_key}/${d.environment.env_key}` : 'Not attached'

/** Whether the Hub may drop this database and its login (it made both, on an automatic server). */
export function canDropDatabase(d: HubDatabaseRow, servers: DbServer[] | undefined): boolean {
  if (!d.created_by_hub || d.adopted || d.server_id === null) return false
  return servers?.find((s) => s.id === d.server_id)?.provision_mode === 'automatic'
}

/**
 * What a DBA must create: one row per item, each with a copy button — except the closing "Then"
 * row, which is an instruction (enter the connection), not a value to paste anywhere.
 */
export function DbaChecklist({ items }: { items: ChecklistItem[] }) {
  return (
    <SectionCard
      title='Checklist for the DBA'
      description='For the database administrator (DBA): create exactly this on the server and give the login a password. Then enter the connection below.'
    >
      <ul
        aria-label='DBA checklist'
        className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'
      >
        {items.map((it) => {
          const instruction = it.label === 'Then'
          return (
            <li key={it.label} className='flex items-start gap-2 px-4 py-2.5'>
              <div className='min-w-0 flex-1'>
                <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {it.label}
                </p>
                <p
                  className={cn(
                    'm-0 break-words text-[12px] text-slate-900 dark:text-foreground',
                    !instruction && 'font-mono'
                  )}
                >
                  {it.value}
                </p>
                {it.note && (
                  <p className='m-0 mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {it.note}
                  </p>
                )}
              </div>
              {!instruction && <CopyButton value={it.value} label={`Copy ${it.label}`} compact />}
            </li>
          )
        })}
      </ul>
    </SectionCard>
  )
}

/** A check in words: what it found, what to do, and the driver's text only behind a disclosure. */
export function CheckResult({ check, checkedAt }: { check: DbCheck; checkedAt?: string | null }) {
  const w = checkWords(check)
  return (
    <div
      role='status'
      className={cn(
        'rounded-lg border p-3 text-[12px]',
        w.good
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
      )}
    >
      <p className='m-0 font-medium'>{w.title}</p>
      {w.hint && <p className='m-0 mt-0.5'>{w.hint}</p>}
      <p className='m-0 mt-1 text-[11px] opacity-80'>
        {checkedAt || check.at
          ? `Checked ${formatRelative((checkedAt ?? check.at) as string)}`
          : ''}
        {check.version ? ` · ${check.version}` : ''}
        {check.migrations != null ? ` · ${check.migrations} migrations` : ''}
      </p>
      {check.text && !w.good && (
        <details className='mt-1.5'>
          <summary className='cursor-pointer'>Details for support</summary>
          <p className='m-0 mt-1 break-words font-mono text-[11px]'>{check.text}</p>
        </details>
      )}
    </div>
  )
}

interface ConnDraft {
  host: string
  port: string
  database: string
  user: string
  password: string
  ssl: SslMode | ''
  trust: boolean
}

const connBody = (engine: DbEngine, d: ConnDraft): ConnectionInput => ({
  engine,
  host: d.host.trim(),
  port: d.port.trim() === '' ? null : Number(d.port),
  database: d.database.trim(),
  user: d.user.trim(),
  password: d.password,
  ssl_mode: d.ssl || null,
  trust_server_cert: d.trust
})

function ConnectionFields({
  idp,
  engine,
  draft,
  set,
  tried,
  lockPlace,
  serverTls
}: {
  idp: string
  engine: DbEngine
  draft: ConnDraft
  set: (p: Partial<ConnDraft>) => void
  tried: boolean
  /** An owner may use only the row's own server: host and port are shown, not edited. */
  lockPlace?: boolean
  /** The server's own TLS, shown read-only to an owner (their own choice is ignored). */
  serverTls?: string
}) {
  const portNum = draft.port.trim() === '' ? null : Number(draft.port)
  const err = {
    host: draft.host.trim() ? '' : 'The host name or IP address',
    port:
      portNum === null || (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535)
        ? ''
        : 'A whole number from 1 to 65535',
    database: draft.database.trim() ? '' : 'The database name',
    user: draft.user.trim() ? '' : 'The login',
    password: draft.password ? '' : 'The login password'
  }
  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
      <Field
        id={`${idp}-host`}
        label='Host'
        error={tried ? err.host : null}
        hint={lockPlace ? "This database's server; it cannot be changed here." : undefined}
      >
        <Input
          id={`${idp}-host`}
          value={draft.host}
          readOnly={lockPlace}
          onChange={(e) => set({ host: e.target.value })}
          className={cn('h-8 font-mono text-[13px]', lockPlace && READ_ONLY)}
        />
      </Field>
      <Field
        id={`${idp}-port`}
        label='Port'
        error={tried ? err.port : null}
        hint={`Empty = ${ENGINE_PORT[engine]}`}
      >
        <Input
          id={`${idp}-port`}
          value={draft.port}
          readOnly={lockPlace}
          inputMode='numeric'
          onChange={(e) => set({ port: e.target.value })}
          className={cn('h-8 font-mono text-[13px]', lockPlace && READ_ONLY)}
        />
      </Field>
      <Field id={`${idp}-database`} label='Database' error={tried ? err.database : null}>
        <Input
          id={`${idp}-database`}
          value={draft.database}
          onChange={(e) => set({ database: e.target.value })}
          className='h-8 font-mono text-[13px]'
        />
      </Field>
      <Field id={`${idp}-user`} label='Login' error={tried ? err.user : null}>
        <Input
          id={`${idp}-user`}
          value={draft.user}
          autoComplete='off'
          spellCheck={false}
          onChange={(e) => set({ user: e.target.value })}
          className='h-8 font-mono text-[13px]'
        />
      </Field>
      <Field
        id={`${idp}-password`}
        label='Password'
        error={tried ? err.password : null}
        hint='Stored sealed; never shown again.'
      >
        <SecretInput
          id={`${idp}-password`}
          value={draft.password}
          onChange={(v) => set({ password: v })}
          stored={false}
        />
      </Field>
      <Field
        id={`${idp}-ssl`}
        label='TLS'
        hint={
          lockPlace
            ? "Whether the connection is encrypted. Set by this database's server; it cannot be changed here."
            : undefined
        }
      >
        {lockPlace ? (
          <Input
            id={`${idp}-ssl`}
            value={serverTls ?? 'Not reported yet'}
            readOnly
            className={cn('h-8 text-[13px]', READ_ONLY)}
          />
        ) : (
          <SimpleSelect
            value={draft.ssl}
            onChange={(v) => set({ ssl: v as SslMode | '' })}
            options={[
              { value: '', label: 'Engine default' },
              ...(Object.keys(SSL_LABEL) as SslMode[]).map((m) => ({
                value: m,
                label: SSL_LABEL[m]
              }))
            ]}
            ariaLabel='TLS'
            className='h-8 text-[13px]'
            triggerProps={{ id: `${idp}-ssl` }}
          />
        )}
      </Field>
      {engine === 'mssql' && !lockPlace && (
        <Field
          id={`${idp}-trust`}
          label='Trust the server certificate'
          hint='For a self-signed certificate.'
        >
          <div>
            <Switch
              id={`${idp}-trust`}
              checked={draft.trust}
              onCheckedChange={(v) => set({ trust: v })}
              aria-label='Trust the server certificate'
            />
          </div>
        </Field>
      )}
    </div>
  )
}

/** A field an owner sees but cannot change (ruling P3-24): muted, so it does not read as editable. */
const READ_ONLY =
  'cursor-default bg-slate-50 text-slate-600 focus-visible:ring-0 dark:bg-muted/40 dark:text-muted-foreground'

const connValid = (d: ConnDraft) => {
  const p = d.port.trim() === '' ? null : Number(d.port)
  return (
    !!d.host.trim() &&
    !!d.database.trim() &&
    !!d.user.trim() &&
    !!d.password &&
    (p === null || (Number.isInteger(p) && p >= 1 && p <= 65535))
  )
}

/**
 * The connection a DBA made for a requested database: Save and check. `lockPlace` is the owner's
 * view (ruling P3-24): host and port are the row's own server and cannot be changed.
 */
export function DbConnectionForm({
  row,
  lockPlace,
  serverTls,
  onChecked,
  clearPassword
}: {
  row: HubDatabaseRow
  lockPlace?: boolean
  /** The server's TLS in words (an owner sees it read-only). */
  serverTls?: string
  onChecked?: (check: DbCheck) => void
  /**
   * Bumped by a Check now elsewhere on the page: the typed password is cleared, the rest of an
   * unsaved draft stays (ruling P3-26).
   */
  clearPassword?: number
}) {
  const qc = useQueryClient()
  // Only a DBA-made (manual) row takes a connection, never a SQLite record (0.3.215).
  const engine = row.engine as DbEngine
  const [draft, setDraft] = useState<ConnDraft>({
    host: row.host,
    port: row.port != null ? String(row.port) : '',
    database: row.database_name,
    user: row.login_name ?? '',
    password: '',
    // An admin starts from the server's own TLS (ruling P3-29); an owner's is the server's anyway.
    ssl: row.server_tls?.ssl_mode ?? '',
    trust: row.server_tls?.trust_server_cert ?? false
  })
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const [result, setResult] = useState<DbCheck | null>(null)
  const set = (p: Partial<ConnDraft>) => setDraft((d) => ({ ...d, ...p }))
  useEffect(() => {
    if (clearPassword) setDraft((d) => (d.password ? { ...d, password: '' } : d))
  }, [clearPassword])

  const save = useMutation({
    mutationFn: () =>
      api
        .put<{ check: DbCheck }>(`/hub/databases/${row.id}/connection`, connBody(engine, draft))
        .then((r) => r.data.check)
        .catch(describeFailure('Could not save the connection', { owner: lockPlace })),
    onSuccess: (check) => {
      setFailure(null)
      setResult(check)
      set({ password: '' })
      void qc.invalidateQueries({ queryKey: dbKeys.database(row.id) })
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onChecked?.(check)
    },
    onError: (err) =>
      setFailure(dbError(err, 'Could not save the connection', { owner: lockPlace }))
  })

  return (
    <SectionCard
      title='Connection'
      description={`Where the DBA made the database (${ENGINE_LABEL[row.engine]}) and the login it uses. The Hub checks it before using it.`}
    >
      <div className='space-y-4 p-4'>
        <ConnectionFields
          idp={`hub-dbconn-${row.id}`}
          engine={engine}
          draft={draft}
          set={set}
          tried={tried}
          lockPlace={lockPlace}
          serverTls={serverTls}
        />
        {failure != null && <ErrorNotice description={failure} />}
        {result && <CheckResult check={result} />}
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={save.isPending}
          onClick={() => {
            setTried(true)
            if (connValid(draft)) save.mutate()
          }}
        >
          {save.isPending ? 'Checking…' : 'Save and check'}
        </Button>
      </div>
    </SectionCard>
  )
}

/** Adopt a database somebody made by hand: the Hub checks it, then records it. */
export function AdoptDatabaseForm({
  onAdopted,
  onCancel
}: {
  onAdopted: (id: number) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const [engine, setEngine] = useState<DbEngine>('mssql')
  const [draft, setDraft] = useState<ConnDraft>({
    host: '',
    port: '',
    database: '',
    user: '',
    password: '',
    ssl: '',
    trust: false
  })
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const set = (p: Partial<ConnDraft>) => setDraft((d) => ({ ...d, ...p }))
  const adopt = useMutation({
    mutationFn: () =>
      api
        .post<{ data: HubDatabaseRow; warning?: string }>('/hub/databases/adopt', {
          connection: connBody(engine, draft)
        })
        .then((r) => {
          // A database that already holds a Nivaro install is adopted, with a plain warning.
          if (r.data.warning)
            toast.warning('Adopted: it holds a Nivaro install', {
              description: r.data.warning
            })
          return r.data.data
        })
        .catch(describeFailure('Could not adopt the database')),
    onSuccess: (d) => {
      setFailure(null)
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onAdopted(d.id)
    },
    onError: (err) => setFailure(dbError(err, 'Could not adopt the database'))
  })
  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[760px] space-y-5'>
        <div>
          <h2 className='m-0 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            Adopt a database
          </h2>
          <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Record a database that already exists. The Hub checks it is empty or already Nivaro, and
            never drops it.
          </p>
        </div>
        <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <Field id='hub-adopt-engine' label='Engine'>
            <SimpleSelect
              value={engine}
              onChange={(v) => setEngine(v as DbEngine)}
              options={SERVER_ENGINES.map((e) => ({
                value: e,
                label: ENGINE_LABEL[e]
              }))}
              ariaLabel='Engine'
              className='h-8 text-[13px]'
              triggerProps={{ id: 'hub-adopt-engine' }}
            />
          </Field>
          <ConnectionFields idp='hub-adopt' engine={engine} draft={draft} set={set} tried={tried} />
        </div>
        {failure != null && <ErrorNotice description={failure} />}
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={adopt.isPending}
            onClick={() => {
              setTried(true)
              if (connValid(draft)) adopt.mutate()
            }}
          >
            {adopt.isPending ? 'Checking…' : 'Adopt'}
          </Button>
          <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

export function DatabaseDetail({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const q = useDatabase(id)
  const servers = useDbServers()
  if (q.isPending)
    return (
      <div className='space-y-3 p-6'>
        <Skeleton className='h-8 w-64' />
        <Skeleton className='h-32 w-full' />
      </div>
    )
  if (q.isError)
    return (
      <QueryErrorState
        error={q.error}
        what='this database'
        onRetry={() => void q.refetch()}
        className='m-6'
      />
    )
  return <DatabaseBody key={id} d={q.data} servers={servers.data} onDeleted={onDeleted} />
}

function DatabaseBody({
  d,
  servers,
  onDeleted
}: {
  d: HubDatabaseFull
  servers: DbServer[] | undefined
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const [drop, setDrop] = useState(false)
  const [checked, setChecked] = useState<DbCheck | null>(null)
  const [checks, setChecks] = useState(0)
  const manual = !d.created_by_hub && !d.adopted
  const needsConnection = manual && (d.status === 'requested' || d.status === 'failed')
  const mayDrop = canDropDatabase(d, servers)
  const last = checked ?? d.last_check

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: dbKeys.database(d.id) })
    void qc.invalidateQueries({ queryKey: dbKeys.databases() })
  }
  const check = useMutation({
    mutationFn: () =>
      api
        .post<{ data: DbCheck }>(`/hub/databases/${d.id}/check`, {})
        .then((r) => r.data.data)
        .catch(describeFailure('Could not check the database')),
    onSuccess: (c) => {
      setChecked(c)
      // A password typed in the connection form does not outlive a check; the rest of what was
      // typed there (not saved yet) stays.
      setChecks((k) => k + 1)
      refresh()
    },
    onError: (err) => dbToast(err, 'Could not check the database')
  })
  const remove = useMutation({
    mutationFn: () =>
      api
        .delete(`/hub/databases/${d.id}`, { data: { confirm: typed, drop: mayDrop && drop } })
        .catch(describeFailure('Could not delete the database')),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onDeleted()
    },
    onError: (err) => dbToast(err, 'Could not delete the database')
  })

  const sqlite = d.engine === 'sqlite'
  const meta: Array<[string, string]> = [
    ['Engine', ENGINE_LABEL[d.engine]],
    ['Server', sqlite ? 'None (a file)' : (d.server_name ?? 'None (adopted)')],
    [
      'Address',
      sqlite
        ? "The app's own folder on its shared deployment"
        : `${d.host}${d.port ? `:${d.port}` : ''}`
    ],
    ['Login', d.login_name ?? '—'],
    ['Used by', environmentWords(d)],
    ['Made by', d.adopted ? 'Adopted' : d.created_by_hub ? 'The Hub' : 'A DBA']
  ]
  const nameOk = typed === d.database_name

  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[760px] space-y-5'>
        <div className='flex flex-wrap items-center gap-3'>
          <h2 className='m-0 min-w-0 flex-1 truncate font-mono text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            {d.database_name}
          </h2>
          <DbStatusChip status={d.status} />
        </div>

        <dl className='m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 dark:border-border dark:bg-border'>
          {meta.map(([k, v]) => (
            <div key={k} className='bg-white px-3 py-2 dark:bg-card'>
              <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{k}</dt>
              <dd className='m-0 break-words text-[13px] text-slate-900 dark:text-foreground'>
                {v}
              </dd>
            </div>
          ))}
        </dl>

        <SectionCard
          title='Last check'
          actions={
            // Only once a connection is stored: before that there is nothing to check (P3-29).
            d.connection != null && d.status !== 'requested' && d.status !== 'dropping' ? (
              <Button
                size='sm'
                variant='outline'
                className='h-8'
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                {check.isPending ? 'Checking…' : 'Check now'}
              </Button>
            ) : undefined
          }
        >
          <div className='p-4'>
            {last ? (
              <CheckResult check={last} checkedAt={checked ? checked.at : d.checked_at} />
            ) : (
              <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                {sqlite
                  ? 'A SQLite database is a file its shared deployment keeps: the Hub has no connection to it. Place a new environment on a shared deployment of size small with it; the deployment makes the file and checks it then.'
                  : d.status === 'requested'
                    ? 'Not checked yet — waiting for the DBA.'
                    : 'Not checked yet.'}
              </p>
            )}
          </div>
        </SectionCard>

        {d.status === 'requested' && d.checklist && d.checklist.length > 0 && (
          <DbaChecklist items={d.checklist} />
        )}

        {needsConnection && (
          <DbConnectionForm row={d} onChecked={setChecked} clearPassword={checks} />
        )}

        {!sqlite && <EnvironmentAttach d={d} onChanged={refresh} />}

        <SectionCard
          title='Remove from the Hub'
          description={
            d.environment
              ? `Used by ${environmentWords(d)}. Detach it first (above), then remove it here.`
              : sqlite
                ? 'Detaching forgets the record; a file a deployment already made stays in its volume.'
                : 'Detaching forgets the record; the database stays on the server.'
          }
        >
          {d.environment ? null : (
            <div className='space-y-3 p-4'>
              <Field id={`hub-db-del-${d.id}`} label={`Type ${d.database_name} to confirm`}>
                <Input
                  id={`hub-db-del-${d.id}`}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete='off'
                  spellCheck={false}
                  className='h-8 font-mono text-[13px]'
                />
              </Field>
              {mayDrop && (
                <div className='space-y-1.5'>
                  <div className='flex items-center gap-2'>
                    <Switch
                      id={`hub-db-drop-${d.id}`}
                      checked={drop}
                      onCheckedChange={setDrop}
                      aria-label='Drop the database too'
                    />
                    <label
                      htmlFor={`hub-db-drop-${d.id}`}
                      className='text-[12px] font-medium text-slate-700 dark:text-foreground'
                    >
                      Drop the database too
                    </label>
                  </div>
                  {drop && (
                    <p className='m-0 text-[12px] text-red-700 dark:text-red-400'>
                      The Hub will delete this database and its login on the server. Everything in
                      it is lost and this cannot be undone.
                    </p>
                  )}
                </div>
              )}
              <ConfirmButton
                title={drop && mayDrop ? 'Drop database' : 'Detach database'}
                confirmLabel={drop && mayDrop ? 'Drop it for good?' : 'Detach it?'}
                className={dangerGhost}
                armedClassName={dangerArmed}
                disabled={!nameOk || remove.isPending}
                onConfirm={() => remove.mutate()}
              >
                <Trash2 className='h-3.5 w-3.5' aria-hidden /> {drop && mayDrop ? 'Drop' : 'Detach'}
              </ConfirmButton>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}

/**
 * Attach this record to an environment that already exists, or detach it (ruling P6-32): what an
 * app the Hub did not create needs before it can move onto a shared deployment.
 */
function EnvironmentAttach({ d, onChanged }: { d: HubDatabaseRow; onChanged: () => void }) {
  const qc = useQueryClient()
  const [appId, setAppId] = useState('')
  const [envId, setEnvId] = useState('')
  const [failure, setFailure] = useState<EnvDbFailure | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  // The environment an identity refusal was about (re-review FW3-I1): "Attach anyway" overrides
  // for that one environment only, and any new pick drops the refusal with it.
  const [refusedEnv, setRefusedEnv] = useState<number | null>(null)
  const apps = useQuery({
    queryKey: hubKeys.apps(),
    queryFn: fetchHubApps,
    enabled: picking && !d.environment && d.status === 'ready'
  })
  const app = useHubApp(appId ? Number(appId) : null)
  /** The environment's app page and any move plan on screen for it name its database record:
   *  both are read again (detach takes them from the record, before it changes). */
  const done = (env: { appId: number; envId: number } | null) => {
    setFailure(null)
    onChanged()
    if (!env) return
    void qc.invalidateQueries({ queryKey: hubKeys.app(env.appId) })
    void qc.invalidateQueries({ queryKey: ['hub', 'move-plan', env.envId] })
  }
  const closePicker = () => {
    setPicking(false)
    setAppId('')
    setEnvId('')
    setFailure(null)
    setRefusedEnv(null)
  }
  const fail = (err: unknown, fallback: string) =>
    setFailure(
      err instanceof EnvDbFailure ? err : new EnvDbFailure(envDbError(err, fallback), null)
    )
  const clearRefusal = () => {
    setFailure(null)
    setRefusedEnv(null)
  }
  const attach = useMutation({
    mutationFn: (v: { envId: number; appId: number; override?: boolean }) =>
      attachEnvDatabase(v.envId, d.id, v.override ? { override: true } : {}),
    onSuccess: (out, v) => {
      setWarning(out.warning)
      setPicking(false)
      setRefusedEnv(null)
      done({ appId: v.appId, envId: v.envId })
      toast.success(`Attached ${d.database_name}`)
    },
    onError: (err, v) => {
      fail(err, 'Could not attach the database')
      setRefusedEnv(v.envId)
    }
  })
  const attachPicked = () => {
    if (appId && envId) attach.mutate({ appId: Number(appId), envId: Number(envId) })
  }
  const detach = useMutation({
    mutationFn: (env: { appId: number; envId: number }) => detachEnvDatabase(env.envId),
    onSuccess: (_out, env) => {
      setWarning(null)
      done(env)
      toast.success(`Detached ${d.database_name}`)
    },
    onError: (err) => fail(err, 'Could not detach the database')
  })

  const notes = (
    <>
      {warning && (
        <p className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'>
          {warning}
        </p>
      )}
      {failure && <ErrorNotice description={failure.description} />}
      {failure?.check && <CheckResult check={failure.check} />}
      {failure?.description.code === 'DATABASE_IDENTITY_DIFFERS' &&
        refusedEnv !== null &&
        refusedEnv === Number(envId) && (
          // On a Docker stack the record becomes the stack's database on the next deploy: attach it
          // only when the administrator knows it is the same database (the Hub logs the override).
          <ConfirmButton
            title='Attach anyway'
            confirmLabel='It is the same database: attach?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={attach.isPending}
            onConfirm={() =>
              attach.mutate({ appId: Number(appId), envId: refusedEnv, override: true })
            }
          >
            Attach anyway
          </ConfirmButton>
        )}
    </>
  )

  if (d.environment)
    return (
      <SectionCard
        title='Environment'
        description={`Attached to ${environmentWords(d)}. Detaching keeps this record and the database; the environment then has no record.`}
      >
        <div className='space-y-3 p-4'>
          <ConfirmButton
            title='Detach from environment'
            confirmLabel={`Detach from ${environmentWords(d)}?`}
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={detach.isPending}
            onConfirm={() => {
              const env = d.environment
              if (env) detach.mutate({ appId: env.app_id, envId: env.id })
            }}
          >
            {detach.isPending ? 'Detaching…' : 'Detach from environment'}
          </ConfirmButton>
          {notes}
        </div>
      </SectionCard>
    )

  return (
    <SectionCard
      title='Environment'
      description='Not attached. For an app the Hub did not create: attach the record of the database it runs on, so it can move onto a shared deployment.'
    >
      <div className='space-y-3 p-4'>
        {d.status !== 'ready' ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Only a ready database can be attached.
          </p>
        ) : !picking ? (
          <Button size='sm' variant='outline' className='h-8' onClick={() => setPicking(true)}>
            Attach to environment…
          </Button>
        ) : (
          <div className='flex flex-wrap items-end gap-3'>
            <Field id={`hub-db-attach-app-${d.id}`} label='App'>
              <SimpleSelect
                value={appId}
                onChange={(v) => {
                  setAppId(v)
                  setEnvId('')
                  clearRefusal()
                }}
                ariaLabel='App'
                className='h-8 w-[200px] text-[13px]'
                disabled={apps.isPending}
                options={[
                  { value: '', label: apps.isPending ? 'Loading…' : 'Pick an app' },
                  ...(apps.data ?? []).map((a) => ({ value: String(a.id), label: a.name }))
                ]}
              />
            </Field>
            <Field id={`hub-db-attach-env-${d.id}`} label='Environment'>
              <SimpleSelect
                value={envId}
                onChange={(v) => {
                  setEnvId(v)
                  clearRefusal()
                }}
                ariaLabel='Environment'
                className='h-8 w-[180px] text-[13px]'
                disabled={!appId || app.isPending}
                options={[
                  { value: '', label: 'Pick an environment' },
                  ...(app.data?.environments ?? []).map((e) => ({
                    value: String(e.id),
                    label: e.key
                  }))
                ]}
              />
            </Field>
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={!envId || attach.isPending}
              onClick={attachPicked}
            >
              {attach.isPending ? 'Attaching…' : 'Attach to environment'}
            </Button>
            <Button
              size='sm'
              variant='outline'
              className='h-8'
              disabled={attach.isPending}
              onClick={closePicker}
            >
              Cancel
            </Button>
          </div>
        )}
        {apps.isError && <ErrorNotice error={apps.error} onRetry={() => void apps.refetch()} />}
        {notes}
      </div>
    </SectionCard>
  )
}
