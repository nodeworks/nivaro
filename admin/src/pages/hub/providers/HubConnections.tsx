import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, KeyRound, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { fetchHubApp, fetchHubApps, hubKeys } from '../hub-api'
import {
  dangerArmed,
  dangerGhost,
  Field,
  ghostButton,
  SecretInput,
  SectionCard,
  ToneChip
} from '../hub-parts'
import { ChangesList, LinkedChange } from './ChangeView'
import {
  adoptResource,
  CONNECTION_STATUS_COPY,
  type ConnectionField,
  type ConnectionTest,
  connectionBody,
  connectionValues,
  deleteConnection,
  fetchChanges,
  fetchConnections,
  fetchProviderTypes,
  fetchUnmanaged,
  type HubConnection,
  isFullConnection,
  type Observed,
  type ProviderInfo,
  providerError,
  providerKeys,
  providerToast,
  type ResourceTypeInfo,
  saveConnection,
  statusWords,
  testConnection
} from './providers-api'

/**
 * Connections (Hub tab, administrators): one authenticated account per provider — a GitHub
 * organisation, an AWS account, a Vercel team. Credentials are sealed by the API and only ever
 * shown as a mask and a fingerprint; the form sends a secret only when one is typed. Test says
 * who the credentials are and what they may do; Unmanaged lists what the account holds that the
 * Hub does not manage yet, to adopt it. Owners' changes that cost money wait here for approval.
 */
export default function HubConnectionsTab() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin)
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Only administrators manage provider connections. Your app’s outside resources are on its
          page, under each environment.
        </p>
        <div className='w-full max-w-3xl text-left'>
          <LinkedChange isAdmin={false} />
        </div>
      </div>
    )
  return <HubConnections />
}

const PENDING = { status: ['pending_approval' as const] }

