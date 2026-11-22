import { ErrorNotice } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Eye, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { UserCombobox } from '@/components/user-combobox'
import type { User } from '@/lib/api'
import { cn } from '@/lib/utils'
import { dbKeys, ENGINE_LABEL, STATUS_LABEL, useDatabases, useDbServers } from '../databases/db-api'
import { HUB_MASK, hubKeys } from '../hub-api'
import { CopyButton, Field, ghostButton, SectionCard } from '../hub-parts'
import {
  appBlockers,
  automaticHostname,
  blockersForEnv,
  type CreateAppInput,
  type CreationBlocker,
  type CreationPlan,
  createBlockersOf,
  createError,
  createKeys,
  defaultDbNames,
  fetchTargets,
  isCreatableKey,
  previewPlan,
  startCreate,
  VERSION_RE
} from './create-api'

/** A control character (what the planner refuses in a secret). */
const hasControlChar = (v: string) =>
  [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

/** Milliseconds after the last change before the preview asks the Hub again. */
export const PLAN_DEBOUNCE_MS = 600
const MAX_ENVIRONMENTS = 6

interface EnvDraft {
  key: string
  dbMode: 'server' | 'existing'
  serverId: string
  databaseName: string
  loginName: string
  databaseId: string
  hostname: string
}

const emptyEnv = (key: string): EnvDraft => ({
  key,
  dbMode: 'server',
  serverId: '',
  databaseName: '',
  loginName: '',
  databaseId: '',
  hostname: ''
})

const DB_MODE_OPTIONS = [
  { value: 'server', label: 'New database on a server' },
  { value: 'existing', label: 'A database the Hub already has' }
]

const DB_MODE_WORDS = {
  automatic: 'The Hub creates it',
  manual: 'A DBA creates it (you get a checklist)',
  existing: 'An existing database'
}

/**
 * Create app (Apps hub, administrators): a new dedicated app made by the Hub — its deploy
 * repository from the target's template, a database per environment, its secrets, a first deploy,
 * hostnames, the Hub link and a first administrator. The preview asks the Hub what it would do
 * (600 ms after the last change, or on demand); Create is offered only while the preview of
 * exactly this form has no blockers.
 */
export function HubCreateApp({
  onDone,
  onCancel
}: {
  onDone: (appId: number) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const targets = useQuery({ queryKey: createKeys.targets(), queryFn: fetchTargets })
  // The Databases tab's reads and keys: a save on either screen refreshes both.
  const servers = useDbServers()
  const databases = useDatabases()

  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [owners, setOwners] = useState<Array<{ id: string; label: string }>>([])
  const [targetId, setTargetId] = useState('')
  const [version, setVersion] = useState('')
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [envs, setEnvs] = useState<EnvDraft[]>([emptyEnv('staging'), emptyEnv('production')])
  const [adminEmail, setAdminEmail] = useState('')
  const [adminFirst, setAdminFirst] = useState('')
  const [adminLast, setAdminLast] = useState('')
  const [touched, setTouched] = useState(false)

  const target = targets.data?.find((t) => String(t.id) === targetId) ?? null
  const manual = target?.config.dns_mode === 'manual'

  const input: CreateAppInput = useMemo(
    () => ({
      key: key.trim(),
      name: name.trim(),
      owners: owners.map((o) => o.id),
      first_admin: {
        email: adminEmail.trim(),
        ...(adminFirst.trim() ? { first_name: adminFirst.trim() } : {}),
        ...(adminLast.trim() ? { last_name: adminLast.trim() } : {})
      },
      target_id: Number(targetId) || 0,
      version: version.trim(),
      signin: { issuer: issuer.trim(), client_id: clientId.trim(), client_secret: clientSecret },
      environments: envs.map((e) => ({
        key: e.key.trim(),
        ...(manual && e.hostname.trim() ? { hostname: e.hostname.trim() } : {}),
        database:
          e.dbMode === 'existing'
            ? { database_id: Number(e.databaseId) || 0 }
            : {
                server_id: Number(e.serverId) || 0,
                ...(e.databaseName.trim() ? { database_name: e.databaseName.trim() } : {}),
                ...(e.loginName.trim() ? { login_name: e.loginName.trim() } : {})
              }
      }))
    }),
    [
      key,
      name,
      owners,
      adminEmail,
      adminFirst,
      adminLast,
      targetId,
      version,
      issuer,
      clientId,
      clientSecret,
      envs,
      manual
    ]
  )
  // What a preview sends: the form with the client secret replaced by the mask. The planner only
  // checks that a secret is there; the secret itself goes out once, with Create.
  const previewInput: CreateAppInput = useMemo(
    () => ({
      ...input,
      signin: { ...input.signin, client_secret: input.signin.client_secret ? HUB_MASK : '' }
    }),
    [input]
  )
  // The form's identity: a preview counts only for exactly this form. Held in memory only.
  const sig = useMemo(() => JSON.stringify(previewInput), [previewInput])

  // ── preview ──
  const [plan, setPlan] = useState<{ sig: string; plan: CreationPlan } | null>(null)
  const [planFailure, setPlanFailure] = useState<unknown>(null)
  const [planning, setPlanning] = useState(false)
  const latest = useRef(sig)
  latest.current = sig
  const inputRef = useRef(previewInput)
  inputRef.current = previewInput

  const runPreview = useCallback(() => {
    const asked = latest.current
    setPlanning(true)
    previewPlan(inputRef.current).then(
      (p) => {
        if (latest.current !== asked) return
        setPlan({ sig: asked, plan: p })
        setPlanFailure(null)
        setPlanning(false)
      },
      (err) => {
        if (latest.current !== asked) return
        setPlanFailure(err)
        setPlanning(false)
      }
    )
  }, [])

  useEffect(() => {
    if (!touched || !sig) return
    const t = window.setTimeout(runPreview, PLAN_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [sig, touched, runPreview])

  const touch =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setTouched(true)
      setter(v)
    }
  const setEnv = (i: number, patch: Partial<EnvDraft>) => {
    setTouched(true)
    setEnvs((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  }
  const moveEnv = (i: number, by: -1 | 1) => {
    setTouched(true)
    setEnvs((all) => {
      const j = i + by
      if (j < 0 || j >= all.length) return all
      const out = [...all]
      ;[out[i], out[j]] = [out[j], out[i]]
      return out
    })
  }

  // ── what the form itself can tell before the Hub is asked ──
  const local = {
    key:
      key.trim() && !isCreatableKey(key.trim())
        ? 'Lower-case letters, digits and single dashes'
        : '',
    version: version.trim() && !VERSION_RE.test(version.trim()) ? 'A version like 0.3.210' : '',
    hostnames: envs.map((e) =>
      manual && !e.hostname.trim() ? 'Enter the hostname you will request' : ''
    ),
    // The preview never sees the secret, so the form checks what the planner would.
    secret:
      clientSecret && !clientSecret.trim()
        ? 'Type the client secret'
        : clientSecret.length > 1000 || hasControlChar(clientSecret)
          ? 'One line, at most 1000 characters'
          : ''
  }
  const localProblem =
    !!local.key || !!local.version || !!local.secret || local.hostnames.some(Boolean) || !targetId

  const fresh = plan?.sig === sig ? plan.plan : null
  const blockers = fresh?.blockers ?? plan?.plan.blockers ?? []
  // Rows show only the blockers of a preview of exactly this form: after a change (a reorder
  // shifts "environment N"), an older preview's blockers could point at the wrong row.
  const rowBlockers = fresh?.blockers ?? []
  const envKeys = envs.map((e) => e.key)

  // ── create ──
  const [creating, setCreating] = useState(false)
  const [createFailure, setCreateFailure] = useState<unknown>(null)
  const canCreate =
    !!fresh && fresh.ok && fresh.blockers.length === 0 && !localProblem && !planning && !creating
  const create = async () => {
    if (!canCreate) return
    setCreating(true)
    setCreateFailure(null)
    try {
      const out = await startCreate(input)
      await qc.invalidateQueries({ queryKey: hubKeys.apps() })
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onDone(out.app_id)
    } catch (err) {
      const found = createBlockersOf(err)
      if (found.length && plan)
        setPlan({ sig, plan: { ...(fresh ?? plan.plan), ok: false, blockers: found } })
      else setCreateFailure(err)
    } finally {
      setCreating(false)
    }
  }

  const ownerLabel = (id: string) => {
    for (const [, data] of qc.getQueriesData<User[]>({ queryKey: ['users'] })) {
      const u = Array.isArray(data) ? data.find((x) => x.id === id) : undefined
      if (u) return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
    }
    return id
  }

  const freeDatabases = (databases.data ?? []).filter((d) => !d.environment)
  const serverOptions = [
    { value: '', label: 'Pick a server' },
    ...(servers.data ?? []).map((s) => ({
      value: String(s.id),
      label: `${s.name} · ${ENGINE_LABEL[s.engine]} · ${s.provision_mode === 'automatic' ? 'the Hub creates databases' : 'a DBA creates databases'}`
    }))
  ]
  const databaseOptions = [
    { value: '', label: 'Pick a database' },
    ...freeDatabases.map((d) => ({
      value: String(d.id),
      label: `${d.database_name} on ${d.server_name ?? d.host} · ${STATUS_LABEL[d.status]}`
    }))
  ]
  const targetOptions = [
    { value: '', label: 'Pick a target' },
    ...(targets.data ?? []).map((t) => ({
      value: String(t.id),
      label: `${t.name} · ${t.config.namespace}${t.config.dns_mode === 'manual' ? ' · names by hand' : ''}`
    }))
  ]

  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[960px] space-y-5'>
        <div>
          <h2 className='m-0 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            Create an app
          </h2>
          <p className='m-0 mt-1 max-w-[72ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
            The Hub makes a deploy repository from the target's template, a database per
            environment, their secrets, a first deploy, the hostnames and the first administrator.
            The preview below says exactly what it will do before anything is made.
          </p>
        </div>

        <SectionCard title='App'>
          <div className='grid grid-cols-1 gap-3 p-4 sm:grid-cols-2'>
            <Field
              id='hub-create-key'
              label='Key'
              hint='Short and permanent, e.g. orders. Names the repository and hostnames.'
              error={local.key || null}
            >
              <Input
                id='hub-create-key'
                value={key}
                onChange={(e) => touch(setKey)(e.target.value)}
                placeholder='orders'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field id='hub-create-name' label='Name'>
              <Input
                id='hub-create-name'
                value={name}
                onChange={(e) => touch(setName)(e.target.value)}
                placeholder='Orders'
                className='h-8 text-[13px]'
              />
            </Field>
            <div className='sm:col-span-2'>
              <Field id='hub-create-owners' label='Owners' hint='Owners see the app in the Hub.'>
                <div className='flex flex-wrap items-center gap-2'>
                  {owners.map((o) => (
                    <span
                      key={o.id}
                      className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pr-1 pl-2.5 text-[12px] text-slate-700 dark:border-border dark:bg-muted dark:text-slate-200'
                    >
                      {o.label}
                      <button
                        type='button'
                        aria-label={`Remove ${o.label}`}
                        className='inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:text-muted-foreground dark:hover:bg-slate-700 dark:hover:text-foreground'
                        onClick={() => touch(setOwners)(owners.filter((x) => x.id !== o.id))}
                      >
                        <X className='h-3 w-3' aria-hidden />
                      </button>
                    </span>
                  ))}
                  <div className='w-full max-w-[280px]'>
                    <UserCombobox
                      value={null}
                      onChange={(id) => {
                        if (id && !owners.some((o) => o.id === id))
                          touch(setOwners)([...owners, { id, label: ownerLabel(id) }])
                      }}
                      placeholder='Add an owner'
                      searchServer
                      hideNone
                      className='h-8'
                    />
                  </div>
                </div>
              </Field>
            </div>
          </div>
        </SectionCard>

        <SectionCard title='Where and which version'>
          <div className='grid grid-cols-1 gap-3 p-4 sm:grid-cols-2'>
            <Field
              id='hub-create-target'
              label='Target'
              hint={
                targets.data?.length === 0
                  ? 'No targets yet: add one on the Targets tab.'
                  : target
                    ? target.config.dns_mode === 'manual'
                      ? 'Hostnames are requested by hand on this target.'
                      : `Hostnames are made under ${target.config.wildcard_domain}.`
                    : 'Where the deploy repository is made and deployed from.'
              }
            >
              <SimpleSelect
                value={targetId}
                onChange={touch(setTargetId)}
                options={targetOptions}
                ariaLabel='Target'
                className='h-8 text-[13px]'
                triggerProps={{ id: 'hub-create-target' }}
              />
            </Field>
            <Field
              id='hub-create-version'
              label='Version'
              hint='The Nivaro release every environment starts on.'
              error={local.version || null}
            >
              <Input
                id='hub-create-version'
                value={version}
                onChange={(e) => touch(setVersion)(e.target.value)}
                placeholder='0.3.210'
                inputMode='decimal'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          </div>
          {targets.isError && (
            <div className='px-4 pb-3'>
              <ErrorNotice
                description={createError(targets.error, 'Could not load the targets')}
                onRetry={() => void targets.refetch()}
              />
            </div>
          )}
        </SectionCard>

        <SectionCard
          title='Sign-in'
          description='The Microsoft Entra app registration people sign in with.'
        >
          <div className='grid grid-cols-1 gap-3 p-4 sm:grid-cols-2'>
            <Field id='hub-create-issuer' label='Issuer'>
              <Input
                id='hub-create-issuer'
                value={issuer}
                onChange={(e) => touch(setIssuer)(e.target.value)}
                placeholder='https://login.microsoftonline.com/<tenant>/v2.0'
                inputMode='url'
                className='h-8 text-[13px]'
              />
            </Field>
            <Field id='hub-create-client' label='Client ID'>
              <Input
                id='hub-create-client'
                value={clientId}
                onChange={(e) => touch(setClientId)(e.target.value)}
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field
              id='hub-create-secret'
              label='Client secret'
              hint='Stored sealed and sent to each environment when you press Create; never shown again.'
              error={local.secret || null}
            >
              <Input
                id='hub-create-secret'
                type='password'
                autoComplete='new-password'
                spellCheck={false}
                value={clientSecret}
                onChange={(e) => touch(setClientSecret)(e.target.value)}
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard
          title='Environments'
          description='In promotion order: each one is promoted from the one above it.'
          actions={
            envs.length < MAX_ENVIRONMENTS && (
              <button
                type='button'
                className={ghostButton}
                onClick={() => {
                  setTouched(true)
                  setEnvs((all) => [...all, emptyEnv('')])
                }}
              >
                <Plus className='h-3.5 w-3.5' aria-hidden /> Add environment
              </button>
            )
          }
        >
          <ol className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {envs.map((e, i) => {
              const mine = blockersForEnv(rowBlockers, e.key, i)
              const planned = fresh?.environments.find((p) => p.position === i)
              const names = defaultDbNames(key.trim() || '<app>', e.key.trim() || '<env>')
              const auto =
                !manual && target
                  ? (planned?.hostname ??
                    automaticHostname(target.config.wildcard_domain, key.trim(), e.key.trim()))
                  : null
              const id = (f: string) => `hub-create-env-${i}-${f}`
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until created; order is the promotion order
                  key={i}
                  aria-label={`Environment ${i + 1}${e.key.trim() ? `: ${e.key.trim()}` : ''}`}
                  className='space-y-3 px-4 py-3'
                >
                  <div className='flex flex-wrap items-end gap-2'>
                    <div className='min-w-[160px] flex-1'>
                      <Field id={id('key')} label={`Environment ${i + 1} key`}>
                        <Input
                          id={id('key')}
                          value={e.key}
                          onChange={(ev) => setEnv(i, { key: ev.target.value })}
                          placeholder='production'
                          className='h-8 font-mono text-[13px]'
                        />
                      </Field>
                    </div>
                    <div className='flex items-center gap-1'>
                      <button
                        type='button'
                        className={ghostButton}
                        aria-label='Move up'
                        data-tip='Move up'
                        disabled={i === 0}
                        onClick={() => moveEnv(i, -1)}
                      >
                        <ArrowUp className='h-3.5 w-3.5' aria-hidden />
                      </button>
                      <button
                        type='button'
                        className={ghostButton}
                        aria-label='Move down'
                        data-tip='Move down'
                        disabled={i === envs.length - 1}
                        onClick={() => moveEnv(i, 1)}
                      >
                        <ArrowDown className='h-3.5 w-3.5' aria-hidden />
                      </button>
                      {envs.length > 1 && (
                        <button
                          type='button'
                          className={ghostButton}
                          aria-label='Remove environment'
                          data-tip='Remove environment'
                          onClick={() => {
                            setTouched(true)
                            setEnvs((all) => all.filter((_, j) => j !== i))
                          }}
                        >
                          <Trash2 className='h-3.5 w-3.5' aria-hidden />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <Field id={id('dbmode')} label='Database'>
                      <SimpleSelect
                        value={e.dbMode}
                        onChange={(v) => setEnv(i, { dbMode: v as EnvDraft['dbMode'] })}
                        options={DB_MODE_OPTIONS}
                        ariaLabel={`Database for environment ${i + 1}`}
                        className='h-8 text-[13px]'
                        triggerProps={{ id: id('dbmode') }}
                      />
                    </Field>
                    {e.dbMode === 'server' ? (
                      <Field id={id('server')} label='Server'>
                        <SimpleSelect
                          value={e.serverId}
                          onChange={(v) => setEnv(i, { serverId: v })}
                          options={serverOptions}
                          ariaLabel={`Server for environment ${i + 1}`}
                          className='h-8 text-[13px]'
                          triggerProps={{ id: id('server') }}
                        />
                      </Field>
                    ) : (
                      <Field
                        id={id('existing')}
                        label='Existing database'
                        hint='Databases the Hub records that no environment uses.'
                      >
                        <SimpleSelect
                          value={e.databaseId}
                          onChange={(v) => setEnv(i, { databaseId: v })}
                          options={databaseOptions}
                          ariaLabel={`Existing database for environment ${i + 1}`}
                          className='h-8 text-[13px]'
                          triggerProps={{ id: id('existing') }}
                        />
                      </Field>
                    )}
                    {e.dbMode === 'server' && (
                      <>
                        <Field id={id('dbname')} label='Database name (optional)'>
                          <Input
                            id={id('dbname')}
                            value={e.databaseName}
                            onChange={(ev) => setEnv(i, { databaseName: ev.target.value })}
                            placeholder={names.database}
                            className='h-8 font-mono text-[13px]'
                          />
                        </Field>
                        <Field id={id('login')} label='Login name (optional)'>
                          <Input
                            id={id('login')}
                            value={e.loginName}
                            onChange={(ev) => setEnv(i, { loginName: ev.target.value })}
                            placeholder={names.login}
                            className='h-8 font-mono text-[13px]'
                          />
                        </Field>
                      </>
                    )}
                    {manual ? (
                      <div className='sm:col-span-2'>
                        <Field
                          id={id('host')}
                          label='Hostname (you will request it)'
                          hint='The Hub gives you a ticket for it and waits until it answers.'
                          error={local.hostnames[i] || null}
                        >
                          <Input
                            id={id('host')}
                            value={e.hostname}
                            onChange={(ev) => setEnv(i, { hostname: ev.target.value })}
                            placeholder='orders.example.com'
                            className='h-8 font-mono text-[13px]'
                          />
                        </Field>
                      </div>
                    ) : auto ? (
                      <p className='m-0 text-[12px] text-slate-600 sm:col-span-2 dark:text-slate-300'>
                        Hostname: <code className='font-mono text-[12px]'>{auto}</code>{' '}
                        <span className='text-slate-500 dark:text-muted-foreground'>
                          (made automatically)
                        </span>
                      </p>
                    ) : null}
                  </div>

                  {mine.length > 0 && <BlockerList blockers={mine} />}
                </li>
              )
            })}
          </ol>
        </SectionCard>

        <SectionCard
          title='First administrator'
          description='The person who can sign in first and set the app up. They sign in with Microsoft using this email.'
        >
          <div className='grid grid-cols-1 gap-3 p-4 sm:grid-cols-3'>
            <Field id='hub-create-admin-email' label='Email'>
              <Input
                id='hub-create-admin-email'
                type='email'
                value={adminEmail}
                onChange={(e) => touch(setAdminEmail)(e.target.value)}
                placeholder='ada@example.com'
                className='h-8 text-[13px]'
              />
            </Field>
            <Field id='hub-create-admin-first' label='First name'>
              <Input
                id='hub-create-admin-first'
                value={adminFirst}
                onChange={(e) => touch(setAdminFirst)(e.target.value)}
                className='h-8 text-[13px]'
              />
            </Field>
            <Field id='hub-create-admin-last' label='Last name'>
              <Input
                id='hub-create-admin-last'
                value={adminLast}
                onChange={(e) => touch(setAdminLast)(e.target.value)}
                className='h-8 text-[13px]'
              />
            </Field>
          </div>
        </SectionCard>

        <PreviewCard
          plan={fresh}
          stale={!!plan && !fresh}
          blockers={appBlockers(blockers, envKeys)}
          planning={planning}
          touched={touched}
          failure={planFailure}
          onPreview={runPreview}
        />

        {createFailure != null && (
          <ErrorNotice description={createError(createFailure, 'Could not create the app')} />
        )}

        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={!canCreate}
            onClick={() => void create()}
          >
            {creating ? 'Creating…' : 'Create app'}
          </Button>
          <Button size='sm' variant='ghost' className='h-8' onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
          {!canCreate && !creating && (
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {planning
                ? 'Checking…'
                : blockers.length && fresh
                  ? 'Fix what the preview lists first.'
                  : 'Create is offered once the preview of this form has nothing to fix.'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function BlockerList({ blockers }: { blockers: CreationBlocker[] }) {
  return (
    <ul
      aria-label='What to fix'
      className='m-0 list-none space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/30'
    >
      {blockers.map((b, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: codes and texts may repeat
          key={i}
          className='text-[12px] text-red-800 dark:text-red-200'
        >
          {b.text}
        </li>
      ))}
    </ul>
  )
}

function PreviewCard({
  plan,
  stale,
  blockers,
  planning,
  touched,
  failure,
  onPreview
}: {
  plan: CreationPlan | null
  stale: boolean
  blockers: CreationBlocker[]
  planning: boolean
  touched: boolean
  failure: unknown
  onPreview: () => void
}) {
  return (
    <SectionCard
      title='Preview'
      description={
        planning
          ? 'Asking the Hub…'
          : stale
            ? 'The form changed since this preview.'
            : plan
              ? plan.ok
                ? 'Ready to create.'
                : 'Some things need fixing first.'
              : touched
                ? 'The preview appears a moment after you stop typing.'
                : 'Fill in the form; the preview appears as you go.'
      }
      actions={
        <button type='button' className={ghostButton} onClick={onPreview} disabled={planning}>
          <Eye className='h-3.5 w-3.5' aria-hidden /> Preview
        </button>
      }
    >
      <div className={cn('space-y-3 p-4', stale && 'opacity-60')}>
        {failure != null && (
          <ErrorNotice
            description={createError(failure, 'Could not preview')}
            onRetry={onPreview}
          />
        )}
        {blockers.length > 0 && <BlockerList blockers={blockers} />}
        {plan && plan.environments.length > 0 && (
          <ul className='m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2'>
            {plan.environments.map((p) => (
              <li
                key={`${p.position}-${p.key}`}
                className='min-w-0 space-y-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-border dark:bg-card'
              >
                <p className='m-0 font-medium text-slate-900 dark:text-foreground'>
                  {p.key}
                  <span className='font-normal text-slate-500 dark:text-muted-foreground'>
                    {' '}
                    · from {p.source_branch === p.key ? 'its own pipeline' : p.source_branch}
                  </span>
                </p>
                {p.database.database_name ? (
                  <p className='m-0 break-words text-slate-600 dark:text-slate-300'>
                    {DB_MODE_WORDS[p.database.mode]}:{' '}
                    <code className='font-mono'>{p.database.database_name}</code>
                    {p.database.server_name ? ` on ${p.database.server_name}` : ''}
                    {p.database.login_name ? `, login ${p.database.login_name}` : ''}
                  </p>
                ) : (
                  <p className='m-0 text-slate-500 dark:text-muted-foreground'>
                    No database picked yet.
                  </p>
                )}
                {p.base_url && (
                  <p className='m-0 break-all text-slate-600 dark:text-slate-300'>
                    {p.base_url}
                    {p.dns_mode === 'manual' ? ' (requested by ticket)' : ''}
                  </p>
                )}
                {p.redirect_uri && (
                  <div className='flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300'>
                    <span>Redirect URI to add in Entra:</span>
                    <code className='break-all font-mono text-[11px]'>{p.redirect_uri}</code>
                    <CopyButton value={p.redirect_uri} label={`Copy ${p.key} redirect URI`} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {plan && plan.lines.length > 0 && (
          <details className='rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <summary className='cursor-pointer select-none px-3 py-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-300'>
              Everything the Hub will do
            </summary>
            <ul className='m-0 list-disc space-y-0.5 px-3 pb-2 pl-7 text-[12px] text-slate-600 dark:text-slate-300'>
              {plan.lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines may repeat
                <li key={i} className='break-words'>
                  {l}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </SectionCard>
  )
}
