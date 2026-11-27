import { ErrorNotice } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Eye, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { UserCombobox } from '@/components/user-combobox'
import type { User } from '@/lib/api'
import { cn } from '@/lib/utils'
import { withoutSecrets } from '../costs/cost-api'
import { CreateEstimateCard } from '../costs/StackEstimate'
import { dbKeys, ENGINE_LABEL, STATUS_LABEL, useDatabases, useDbServers } from '../databases/db-api'
import { fetchDrivers, HUB_MASK, hubKeys } from '../hub-api'
import {
  CopyButton,
  Field,
  ghostButton,
  SectionCard,
  segmentButton,
  segmentGroup
} from '../hub-parts'
import { fetchProviderTypes, providerKeys, typeIndex } from '../providers/providers-api'
import { fetchSharedList, sharedKeys } from '../shared/shared-api'
import { countsLine, fetchTemplates, templateError, templateKeys } from '../templates/templates-api'
import {
  appBlockers,
  automaticHostname,
  blockersForEnv,
  type CreateAppInput,
  type CreateTargetInput,
  type CreationBlocker,
  type CreationKind,
  type CreationPlan,
  createBlockersOf,
  createError,
  createKeys,
  defaultDbNames,
  fetchTargets,
  isCreatableKey,
  isGithubTarget,
  KIND_WORDS,
  previewPlan,
  startCreate,
  VERSION_RE
} from './create-api'
import {
  type PartDraft,
  ProviderPartsEditor,
  partProblems,
  partsPayload,
  partTypeInfo
} from './ProviderParts'

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
  /** Docker, published-port edge: this environment's port. */
  publishPort: string
  /** Task 11: provider parts made for this environment. */
  parts: PartDraft[]
}

const emptyEnv = (key: string): EnvDraft => ({
  key,
  dbMode: 'server',
  serverId: '',
  databaseName: '',
  loginName: '',
  databaseId: '',
  hostname: '',
  publishPort: '',
  parts: []
})

interface SecretDraft {
  id: number
  key: string
  value: string
}
let secretSeq = 1

/** `KEY=value` lines (blank lines and `#` comments skipped) as a map; null when a line is bad. */
export function linesToMap(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const at = t.indexOf('=')
    if (at < 1) return null
    out[t.slice(0, at).trim()] = t.slice(at + 1).trim()
  }
  return out
}