export function HubConnections() {
  const [picked, setPicked] = useState<number | 'new' | null>(null)
  const connections = useQuery({ queryKey: providerKeys.connections(), queryFn: fetchConnections })
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const pending = useQuery({
    queryKey: providerKeys.changes(PENDING),
    queryFn: () => fetchChanges(PENDING)
  })
  const full = (connections.data ?? []).filter(isFullConnection)
  const current = picked === 'new' ? null : (full.find((c) => c.id === picked) ?? null)
  const noProviders = types.data && types.data.providers.length === 0

  return (
    <section aria-label='Connections' className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description={
          <>
            A connection is one account at a provider the Hub may change things in for your apps.
            Each app is allowed the connections its owners may use, on the app’s page.
            {connections.data && (
              <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                {' '}
                {full.length} {full.length === 1 ? 'connection' : 'connections'}.
              </span>
            )}
          </>
        }
        actions={
          <button
            type='button'
            aria-pressed={picked === 'new'}
            className={cn(ghostButton, picked === 'new' && 'bg-accent')}
            disabled={!types.data || noProviders}
            onClick={() => setPicked('new')}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> New connection
          </button>
        }
      />

      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          <LinkedChange isAdmin />
          {(pending.data?.length ?? 0) > 0 && (
            <SectionCard
              title='Waiting for your approval'
              description='App owners asked for these because they cost money. Approve or decline each.'
            >
              <div className='px-4 py-3'>
                <ChangesList
                  filter={PENDING}
                  isAdmin
                  label='Changes waiting for approval'
                  empty={null}
                />
              </div>
            </SectionCard>
          )}

          {connections.isPending ? (
            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3'>
              {[0, 1].map((i) => (
                <Skeleton key={i} className='h-16 w-full' />
              ))}
            </div>
          ) : connections.isError ? (
            <QueryErrorState
              error={connections.error}
              what='the connections'
              onRetry={() => void connections.refetch()}
            />
          ) : full.length === 0 && picked !== 'new' ? (
            <div className='rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center dark:border-border'>
              <p className='m-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
                No connections yet
              </p>
              <p className='m-0 mx-auto mt-1 max-w-[56ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
                {noProviders
                  ? 'This Hub has no provider adapters installed.'
                  : 'Connect a GitHub organisation, an AWS account or another provider, then allow it for the apps that may use it.'}
              </p>
            </div>
          ) : (
            <ul className='m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3'>
              {full.map((c) => (
                <li key={c.id}>
                  <ConnectionCard
                    connection={c}
                    active={c.id === picked}
                    onSelect={() => setPicked(c.id === picked ? null : c.id)}
                  />
                </li>
              ))}
            </ul>
          )}

          {types.data && picked === 'new' ? (
            <ConnectionForm
              key='new'
              connection={null}
              providers={types.data.providers}
              onClose={() => setPicked(null)}
              onSaved={setPicked}
            />
          ) : types.data && current ? (
            <>
              <ConnectionForm
                key={current.id}
                connection={current}
                providers={types.data.providers}
                onClose={() => setPicked(null)}
                onSaved={setPicked}
              />
              <UnmanagedCard
                key={`u-${current.id}`}
                connection={current}
                provider={types.data.providers.find((p) => p.key === current.provider) ?? null}
              />
            </>
          ) : types.isError && picked != null ? (
            <ErrorNotice
              description={providerError(types.error, 'Could not read the providers')}
              onRetry={() => void types.refetch()}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}

function ConnectionCard({
  connection: c,
  active,
  onSelect
}: {
  connection: HubConnection
  active: boolean
  onSelect: () => void
}) {
  const s = CONNECTION_STATUS_COPY[c.status] ?? CONNECTION_STATUS_COPY.untested
  return (
    <button
      type='button'
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'w-full rounded-lg border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        active
          ? 'border-nvr-cyan/60 bg-accent'
          : 'border-slate-200 bg-white hover:bg-muted dark:border-border dark:bg-card'
      )}
    >
      <span className='flex items-center gap-2'>
        <span className='min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
          {c.name}
        </span>
        <ToneChip
          tone={s.tone}
          compact
          tip={c.last_test_at ? `Tested ${formatRelative(c.last_test_at)}` : 'Not tested yet'}
        >
          {s.label}
        </ToneChip>
      </span>
      <span className='mt-0.5 block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
        {c.provider_label}
        {c.description ? ` · ${c.description}` : ''}
      </span>
    </button>
  )
}

/** One connection field's input, by kind. Secrets: the mask keeps, typed replaces, empty removes. */
function ConnectionInput({
  field: f,
  id,
  value,
  onChange,
  stored
}: {
  field: ConnectionField
  id: string
  value: unknown
  onChange: (v: unknown) => void
  stored: boolean
}) {
  if (f.secret)
    return (
      <SecretInput
        id={id}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        stored={stored}
        placeholder={f.placeholder}
      />
    )
  switch (f.kind) {
    case 'boolean':
      return (
        <div className='flex h-8 items-center gap-2'>
          <Switch id={id} checked={value === true} onCheckedChange={(v) => onChange(v === true)} />
          <span className='text-[12px] text-slate-600 dark:text-slate-300'>
            {value === true ? 'On' : 'Off'}
          </span>
        </div>
      )
    case 'enum':
      return (
        <SimpleSelect
          value={String(value ?? '')}
          onChange={onChange}
          options={[...(f.required ? [] : [{ value: '', label: 'Not set' }]), ...(f.options ?? [])]}
          ariaLabel={f.label}
          className='h-8 bg-white text-left text-[13px] dark:bg-background'
          triggerProps={{ id }}
        />
      )
    case 'list': {
      const list = Array.isArray(value) ? (value as string[]) : []
      // A closed list (AWS regions): a box per value.
      if (f.options?.length)
        return (
          <fieldset
            id={id}
            aria-label={f.label}
            className='relative m-0 grid max-h-48 min-w-0 grid-cols-2 gap-x-3 gap-y-1.5 overflow-auto rounded-md border border-slate-200 p-2 sm:grid-cols-3 dark:border-border'
          >
            {f.options.map((o) => {
              const oid = `${id}-${o.value}`
              const on = list.includes(o.value)
              return (
                <span key={o.value} className='flex items-center gap-1.5'>
                  <Checkbox
                    id={oid}
                    checked={on}
                    onCheckedChange={(v) =>
                      onChange(v === true ? [...list, o.value] : list.filter((x) => x !== o.value))
                    }
                  />
                  <label
                    htmlFor={oid}
                    className='truncate text-[12px] text-slate-700 dark:text-slate-200'
                  >
                    {o.label}
                  </label>
                </span>
              )
            })}
          </fieldset>
        )
      return (
        <Input
          id={id}
          value={list.join(', ')}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(',')
                .map((x) => x.trim())
                .filter((x, i, a) => x !== '' || i === a.length - 1)
            )
          }
          placeholder={f.placeholder ?? 'Comma-separated'}
          spellCheck={false}
          className='h-8 font-mono text-[13px]'
        />
      )
    }
    case 'text':
      return (
        <Textarea
          id={id}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={f.placeholder}
          className='font-mono text-[12px]'
        />
      )
    default:
      return (
        <Input
          id={id}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          inputMode={f.kind === 'number' ? 'decimal' : undefined}
          placeholder={f.placeholder}
          spellCheck={false}
          className={cn('h-8 text-[13px]', f.kind === 'number' && 'font-mono tabular-nums')}
        />
      )
  }
}

