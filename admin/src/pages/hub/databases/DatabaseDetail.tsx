import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ClipboardCopy, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import { dangerArmed, dangerGhost, Field, SecretInput, SectionCard } from '../hub-parts'
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
  ENGINE_LABEL,
  ENGINE_PORT,
  type HubDatabaseFull,
  type HubDatabaseRow,
  SSL_LABEL,
  type SslMode,
  STATUS_LABEL,
  useDatabase,
  useDbServers
} from './db-api'

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

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type='button'
      data-tip={done ? 'Copied' : 'Copy'}
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true)
            window.setTimeout(() => setDone(false), 1500)
          })
          .catch(() => {})
      }}
      className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted'
    >
      {done ? (
        <Check className='h-3.5 w-3.5' aria-hidden />
      ) : (
        <ClipboardCopy className='h-3.5 w-3.5' aria-hidden />
      )}
    </button>
  )
}

/** What a DBA must create: one row per item, each with a copy button. */
export function DbaChecklist({ items }: { items: ChecklistItem[] }) {
  return (
    <SectionCard
      title='Checklist for the DBA'
      description='Create exactly this on the server. Give the login a password, then enter the connection below.'
    >
      <ul
        aria-label='DBA checklist'
        className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'
      >
        {items.map((it) => (
          <li key={it.label} className='flex items-start gap-2 px-4 py-2.5'>
            <div className='min-w-0 flex-1'>
              <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                {it.label}
              </p>
              <p className='m-0 break-words font-mono text-[12px] text-slate-900 dark:text-foreground'>
                {it.value}
              </p>
              {it.note && (
                <p className='m-0 mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {it.note}
                </p>
              )}
            </div>
            <CopyButton text={it.value} label={it.label} />
          </li>
        ))}
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
  lockPlace
}: {
  idp: string
  engine: DbEngine
  draft: ConnDraft
  set: (p: Partial<ConnDraft>) => void
  tried: boolean
  /** An owner may use only the row's own server: host and port are shown, not edited. */
  lockPlace?: boolean
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
          className='h-8 font-mono text-[13px]'
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
          className='h-8 font-mono text-[13px]'
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
      <Field id={`${idp}-ssl`} label='TLS'>
        <SimpleSelect
          value={draft.ssl}
          onChange={(v) => set({ ssl: v as SslMode | '' })}
          options={[
            { value: '', label: 'Engine default' },
            ...(Object.keys(SSL_LABEL) as SslMode[]).map((m) => ({ value: m, label: SSL_LABEL[m] }))
          ]}
          ariaLabel='TLS'
          className='h-8 text-[13px]'
          triggerProps={{ id: `${idp}-ssl` }}
        />
      </Field>
      {engine === 'mssql' && (
        <Field
          id={`${idp}-trust`}
          label='Trust the server certificate'
          hint='For a self-signed certificate.'
        >
          <Switch
            id={`${idp}-trust`}
            checked={draft.trust}
            onCheckedChange={(v) => set({ trust: v })}
            aria-label='Trust the server certificate'
          />
        </Field>
      )}
    </div>
  )
}

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
  onChecked
}: {
  row: HubDatabaseRow
  lockPlace?: boolean
  onChecked?: (check: DbCheck) => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<ConnDraft>({
    host: row.host,
    port: row.port != null ? String(row.port) : '',
    database: row.database_name,
    user: row.login_name ?? '',
    password: '',
    ssl: '',
    trust: false
  })
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [result, setResult] = useState<DbCheck | null>(null)
  const set = (p: Partial<ConnDraft>) => setDraft((d) => ({ ...d, ...p }))

  const save = useMutation({
    mutationFn: () =>
      api
        .put<{ check: DbCheck }>(`/hub/databases/${row.id}/connection`, connBody(row.engine, draft))
        .then((r) => r.data.check),
    onSuccess: (check) => {
      setFailure(null)
      setResult(check)
      set({ password: '' })
      void qc.invalidateQueries({ queryKey: dbKeys.database(row.id) })
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onChecked?.(check)
    },
    onError: (err) => setFailure(err)
  })

  return (
    <SectionCard
      title='Connection'
      description={`The database the DBA made on this ${ENGINE_LABEL[row.engine]} server. The Hub checks it before using it.`}
    >
      <div className='space-y-4 p-4'>
        <ConnectionFields
          idp={`hub-dbconn-${row.id}`}
          engine={row.engine}
          draft={draft}
          set={set}
          tried={tried}
          lockPlace={lockPlace}
        />
        {failure != null && (
          <ErrorNotice description={dbError(failure, 'Could not save the connection')} />
        )}
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
  const [failure, setFailure] = useState<unknown>(null)
  const set = (p: Partial<ConnDraft>) => setDraft((d) => ({ ...d, ...p }))
  const adopt = useMutation({
    mutationFn: () =>
      api
        .post<{ data: HubDatabaseRow }>('/hub/databases/adopt', {
          connection: connBody(engine, draft)
        })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      setFailure(null)
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onAdopted(d.id)
    },
    onError: (err) => setFailure(err)
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
              options={(Object.keys(ENGINE_LABEL) as DbEngine[]).map((e) => ({
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
        {failure != null && (
          <ErrorNotice description={dbError(failure, 'Could not adopt the database')} />
        )}
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
      api.post<{ data: DbCheck }>(`/hub/databases/${d.id}/check`, {}).then((r) => r.data.data),
    onSuccess: (c) => {
      setChecked(c)
      refresh()
    },
    onError: (err) => dbToast(err, 'Could not check the database')
  })
  const remove = useMutation({
    mutationFn: () =>
      api.delete(`/hub/databases/${d.id}`, { data: { confirm: typed, drop: mayDrop && drop } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onDeleted()
    },
    onError: (err) => dbToast(err, 'Could not delete the database')
  })

  const meta: Array<[string, string]> = [
    ['Engine', ENGINE_LABEL[d.engine]],
    ['Server', d.server_name ?? 'None (adopted)'],
    ['Address', `${d.host}${d.port ? `:${d.port}` : ''}`],
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
            d.status !== 'requested' && d.status !== 'dropping' ? (
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
                {d.status === 'requested'
                  ? 'Not checked yet — waiting for the DBA.'
                  : 'Not checked yet.'}
              </p>
            )}
          </div>
        </SectionCard>

        {d.status === 'requested' && d.checklist && d.checklist.length > 0 && (
          <DbaChecklist items={d.checklist} />
        )}

        {needsConnection && <DbConnectionForm row={d} onChecked={setChecked} />}

        <SectionCard
          title='Remove from the Hub'
          description={
            d.environment
              ? `Used by ${environmentWords(d)}; detach it there first.`
              : 'Detaching forgets the record; the database stays on the server.'
          }
        >
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
                    The Hub will delete this database and its login on the server. Everything in it
                    is lost and this cannot be undone.
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
        </SectionCard>
      </div>
    </div>
  )
}