const KIND_OPTIONS: CreationKind[] = ['gitlab', 'github', 'docker', 'shared']
const SIZE_OPTIONS = [
  { value: 'small', label: 'Small (one process)' },
  { value: 'medium', label: 'Medium (web + worker)' },
  { value: 'large', label: 'Large (split roles)' }
]
const REDIS_OPTIONS = [
  { value: 'bundled', label: 'Bundled (the agent runs one)' },
  { value: 'external', label: 'External (give REDIS_URL)' }
]

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
  onCancel,
  initialTemplateId
}: {
  onDone: (appId: number) => void
  onCancel: () => void
  /** Preselected template (Clone & retire → Create app from a structure copy: `?template=`). */
  initialTemplateId?: number
}) {
  const qc = useQueryClient()
  const targets = useQuery({ queryKey: createKeys.targets(), queryFn: fetchTargets })
  const providerTypes = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const drivers = useQuery({ queryKey: hubKeys.drivers(), queryFn: fetchDrivers })
  const sharedList = useQuery({ queryKey: sharedKeys.list(), queryFn: fetchSharedList })
  // The Databases tab's reads and keys: a save on either screen refreshes both.
  const servers = useDbServers()
  const databases = useDatabases()

  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [owners, setOwners] = useState<Array<{ id: string; label: string }>>([])
  const [kind, setKind] = useState<CreationKind>('gitlab')
  const [targetId, setTargetId] = useState('')
  const [driverId, setDriverId] = useState('')
  const [sharedId, setSharedId] = useState('')
  const [size, setSize] = useState('small')
  const [redis, setRedis] = useState('bundled')
  const [settingsText, setSettingsText] = useState('')
  const [pinsText, setPinsText] = useState('')
  const [secrets, setSecrets] = useState<SecretDraft[]>([])
  const [poolMax, setPoolMax] = useState('')
  const [extensionsText, setExtensionsText] = useState('')
  const [version, setVersion] = useState('')
  // Hub enhancement 24: a template from the library ('' = none).
  const [templateId, setTemplateId] = useState(initialTemplateId ? String(initialTemplateId) : '')
  // Review M2: template roles that keep their administrator access (ticked one by one).
  const [keepAdmin, setKeepAdmin] = useState<string[]>([])
  const templates = useQuery({
    queryKey: templateKeys.list(false),
    queryFn: () => fetchTemplates()
  })
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [envs, setEnvs] = useState<EnvDraft[]>([emptyEnv('staging'), emptyEnv('production')])
  const [adminEmail, setAdminEmail] = useState('')
  const [adminFirst, setAdminFirst] = useState('')
  const [adminLast, setAdminLast] = useState('')
  const [touched, setTouched] = useState(false)

  // GitLab and GitHub targets share one list; each kind offers its own (Task 11).
  const kindTargets = (targets.data ?? []).filter((t) =>
    kind === 'github' ? isGithubTarget(t) : !isGithubTarget(t)
  )
  const target = kindTargets.find((t) => String(t.id) === targetId) ?? null
  const onTarget = kind === 'gitlab' || kind === 'github'
  const dockerDrivers = (drivers.data ?? []).filter((d) => d.kind === 'docker')
  const driver = dockerDrivers.find((d) => String(d.id) === driverId) ?? null
  const deployments = (sharedList.data ?? []).filter((s) => s.status !== 'retired')
  const shared = deployments.find((s) => String(s.id) === sharedId) ?? null
  const sharedBase = shared?.host_pattern?.startsWith('*.') ? shared.host_pattern.slice(2) : null
  // Where names are typed by hand: a GitLab target or Docker driver with manual DNS, or a shared
  // deployment without a host pattern.
  const manual = onTarget
    ? target?.config.dns_mode === 'manual'
    : kind === 'docker'
      ? driver?.config.dns_mode === 'manual'
      : !!shared && !sharedBase
  const wildcard = onTarget
    ? (target?.config.wildcard_domain ?? null)
    : kind === 'docker'
      ? (driver?.config.wildcard_domain ?? null)
      : sharedBase
  const picked = onTarget ? !!target : kind === 'docker' ? !!driver : !!shared
  const settingsMap = useMemo(() => linesToMap(settingsText), [settingsText])
  const pinsMap = useMemo(() => linesToMap(pinsText), [pinsText])
  const targetInput: CreateTargetInput = useMemo(() => {
    if (kind === 'docker')
      return {
        kind,
        driver_id: Number(driverId) || 0,
        stack: {
          size,
          redis,
          settings: settingsMap ?? {},
          secrets: Object.fromEntries(
            secrets.filter((s) => s.key.trim()).map((s) => [s.key.trim(), s.value])
          ),
          extension_pins: pinsMap ?? {}
        }
      }
    if (kind === 'shared')
      return {
        kind,
        shared_id: Number(sharedId) || 0,
        ...(poolMax.trim() ? { pool_max: Number(poolMax) } : {})
      }
    if (kind === 'github') return { kind, id: Number(targetId) || 0 }
    return { kind: 'gitlab', id: Number(targetId) || 0 }
  }, [kind, driverId, sharedId, targetId, size, redis, settingsMap, secrets, pinsMap, poolMax])
  const sharedSignin = kind === 'shared' && !issuer.trim() && !clientId.trim() && !clientSecret
  // The estimate's body: where it runs and the provider parts — no sign-in secret, no stack
  // secrets, every provider secret reduced to "set" (an estimate never carries a secret).
  const estimateBody = useMemo(() => {
    const t = targetInput
    const target =
      t.kind === 'docker'
        ? { kind: 'docker', driver_id: t.driver_id, stack: { size: t.stack?.size ?? 'small' } }
        : t.kind === 'shared'
          ? { kind: 'shared', shared_id: t.shared_id }
          : { kind: t.kind, id: t.id }
    const idx = typeIndex(providerTypes.data)
    return {
      target,
      environments: envs.map((e) => ({
        key: e.key.trim(),
        providers:
          e.parts.length && kind !== 'shared'
            ? (partsPayload(e.parts, providerTypes.data) ?? []).map((p) => {
                const spec = idx.type(p.type)
                return {
                  connection_id: p.connection_id,
                  type: p.type,
                  fields: spec && p.fields ? withoutSecrets(spec.fields, p.fields) : {}
                }
              })
            : []
      }))
    }
  }, [targetInput, envs, kind, providerTypes.data])
  const estimateReady =
    envs.length > 0 &&
    (targetInput.kind === 'docker'
      ? targetInput.driver_id > 0
      : targetInput.kind === 'shared'
        ? targetInput.shared_id > 0
        : targetInput.id > 0)

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
      // GitLab keeps the phase-3 form (`target_id`), so an older Hub reads it too.
      ...(kind === 'gitlab' ? { target_id: Number(targetId) || 0 } : { target: targetInput }),
      version: version.trim(),
      ...(kind !== 'shared' && Number(templateId) ? { template_id: Number(templateId) } : {}),
      ...(kind !== 'shared' && Number(templateId) && keepAdmin.length
        ? { keep_admin_roles: keepAdmin }
        : {}),
      ...(sharedSignin
        ? {}
        : {
            signin: {
              issuer: issuer.trim(),
              client_id: clientId.trim(),
              client_secret: clientSecret
            }
          }),
      ...(kind === 'shared' && extensionsText.trim()
        ? {
            extensions: extensionsText
              .split(/[\s,]+/)
              .map((x) => x.trim())
              .filter(Boolean)
          }
        : {}),
      environments: envs.map((e) => ({
        key: e.key.trim(),
        ...(e.parts.length && kind !== 'shared'
          ? { providers: partsPayload(e.parts, providerTypes.data) }
          : {}),
        ...(manual && e.hostname.trim() ? { hostname: e.hostname.trim() } : {}),
        ...(kind === 'docker' && e.publishPort.trim()
          ? { publish_port: Number(e.publishPort) }
          : {}),
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
      targetInput,
      version,
      templateId,
      keepAdmin,
      issuer,
      clientId,
      clientSecret,
      envs,
      manual,
      kind,
      sharedSignin,
      extensionsText,
      providerTypes.data,
      targetId
    ]
  )
  // What a preview sends: the form with every secret replaced by the mask. The planner only
  // checks that a secret is there; the secrets themselves go out once, with Create.
  const previewInput: CreateAppInput = useMemo(() => {
    const t = input.target
    return {
      ...input,
      ...(input.signin
        ? {
            signin: {
              ...input.signin,
              client_secret: input.signin.client_secret ? HUB_MASK : ''
            }
          }
        : {}),
      ...(t?.kind === 'docker'
        ? {
            target: {
              ...t,
              stack: {
                ...t.stack,
                secrets: Object.fromEntries(
                  Object.entries(t.stack?.secrets ?? {}).map(([k, v]) => [k, v ? HUB_MASK : ''])
                )
              }
            }
          }
        : {}),
      // Provider part secrets (an RDS password) go out once, with Create.
      environments: input.environments.map((env, i) =>
        env.providers
          ? {
              ...env,
              providers: partsPayload(envs[i]?.parts ?? [], providerTypes.data, { mask: true })
            }
          : env
      )
    }
  }, [input, envs, providerTypes.data])
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
    version: version.trim() && !VERSION_RE.test(version.trim()) ? 'A version like 0.3.215' : '',
    settings:
      kind === 'docker' && (settingsMap === null || pinsMap === null)
        ? 'One KEY=value per line'
        : '',
    ports: envs.map((e) =>
      kind === 'docker' && e.publishPort.trim() && !/^\d{1,5}$/.test(e.publishPort.trim())
        ? 'A port number'
        : ''
    ),
    hostnames: envs.map((e) =>
      manual && !e.hostname.trim() ? 'Enter the hostname you will request' : ''
    ),
    parts: envs.map(
      (e) =>
        kind !== 'shared' &&
        e.parts.some(
          (pt) => Object.keys(partProblems(pt, partTypeInfo(providerTypes.data, pt.type))).length
        )
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
    !!local.key ||
    !!local.version ||
    !!local.secret ||
    !!local.settings ||
    local.ports.some(Boolean) ||
    local.hostnames.some(Boolean) ||
    local.parts.some(Boolean) ||
    !picked

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
    ...kindTargets.map((t) => ({
      value: String(t.id),
      label: `${t.name} · ${isGithubTarget(t) ? t.config.template : t.config.namespace}${t.config.dns_mode === 'manual' ? ' · names by hand' : t.config.dns_mode === 'route53' ? ' · Route 53' : ''}`
    }))
  ]
  const pickedTemplate = templates.data?.find((t) => String(t.id) === templateId) ?? null
  const templateOptions = [
    { value: '', label: 'No template' },
    ...(templates.data ?? []).map((t) => ({ value: String(t.id), label: `${t.name} ${t.version}` }))
  ]
  const driverOptions = [
    { value: '', label: 'Pick a Docker driver' },
    ...dockerDrivers.map((d) => ({
      value: String(d.id),
      label: `${d.name}${d.config.dns_mode === 'manual' ? ' · names by hand' : d.config.wildcard_domain ? ` · *.${d.config.wildcard_domain}` : ''}`
    }))
  ]
  const sharedOptions = [
    { value: '', label: 'Pick a shared deployment' },
    ...deployments.map((s) => ({
      value: String(s.id),
      label: `${s.name} · ${s.key}${s.version_pin ? ` · ${s.version_pin}` : ''}${s.host_pattern ? ` · ${s.host_pattern}` : ''}`
    }))
  ]
  const setSecret = (id: number, patch: Partial<SecretDraft>) => {
    setTouched(true)
    setSecrets((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[960px] space-y-5'>
        <div>
          <h2 className='m-0 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            Create an app
          </h2>
          <p className='m-0 mt-1 max-w-[72ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
            The Hub makes a database per environment, their secrets, a first deploy (through a
            GitLab target's pipeline, a Docker driver's Hub agent, or a shared deployment), the
            hostnames and the first administrator. The preview below says exactly what it will do
            before anything is made.
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
          <div className='relative px-4 pt-4'>
            <fieldset className={segmentGroup}>
              <legend className='sr-only'>Where the app goes</legend>
              {KIND_OPTIONS.map((k) => (
                <button
                  key={k}
                  type='button'
                  aria-pressed={kind === k}
                  data-tip={KIND_WORDS[k].hint}
                  onClick={() => touch(setKind)(k)}
                  className={segmentButton(kind === k)}
                >
                  {KIND_WORDS[k].label}
                </button>
              ))}
            </fieldset>
            <p className='m-0 mt-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              {KIND_WORDS[kind].hint}
            </p>
          </div>
          <div className='grid grid-cols-1 gap-3 p-4 sm:grid-cols-2'>
            {onTarget && (
              <Field
                id='hub-create-target'
                label={kind === 'github' ? 'GitHub target' : 'Target'}
                hint={
                  targets.data && kindTargets.length === 0
                    ? `No ${kind === 'github' ? 'GitHub' : 'GitLab'} targets yet: add one on the Targets tab.`
                    : target
                      ? target.config.dns_mode === 'manual'
                        ? 'Hostnames are requested by hand on this target.'
                        : target.config.dns_mode === 'route53'
                          ? `The Hub adds each name under ${target.config.wildcard_domain} to Route 53.`
                          : `Hostnames are made under ${target.config.wildcard_domain}.`
                      : kind === 'github'
                        ? 'Where the repository is made and which workflow deploys it.'
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
            )}
            {kind === 'docker' && (
              <Field
                id='hub-create-driver'
                label='Docker driver'
                hint={
                  drivers.data && dockerDrivers.length === 0
                    ? 'No Docker drivers yet: add one under Drivers.'
                    : driver
                      ? driver.config.dns_mode === 'manual'
                        ? 'Hostnames are requested by hand for this driver.'
                        : `Hostnames are made under ${driver.config.wildcard_domain}.`
                      : 'The Hub agent that deploys each environment as a swarm stack.'
                }
              >
                <SimpleSelect
                  value={driverId}
                  onChange={touch(setDriverId)}
                  options={driverOptions}
                  ariaLabel='Docker driver'
                  className='h-8 text-[13px]'
                  triggerProps={{ id: 'hub-create-driver' }}
                />
              </Field>
            )}
            {kind === 'shared' && (
              <Field
                id='hub-create-shared'
                label='Shared deployment'
                hint={
                  sharedList.data && deployments.length === 0
                    ? 'No shared deployments yet: add one on the Shared tab.'
                    : shared
                      ? sharedBase
                        ? `Hostnames are made under ${sharedBase}.`
                        : 'Enter each hostname: the deployment has no host pattern.'
                      : 'The deployment every environment is placed on.'
                }
              >
                <SimpleSelect
                  value={sharedId}
                  onChange={touch(setSharedId)}
                  options={sharedOptions}
                  ariaLabel='Shared deployment'
                  className='h-8 text-[13px]'
                  triggerProps={{ id: 'hub-create-shared' }}
                />
              </Field>
            )}
            <Field
              id='hub-create-version'
              label={kind === 'shared' ? 'Version (optional)' : 'Version'}
              hint={
                kind === 'shared'
                  ? `An app on a shared deployment runs its version${shared?.version_pin ? ` (${shared.version_pin})` : ''}.`
                  : 'The Nivaro release every environment starts on.'
              }
              error={local.version || null}
            >
              <Input
                id='hub-create-version'
                value={version}
                onChange={(e) => touch(setVersion)(e.target.value)}
                placeholder={kind === 'shared' ? (shared?.version_pin ?? '') : '0.3.215'}
                inputMode='decimal'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            {kind === 'shared' && (
              <>
                <Field
                  id='hub-create-pool'
                  label='Database connections per environment (optional)'
                  hint='Taken from the deployment’s connection budget; 5 when empty.'
                >
                  <Input
                    id='hub-create-pool'
                    value={poolMax}
                    onChange={(e) => touch(setPoolMax)(e.target.value)}
                    placeholder='5'
                    inputMode='numeric'
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
                <Field
                  id='hub-create-extensions'
                  label='Extensions (optional)'
                  hint={
                    shared?.extensions.length
                      ? `The deployment loads ${shared.extensions.join(', ')}.`
                      : 'Extension ids the deployment loads, comma separated.'
                  }
                >
                  <Input
                    id='hub-create-extensions'
                    value={extensionsText}
                    onChange={(e) => touch(setExtensionsText)(e.target.value)}
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
              </>
            )}
          </div>
          {kind === 'docker' && (
            <div className='grid grid-cols-1 gap-3 border-t border-slate-100 p-4 sm:grid-cols-2 dark:border-border'>
              <Field id='hub-create-size' label='Stack size'>
                <SimpleSelect
                  value={size}
                  onChange={touch(setSize)}
                  options={SIZE_OPTIONS}
                  ariaLabel='Stack size'
                  className='h-8 text-[13px]'
                  triggerProps={{ id: 'hub-create-size' }}
                />
              </Field>
              <Field id='hub-create-redis' label='Redis'>
                <SimpleSelect
                  value={redis}
                  onChange={touch(setRedis)}
                  options={REDIS_OPTIONS}
                  ariaLabel='Redis'
                  className='h-8 text-[13px]'
                  triggerProps={{ id: 'hub-create-redis' }}
                />
              </Field>
              <Field
                id='hub-create-settings'
                label='Settings (optional)'
                hint='One KEY=value per line. Sign-in and the database are set by the Hub.'
                error={settingsMap === null ? 'One KEY=value per line' : null}
              >
                <textarea
                  id='hub-create-settings'
                  value={settingsText}
                  onChange={(e) => touch(setSettingsText)(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder='MAIL_FROM=orders@example.com'
                  className='w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]'
                />
              </Field>
              <Field
                id='hub-create-pins'
                label='Extension pins (optional)'
                hint='One id=repository@sha256:digest per line; the agent must allow the image.'
                error={pinsMap === null ? 'One id=image per line' : null}
              >
                <textarea
                  id='hub-create-pins'
                  value={pinsText}
                  onChange={(e) => touch(setPinsText)(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder='efp-ops=registry.example.com/efp-ops@sha256:…'
                  className='w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]'
                />
              </Field>
              <div className='space-y-2 sm:col-span-2'>
                <p className='m-0 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  Secrets (optional)
                </p>
                <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  SESSION_SECRET and ENCRYPTION_KEY are generated and sealed for each environment.
                  Enter ENCRYPTION_KEY only for a database an earlier install sealed with it.
                </p>
                {secrets.map((s) => (
                  <div key={s.id} className='flex flex-wrap items-center gap-2'>
                    <Input
                      aria-label='Secret name'
                      value={s.key}
                      onChange={(e) => setSecret(s.id, { key: e.target.value })}
                      placeholder='REDIS_URL'
                      className='h-8 w-[200px] font-mono text-[13px]'
                    />
                    <Input
                      aria-label={`Value of ${s.key || 'the secret'}`}
                      type='password'
                      autoComplete='new-password'
                      spellCheck={false}
                      value={s.value}
                      onChange={(e) => setSecret(s.id, { value: e.target.value })}
                      className='h-8 min-w-[200px] flex-1 font-mono text-[13px]'
                    />
                    <button
                      type='button'
                      className={ghostButton}
                      aria-label={`Remove ${s.key || 'secret'}`}
                      onClick={() => {
                        setTouched(true)
                        setSecrets((all) => all.filter((x) => x.id !== s.id))
                      }}
                    >
                      <Trash2 className='h-3.5 w-3.5' aria-hidden />
                    </button>
                  </div>
                ))}
                <button
                  type='button'
                  className={ghostButton}
                  onClick={() => {
                    setTouched(true)
                    setSecrets((all) => [...all, { id: secretSeq++, key: '', value: '' }])
                  }}
                >
                  <Plus className='h-3.5 w-3.5' aria-hidden /> Add secret
                </button>
              </div>
            </div>
          )}
          {kind !== 'shared' && (
            <div className='border-t border-slate-100 p-4 dark:border-border'>
              <Field
                id='hub-create-template'
                label='App template'
                hint={
                  pickedTemplate
                    ? `${countsLine(pickedTemplate.manifest)} — installed into every environment after its first administrator.`
                    : templates.data?.length === 0
                      ? 'No templates yet: upload an App Blueprint on the Templates tab.'
                      : 'Optional: an App Blueprint from the Templates tab (schema, workflows, layouts, queues and rules — never data).'
                }
              >
                <SimpleSelect
                  value={templateId}
                  onChange={touch((v: string) => {
                    setTemplateId(v)
                    setKeepAdmin([])
                  })}
                  options={templateOptions}
                  ariaLabel='App template'
                  className='h-8 text-[13px]'
                  triggerProps={{ id: 'hub-create-template' }}
                />
              </Field>
              {(pickedTemplate?.manifest?.review?.admin_roles?.length ?? 0) > 0 && (
                <fieldset className='m-0 mt-3 space-y-1.5 border-0 p-0'>
                  <legend className='mb-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                    Roles with administrator access on the source
                  </legend>
                  <p className='m-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    They arrive without it. Tick a role only if everyone given it should be an
                    administrator of the new app (logged).
                  </p>
                  {pickedTemplate?.manifest?.review?.admin_roles?.map((r) => {
                    const id = `hub-create-keep-admin-${r.id}`
                    return (
                      <label
                        key={r.id}
                        htmlFor={id}
                        className='flex items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-slate-200'
                      >
                        <Checkbox
                          id={id}
                          checked={keepAdmin.includes(r.id)}
                          onCheckedChange={(v) =>
                            setKeepAdmin((cur) =>
                              v === true ? [...cur, r.id] : cur.filter((x) => x !== r.id)
                            )
                          }
                        />
                        Keep administrator access for {r.name}
                      </label>
                    )
                  })}
                </fieldset>
              )}
              {templates.isError && (
                <div className='mt-2'>
                  <ErrorNotice
                    description={templateError(templates.error, 'Could not load the templates')}
                    onRetry={() => void templates.refetch()}
                  />
                </div>
              )}
            </div>
          )}
          {onTarget && targets.isError && (
            <div className='px-4 pb-3'>
              <ErrorNotice
                description={createError(targets.error, 'Could not load the targets')}
                onRetry={() => void targets.refetch()}
              />
            </div>
          )}
          {kind === 'docker' && drivers.isError && (
            <div className='px-4 pb-3'>
              <ErrorNotice
                description={createError(drivers.error, 'Could not load the drivers')}
                onRetry={() => void drivers.refetch()}
              />
            </div>
          )}
          {kind === 'shared' && sharedList.isError && (
            <div className='px-4 pb-3'>
              <ErrorNotice
                description={createError(sharedList.error, 'Could not load the shared deployments')}
                onRetry={() => void sharedList.refetch()}
              />
            </div>
          )}
        </SectionCard>

        <SectionCard
          title='Sign-in'
          description={
            kind === 'shared'
              ? 'Optional: an app on a shared deployment signs in with the deployment’s own app registration. Fill this in to keep the app’s own registration for a later move.'
              : 'The Microsoft Entra app registration people sign in with.'
          }
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
                !manual && picked
                  ? (planned?.hostname ?? automaticHostname(wildcard, key.trim(), e.key.trim()))
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
                    ) : null}
                    {kind === 'docker' && (
                      <Field
                        id={id('port')}
                        label='Publish port (only on a published-port edge)'
                        error={local.ports[i] || null}
                      >
                        <Input
                          id={id('port')}
                          value={e.publishPort}
                          onChange={(ev) => setEnv(i, { publishPort: ev.target.value })}
                          inputMode='numeric'
                          className='h-8 font-mono text-[13px]'
                        />
                      </Field>
                    )}
                    {kind !== 'shared' && (
                      <ProviderPartsEditor
                        idPrefix={id('providers')}
                        envKey={e.key.trim()}
                        parts={e.parts}
                        onChange={(parts) => setEnv(i, { parts })}
                        tried={false}
                      />
                    )}
                    {manual ? null : auto ? (
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

        <CreateEstimateCard input={estimateBody} ready={estimateReady} />

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
                : local.parts.some(Boolean)
                  ? 'Finish or remove the provider parts first.'
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
                    ·{' '}
                    {plan.target?.kind === 'shared'
                      ? `on ${plan.target.name ?? 'the shared deployment'}`
                      : `from ${p.source_branch === p.key ? (plan.target?.kind === 'docker' ? 'the published release' : 'its own pipeline') : p.source_branch}`}
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
                {p.stack && (
                  <p className='m-0 break-words text-slate-600 dark:text-slate-300'>
                    Stack <code className='font-mono'>{p.stack_name}</code>, {p.stack.size}, Redis{' '}
                    {p.stack.redis}
                    {p.stack.publish_port ? `, port ${p.stack.publish_port}` : ''}
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
        {plan?.warnings?.length ? (
          <ul
            aria-label='Before you create'
            className='m-0 list-none space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
          >
            {plan.warnings.map((w) => (
              <li key={w} className='break-words'>
                {w}
              </li>
            ))}
          </ul>
        ) : null}
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