export function ConnectionForm({
  connection,
  providers,
  onClose,
  onSaved
}: {
  connection: HubConnection | null
  providers: ProviderInfo[]
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const qc = useQueryClient()
  const [providerKey, setProviderKey] = useState(
    connection?.provider ?? (providers.length === 1 ? (providers[0]?.key ?? '') : '')
  )
  const provider = providers.find((p) => p.key === providerKey) ?? null
  const fields = provider?.connection.fields ?? []
  const [name, setName] = useState(connection?.name ?? '')
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    connectionValues(fields, connection)
  )
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [result, setResult] = useState<ConnectionTest | null>(null)
  const storedKeys = connection?.secret_keys ?? []
  const [saved, setSaved] = useState(() => JSON.stringify([name, values]))
  const dirty = JSON.stringify([name, values]) !== saved

  const missing = fields.filter((f) => {
    if (!f.required) return false
    const v = values[f.key]
    if (f.secret) return !(typeof v === 'string' && v !== '')
    return v === '' || v == null || (Array.isArray(v) && v.length === 0)
  })
  const nameMissing = !name.trim()
  const invalid = nameMissing || missing.length > 0 || !provider

  const save = useMutation({
    mutationFn: () => {
      const { config, secrets } = connectionBody(fields, values, storedKeys)
      return saveConnection(connection?.id ?? null, {
        ...(connection ? {} : { provider: providerKey }),
        name: name.trim(),
        config,
        ...(Object.keys(secrets).length ? { secrets } : {})
      })
    },
    onSuccess: (row) => {
      setFailure(null)
      const next = connectionValues(fields, row)
      setValues(next)
      setSaved(JSON.stringify([name, next]))
      setResult(null)
      void qc.invalidateQueries({ queryKey: providerKeys.connections() })
      onSaved(row.id)
    },
    onError: setFailure
  })
  const test = useMutation({
    mutationFn: () => testConnection(connection?.id ?? 0),
    onSuccess: (r) => {
      setResult(r)
      void qc.invalidateQueries({ queryKey: providerKeys.connections() })
    },
    onError: (e) => providerToast(e, 'Could not test the connection')
  })
  const remove = useMutation({
    mutationFn: () => deleteConnection(connection?.id ?? 0),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: providerKeys.connections() })
      onClose()
    },
    onError: (e) => providerToast(e, 'Could not delete the connection')
  })

  const id = (f: string) => `hub-conn-${connection?.id ?? 'new'}-${f}`
  const shownTest = result ?? connection?.last_test ?? null
  return (
    <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-start gap-3'>
        <div className='min-w-0 flex-1'>
          <h3 className='m-0 truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            {connection ? connection.name : 'New connection'}
          </h3>
          {connection?.secret_fingerprint && (
            <p className='m-0 mt-0.5 flex items-center gap-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
              <KeyRound className='h-3 w-3' aria-hidden />
              Credentials sealed · fingerprint{' '}
              <span className='font-mono'>{connection.secret_fingerprint.slice(0, 12)}</span>
              {connection.updated_at && (
                <span data-tip={formatDateTime(connection.updated_at)}>
                  · saved {formatRelative(connection.updated_at)}
                </span>
              )}
            </p>
          )}
        </div>
        {connection && (
          <ConfirmButton
            title='Delete connection'
            confirmLabel='Delete this connection?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
          </ConfirmButton>
        )}
      </div>

      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
        {!connection && (
          <Field
            id={id('provider')}
            label='Provider'
            error={tried && !provider ? 'Pick a provider' : null}
          >
            <SimpleSelect
              value={providerKey}
              onChange={(v) => {
                setProviderKey(v)
                const p = providers.find((x) => x.key === v)
                setValues(connectionValues(p?.connection.fields ?? [], null))
              }}
              options={[
                { value: '', label: 'Pick a provider' },
                ...providers.map((p) => ({ value: p.key, label: p.label }))
              ]}
              ariaLabel='Provider'
              className='h-8 text-left text-[13px]'
              triggerProps={{ id: id('provider') }}
            />
          </Field>
        )}
        <Field
          id={id('name')}
          label='Name'
          hint='How people pick it, e.g. "GitHub · nodeworks" or "AWS production".'
          error={tried && nameMissing ? 'Give the connection a name' : null}
        >
          <Input
            id={id('name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className='h-8 text-[13px]'
          />
        </Field>
        {fields.map((f) => {
          const stored = storedKeys.includes(f.key)
          const wide = f.kind === 'text' || (f.kind === 'list' && !!f.options?.length)
          return (
            <div key={f.key} className={cn(wide && 'sm:col-span-2')}>
              <Field
                id={id(f.key)}
                label={f.label}
                hint={
                  f.secret
                    ? stored
                      ? 'Stored sealed. Leave as is to keep it; clear it to remove it.'
                      : (f.help ?? 'Stored sealed; never shown again.')
                    : f.help
                }
                error={tried && missing.includes(f) ? 'Required' : null}
              >
                <ConnectionInput
                  field={f}
                  id={id(f.key)}
                  value={values[f.key]}
                  onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
                  stored={stored}
                />
              </Field>
            </div>
          )
        })}
      </div>

      {failure != null && (
        <ErrorNotice description={providerError(failure, 'Could not save the connection')} />
      )}
      {shownTest && connection && (
        <TestResult result={shownTest} at={result ? null : connection.last_test_at} stale={dirty} />
      )}

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={save.isPending}
          onClick={() => {
            setTried(true)
            if (!invalid) save.mutate()
          }}
        >
          {save.isPending ? 'Saving…' : connection ? 'Save' : 'Add connection'}
        </Button>
        {connection && (
          <Button
            size='sm'
            variant='outline'
            className='h-8'
            disabled={test.isPending || dirty}
            data-tip={dirty ? 'Save first: Test checks the saved settings' : undefined}
            onClick={() => test.mutate()}
          >
            {test.isPending ? 'Testing…' : 'Test'}
          </Button>
        )}
        {connection && dirty && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Save first: Test checks the saved settings.
          </span>
        )}
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          {connection ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}

function TestResult({
  result,
  at,
  stale
}: {
  result: ConnectionTest
  at: string | null
  stale: boolean
}) {
  return (
    <div
      role='status'
      className='space-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/40'
    >
      <p className='m-0 flex flex-wrap items-center gap-x-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
        {result.ok ? 'The connection works' : 'The connection needs fixing'}
        {at && (
          <span className='font-normal text-slate-500 dark:text-muted-foreground'>
            · tested {formatRelative(at)}
          </span>
        )}
        {stale && (
          <span className='font-normal text-amber-800 dark:text-amber-300'>
            · before your unsaved edits
          </span>
        )}
      </p>
      {result.identity && (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          Signed in as <span className='font-mono'>{result.identity}</span>
        </p>
      )}
      {result.message && (
        <p className='m-0 break-words text-[12px] text-slate-600 dark:text-slate-300'>
          {result.message}
        </p>
      )}
      {result.permissions.length > 0 && (
        <ul className='m-0 list-none space-y-0.5 p-0' aria-label='Permissions'>
          {result.permissions.map((p) => (
            <li key={`${p.type}:${p.need}`} className='flex items-start gap-1.5 text-[12px]'>
              {p.has ? (
                <Check
                  className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
                  aria-label='Has it'
                />
              ) : (
                <X
                  className='mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400'
                  aria-label='Missing'
                />
              )}
              <span className='min-w-0 break-words text-slate-700 dark:text-slate-200'>
                <span className='font-mono'>{p.need}</span>
                {p.type !== '*' && (
                  <span className='text-slate-500 dark:text-muted-foreground'> · {p.type}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * What the connection's account holds that the Hub does not manage, one kind at a time. Adopt
 * binds one to an app's environment (or to shared infrastructure) without changing it.
 */
function UnmanagedCard({
  connection,
  provider
}: {
  connection: HubConnection
  provider: ProviderInfo | null
}) {
  const adoptable = (provider?.types ?? []).filter((t) => t.capabilities.adopt)
  const [typeKey, setTypeKey] = useState(adoptable[0]?.key ?? '')
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const cursor = cursors[cursors.length - 1] ?? null
  const type = adoptable.find((t) => t.key === typeKey) ?? null
  // Asked for, never on open: listing reads the provider, which can be slow or rate-limited.
  const [look, setLook] = useState(false)
  const page = useQuery({
    queryKey: providerKeys.unmanaged(connection.id, typeKey, cursor),
    queryFn: () => fetchUnmanaged(connection.id, typeKey, cursor),
    enabled: look && !!typeKey,
    retry: false
  })
  const [adopting, setAdopting] = useState<string | null>(null)
  if (adoptable.length === 0) return null
  return (
    <SectionCard
      title='Not managed by the Hub'
      description='What this account holds that no app manages yet. Adopting one changes nothing at the provider.'
      actions={
        <SimpleSelect
          value={typeKey}
          onChange={(v) => {
            setTypeKey(v)
            setCursors([null])
            setAdopting(null)
          }}
          options={adoptable.map((t) => ({ value: t.key, label: t.label }))}
          ariaLabel='Kind of resource'
          className='h-8 w-[220px] max-w-full text-left text-[13px]'
        />
      }
    >
      <div className='px-4 py-3'>
        {!look ? (
          <div className='flex flex-wrap items-center gap-2'>
            <Button size='sm' variant='outline' className='h-8' onClick={() => setLook(true)}>
              List {type ? type.label.toLowerCase() : 'resources'}
            </Button>
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Reads the provider; nothing is changed.
            </span>
          </div>
        ) : page.isPending ? (
          <Skeleton className='h-10 w-full' />
        ) : page.isError ? (
          <ErrorNotice
            description={providerError(page.error, 'Could not list what the account holds')}
            onRetry={() => void page.refetch()}
          />
        ) : page.data.items.length === 0 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Nothing of this kind outside the Hub{cursors.length > 1 ? ' on this page' : ''}.
          </p>
        ) : (
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {page.data.items.map((item) => (
              <li key={item.externalId} className='py-1.5'>
                <UnmanagedRow
                  item={item}
                  open={adopting === item.externalId}
                  onToggle={() =>
                    setAdopting(adopting === item.externalId ? null : item.externalId)
                  }
                />
                {adopting === item.externalId && type && (
                  <AdoptForm
                    connectionId={connection.id}
                    type={type}
                    item={item}
                    onDone={() => {
                      setAdopting(null)
                      void page.refetch()
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {look && (cursors.length > 1 || page.data?.cursor) && (
          <div className='mt-2 flex gap-1'>
            {cursors.length > 1 && (
              <button
                type='button'
                className={ghostButton}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                Previous page
              </button>
            )}
            {page.data?.cursor && (
              <button
                type='button'
                className={ghostButton}
                onClick={() => setCursors((c) => [...c, page.data?.cursor ?? null])}
              >
                Next page
              </button>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

function UnmanagedRow({
  item,
  open,
  onToggle
}: {
  item: Observed
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
      <div className='min-w-0 flex-[1_1_220px]'>
        <p className='m-0 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {item.name ?? item.externalId}
        </p>
        {item.name && (
          <p className='m-0 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
            {item.externalId}
          </p>
        )}
      </div>
      {item.status && (
        <ToneChip tone='neutral' compact>
          {statusWords(item.status)}
        </ToneChip>
      )}
      <button
        type='button'
        aria-expanded={open}
        className={cn(ghostButton, 'ml-auto', open && 'bg-accent')}
        onClick={onToggle}
      >
        Adopt…
      </button>
    </div>
  )
}

function AdoptForm({
  connectionId,
  type,
  item,
  onDone
}: {
  connectionId: number
  type: ResourceTypeInfo
  item: Observed
  onDone: () => void
}) {
  const qc = useQueryClient()
  const shared = type.scope === 'shared'
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps, enabled: !shared })
  const [appId, setAppId] = useState('')
  const app = useQuery({
    queryKey: hubKeys.app(Number(appId) || 0),
    queryFn: () => fetchHubApp(Number(appId)),
    enabled: !!appId
  })
  const [envId, setEnvId] = useState('')
  const adopt = useMutation({
    mutationFn: () =>
      adoptResource(connectionId, {
        type: type.key,
        externalId: item.externalId,
        scope: shared ? 'shared' : 'app',
        ...(shared ? {} : { appId: Number(appId), environmentId: Number(envId) })
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hub-providers', 'resources'] })
      onDone()
    },
    onError: (e) => providerToast(e, 'Could not adopt it')
  })
  const base = `hub-adopt-${connectionId}-${item.externalId.replace(/[^a-zA-Z0-9-]/g, '-')}`
  const ready = shared || (!!appId && !!envId)
  return (
    <div className='mt-2 space-y-3 rounded-md border border-dashed border-slate-300 p-3 dark:border-border'>
      {shared ? (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          {type.label} is shared infrastructure: it is adopted for the whole connection, managed by
          Hub administrators.
        </p>
      ) : (
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <Field id={`${base}-app`} label='App'>
            <SimpleSelect
              value={appId}
              onChange={(v) => {
                setAppId(v)
                setEnvId('')
              }}
              options={[
                { value: '', label: apps.isPending ? 'Loading…' : 'Pick an app' },
                ...(apps.data ?? []).map((a) => ({ value: String(a.id), label: a.name }))
              ]}
              ariaLabel='App'
              className='h-8 text-left text-[13px]'
              triggerProps={{ id: `${base}-app` }}
            />
          </Field>
          <Field id={`${base}-env`} label='Environment'>
            <SimpleSelect
              value={envId}
              onChange={setEnvId}
              options={[
                { value: '', label: appId ? 'Pick an environment' : 'Pick an app first' },
                ...(app.data?.environments ?? [])
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((e) => ({ value: String(e.id), label: e.key }))
              ]}
              ariaLabel='Environment'
              disabled={!appId}
              className='h-8 text-left font-mono text-[13px]'
              triggerProps={{ id: `${base}-env` }}
            />
          </Field>
        </div>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!ready || adopt.isPending}
          onClick={() => adopt.mutate()}
        >
          {adopt.isPending ? 'Adopting…' : 'Adopt'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
