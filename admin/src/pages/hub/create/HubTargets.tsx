import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Globe, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import {
  type DnsMode,
  dnsModeOf,
  dnsModeOptions,
  isManagedDns,
  MANAGED_DNS,
  managedDnsHint,
  withDnsMode,
  zoneBody,
  zoneFieldWords
} from '../dns-modes'
import { HUB_MASK } from '../hub-api'
import {
  dangerArmed,
  dangerGhost,
  Field,
  ghostButton,
  SecretInput,
  segmentButton,
  segmentGroup
} from '../hub-parts'
import { ConnectionPicker, ManagedResourcePicker } from '../providers/ResourcePickers'
import {
  type AnyHubTarget,
  createError,
  createKeys,
  createToast,
  deleteTarget,
  fetchTargets,
  type HubGithubTarget,
  type HubTarget,
  type HubTargetConfig,
  isGithubTarget,
  saveTarget,
  syncSummary,
  type TargetCheck,
  TEMPLATE_REF_RE,
  testTarget
} from './create-api'

/**
 * Targets (Hub tab, administrators): where new apps go — the GitLab namespace a new app's deploy
 * repository is created in, the template it is copied from and its pinned ref, the deploy host
 * and how hostnames are made. The token is sealed by the API and only ever shown as '••••••'.
 */
export default function HubTargetsTab() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin)
    return (
      <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Only administrators manage where new apps go.
        </p>
      </div>
    )
  return <HubTargets />
}

/** The targets list and the form of the one picked (a page of its own: the Targets tab). */
export function HubTargets() {
  const [picked, setPicked] = useState<number | 'new' | null>(null)
  const targets = useQuery({ queryKey: createKeys.targets(), queryFn: fetchTargets })
  const current = picked === 'new' ? null : (targets.data?.find((t) => t.id === picked) ?? null)

  return (
    <section aria-label='Targets' className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description={
          <>
            A target is where a new app's repository is made — a GitLab group or, through a GitHub
            connection, a GitHub account — the template it is copied from, how it deploys and how
            its hostnames are made.
            {targets.data && (
              <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                {' '}
                {targets.data.length} {targets.data.length === 1 ? 'target' : 'targets'}.
              </span>
            )}
          </>
        }
        actions={
          <button
            type='button'
            aria-pressed={picked === 'new'}
            className={cn(ghostButton, picked === 'new' && 'bg-accent')}
            onClick={() => setPicked('new')}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> New target
          </button>
        }
      />

      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          {targets.isPending ? (
            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3'>
              {[0, 1].map((i) => (
                <Skeleton key={i} className='h-16 w-full' />
              ))}
            </div>
          ) : targets.isError ? (
            <QueryErrorState
              error={targets.error}
              what='the targets'
              onRetry={() => void targets.refetch()}
            />
          ) : targets.data.length === 0 && picked !== 'new' ? (
            <p className='m-0 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              No targets yet. Add one to create apps from the Apps tab.
            </p>
          ) : (
            <ul className='m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3'>
              {targets.data.map((t) => (
                <li key={t.id}>
                  <TargetCard
                    target={t}
                    active={t.id === picked}
                    onSelect={() => setPicked(t.id === picked ? null : t.id)}
                  />
                </li>
              ))}
            </ul>
          )}

          {picked === 'new' ? (
            <NewTarget key='new' onClose={() => setPicked(null)} onSaved={setPicked} />
          ) : current && isGithubTarget(current) ? (
            <GithubTargetForm
              key={current.id}
              target={current}
              onClose={() => setPicked(null)}
              onSaved={setPicked}
            />
          ) : current ? (
            <TargetForm
              key={current.id}
              target={current}
              onClose={() => setPicked(null)}
              onSaved={setPicked}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}

const DNS_CHIP: Record<string, { label: string; tip: string }> = {
  automatic: { label: 'Automatic names', tip: 'Hostnames are made under the wildcard domain' },
  route53: {
    label: 'Route 53',
    tip: 'The Hub adds each name to a Route 53 hosted zone it manages'
  },
  cloudflare: {
    label: 'Cloudflare',
    tip: 'The Hub adds each name to a Cloudflare zone it manages'
  },
  manual: { label: 'Names by hand', tip: 'Each hostname is requested by hand' }
}

function TargetCard({
  target,
  active,
  onSelect
}: {
  target: AnyHubTarget
  active: boolean
  onSelect: () => void
}) {
  const c = target.config
  const dns = DNS_CHIP[c.dns_mode] ?? DNS_CHIP.manual
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
          {target.name}
        </span>
        <span className='shrink-0 rounded-full border border-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:border-border dark:text-slate-300'>
          {isGithubTarget(target) ? 'GitHub' : 'GitLab'}
        </span>
        <span
          data-tip={dns.tip}
          className='shrink-0 rounded-full border border-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
        >
          {dns.label}
        </span>
      </span>
      <span className='mt-0.5 block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
        {isGithubTarget(target)
          ? `${target.config.template} · ${target.config.deploy_workflow}`
          : `${target.config.namespace} · ${target.config.template_project}@${target.config.template_ref}`}
      </span>
      {c.wildcard_domain && (
        <span className='mt-0.5 flex items-center gap-1 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          <Globe className='h-3 w-3 shrink-0' aria-hidden />
          {c.scheme}://*.{c.wildcard_domain}
        </span>
      )}
    </button>
  )
}

interface Draft {
  name: string
  api: string
  namespace: string
  template_project: string
  template_ref: string
  pin_file: string
  deploy_job: string
  deploy_host: string
  manager_known_hosts: string
  proxy_network: string
  dns_mode: DnsMode
  dns_zone_resource_id: number | null
  wildcard_domain: string
  edge_address: string
  scheme: 'https' | 'http'
  port: string
  cert_note: string
  traefik_version: '3' | '2'
}

function draftOf(t: HubTarget | null): Draft {
  const c: Partial<HubTargetConfig> = t?.config ?? {}
  return {
    name: t?.name ?? '',
    api: c.api ?? '',
    namespace: c.namespace ?? '',
    template_project: c.template_project ?? '',
    template_ref: c.template_ref ?? '',
    pin_file: c.pin_file ?? '.hub/nivaro-version',
    deploy_job: c.deploy_job ?? 'deploy',
    deploy_host: c.deploy_host ?? '',
    manager_known_hosts: c.manager_known_hosts ?? '',
    proxy_network: c.proxy_network ?? 'proxy',
    dns_mode: dnsModeOf(c.dns_mode),
    dns_zone_resource_id: c.dns_zone_resource_id ?? null,
    wildcard_domain: c.wildcard_domain ?? '',
    edge_address: c.edge_address ?? '',
    scheme: c.scheme ?? 'https',
    port: c.port != null ? String(c.port) : '',
    cert_note: c.cert_note ?? '',
    traefik_version: c.traefik_version === 2 ? '2' : '3'
  }
}

/** What the form would refuse before the API is asked (the API checks everything again). */
export function targetDraftErrors(d: Draft): Partial<Record<keyof Draft, string>> {
  const e: Partial<Record<keyof Draft, string>> = {}
  if (!d.name.trim()) e.name = 'Give the target a name'
  if (!/^https?:\/\/\S+$/i.test(d.api.trim()))
    e.api = 'The GitLab API address, e.g. https://gitlab.example.com/api/v4'
  if (!d.namespace.trim()) e.namespace = 'The GitLab group new repositories go in'
  if (!d.template_project.trim()) e.template_project = 'The template project, e.g. ops/nivaro-app'
  if (!TEMPLATE_REF_RE.test(d.template_ref.trim()))
    e.template_ref =
      'A version tag like v1.2.0 (major number at most 9 digits) or a full 40-character commit sha'
  if (!d.deploy_host.trim()) e.deploy_host = 'host, user@host or host:port'
  if (!d.manager_known_hosts.trim())
    e.manager_known_hosts = "The manager's known_hosts lines (ssh-keyscan <host>)"
  Object.assign(e, hostnameErrors(d))
  return e
}

/** What both target kinds say about hostnames. */
interface HostnameDraft {
  dns_mode: DnsMode
  dns_zone_resource_id: number | null
  wildcard_domain: string
  edge_address: string
  scheme: 'https' | 'http'
  port: string
  cert_note: string
}

export function hostnameErrors(d: HostnameDraft): Partial<Record<keyof HostnameDraft, string>> {
  const e: Partial<Record<keyof HostnameDraft, string>> = {}
  if (d.dns_mode !== 'manual' && !d.wildcard_domain.trim())
    e.wildcard_domain = 'Automatic names need a wildcard domain like apps.example.com'
  if (isManagedDns(d.dns_mode) && !d.dns_zone_resource_id)
    e.dns_zone_resource_id = zoneFieldWords(d.dns_mode).missing
  if (isManagedDns(d.dns_mode) && !d.edge_address.trim())
    e.edge_address = `${MANAGED_DNS[d.dns_mode].label} records point at the edge: its address or name`
  const port = d.port.trim()
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535))
    e.port = 'A port from 1 to 65535, or leave empty'
  return e
}

/** The hostname part of a target's config body. */
const hostnameBody = (d: HostnameDraft) => {
  const opt = (v: string) => (v.trim() ? v.trim() : null)
  return {
    dns_mode: d.dns_mode,
    ...zoneBody(d),
    wildcard_domain: opt(d.wildcard_domain),
    edge_address: opt(d.edge_address),
    scheme: d.scheme,
    port: d.port.trim() ? Number(d.port.trim()) : null,
    cert_note: opt(d.cert_note)
  }
}

const DNS_OPTIONS = dnsModeOptions({
  automatic: 'Automatic (wildcard domain)',
  manual: 'By hand (a ticket per name)'
})
const TRAEFIK_OPTIONS = [
  { value: '3', label: 'Traefik 3 (swarm provider)' },
  { value: '2', label: 'Traefik 2 (docker provider)' }
]
const SCHEME_OPTIONS = [
  { value: 'https', label: 'https' },
  { value: 'http', label: 'http (localhost and .test only)' }
]

function TargetForm({
  target,
  onClose,
  onSaved
}: {
  target: HubTarget | null
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const qc = useQueryClient()
  const stored = !!target?.secret
  const [d, setD] = useState<Draft>(() => draftOf(target))
  const [token, setToken] = useState(stored ? HUB_MASK : '')
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [synced, setSynced] = useState<ReturnType<typeof syncSummary>>(null)
  const [checks, setChecks] = useState<{ ok: boolean; checks: TargetCheck[] } | null>(null)
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const errors = targetDraftErrors(d)
  const invalid = Object.values(errors).some(Boolean)
  const err = (k: keyof Draft) => (tried ? (errors[k] ?? null) : null)
  // What is saved now: Test checks the saved target, so it waits while the form differs.
  const [savedDraft, setSavedDraft] = useState(() => JSON.stringify(draftOf(target)))
  const [savedToken, setSavedToken] = useState(stored ? HUB_MASK : '')
  const dirty = JSON.stringify(d) !== savedDraft || token !== savedToken

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: d.name.trim(),
        config: {
          api: d.api.trim().replace(/\/+$/, ''),
          namespace: d.namespace.trim(),
          template_project: d.template_project.trim(),
          template_ref: d.template_ref.trim(),
          pin_file: d.pin_file.trim(),
          deploy_job: d.deploy_job.trim(),
          deploy_host: d.deploy_host.trim(),
          manager_known_hosts: d.manager_known_hosts.trim(),
          proxy_network: d.proxy_network.trim(),
          ...hostnameBody(d),
          traefik_version: d.traefik_version === '2' ? 2 : 3
        },
        // Unchanged = not sent (the stored token stays); cleared = removed.
        ...(token !== (stored ? HUB_MASK : '') ? { secret: token.trim() } : {})
      }
      return saveTarget(target?.id ?? null, body)
    },
    onSuccess: (answer) => {
      setFailure(null)
      const nextToken = answer.data && 'secret' in answer.data && answer.data.secret ? HUB_MASK : ''
      setToken(nextToken)
      setSavedToken(nextToken)
      setSavedDraft(JSON.stringify(d))
      setSynced(target ? syncSummary(answer) : null)
      void qc.invalidateQueries({ queryKey: createKeys.targets() })
      if (answer.data?.id) onSaved(answer.data.id)
    },
    onError: (e) => setFailure(e)
  })
  const test = useMutation({
    mutationFn: () => testTarget(target?.id ?? 0),
    onSuccess: setChecks,
    onError: (e) => createToast(e, 'Could not test the target')
  })
  const remove = useMutation({
    mutationFn: () => deleteTarget(target?.id ?? 0),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: createKeys.targets() })
      onClose()
    },
    onError: (e) => createToast(e, 'Could not delete the target')
  })

  const id = (f: string) => `hub-target-${target?.id ?? 'new'}-${f}`
  const mono = 'h-8 font-mono text-[13px]'
  const plain = 'h-8 text-[13px]'
  return (
    <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-start gap-3'>
        <h3 className='m-0 min-w-0 flex-1 truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {target ? target.name : 'New target'}
        </h3>
        {target && (
          <ConfirmButton
            title='Delete target'
            confirmLabel='Delete this target?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
          </ConfirmButton>
        )}
      </div>

      <FormGroup title='GitLab'>
        <Field id={id('name')} label='Name' error={err('name')}>
          <Input
            id={id('name')}
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder='Apps on swarm 1'
            className={plain}
          />
        </Field>
        <Field id={id('api')} label='GitLab API URL' error={err('api')}>
          <Input
            id={id('api')}
            value={d.api}
            onChange={(e) => set({ api: e.target.value })}
            placeholder='https://gitlab.example.com/api/v4'
            inputMode='url'
            className={plain}
          />
        </Field>
        <Field
          id={id('namespace')}
          label='Namespace'
          hint='The group each new deploy repository is created in.'
          error={err('namespace')}
        >
          <Input
            id={id('namespace')}
            value={d.namespace}
            onChange={(e) => set({ namespace: e.target.value })}
            placeholder='apps'
            className={mono}
          />
        </Field>
        <Field
          id={id('template')}
          label='Template project'
          hint='Each new deploy repository is a copy of it.'
          error={err('template_project')}
        >
          <Input
            id={id('template')}
            value={d.template_project}
            onChange={(e) => set({ template_project: e.target.value })}
            placeholder='ops/nivaro-app-template'
            className={mono}
          />
        </Field>
        <Field
          id={id('ref')}
          label='Template ref'
          hint='The tag or commit the deploy job comes from, e.g. v1.2.0.'
          error={err('template_ref')}
        >
          <Input
            id={id('ref')}
            value={d.template_ref}
            onChange={(e) => set({ template_ref: e.target.value })}
            placeholder='v1.0.0'
            className={mono}
          />
        </Field>
        <Field
          id={id('token')}
          label='Access token'
          hint={
            stored
              ? 'Stored sealed. Leave as is to keep it; clear it to remove it.'
              : 'A GitLab token with api scope, Maintainer on the namespace. Stored sealed.'
          }
        >
          <SecretInput id={id('token')} value={token} onChange={setToken} stored={stored} />
        </Field>
      </FormGroup>

      <FormGroup title='Deploys'>
        <Field
          id={id('host')}
          label='Deploy host'
          hint='The swarm manager the deploy job connects to: host, user@host or host:port.'
          error={err('deploy_host')}
        >
          <Input
            id={id('host')}
            value={d.deploy_host}
            onChange={(e) => set({ deploy_host: e.target.value })}
            placeholder='deploy@swarm1.example.com'
            className={mono}
          />
        </Field>
        <Field id={id('network')} label='Proxy network' hint='The Docker network the proxy uses.'>
          <Input
            id={id('network')}
            value={d.proxy_network}
            onChange={(e) => set({ proxy_network: e.target.value })}
            placeholder='proxy'
            className={mono}
          />
        </Field>
        <Field
          id={id('traefik')}
          label='Traefik version'
          hint='Picks the one network label a created app gets. Apps made earlier keep theirs until re-pinned.'
        >
          <SimpleSelect
            value={d.traefik_version}
            onChange={(v) => set({ traefik_version: v === '2' ? '2' : '3' })}
            options={TRAEFIK_OPTIONS}
            ariaLabel='Traefik version'
            className='h-8 text-left text-[13px]'
            triggerProps={{ id: id('traefik') }}
          />
        </Field>
        <div className='sm:col-span-2'>
          <Field
            id={id('known')}
            label="Manager's host keys"
            hint='The known_hosts lines of the deploy host (ssh-keyscan <host>). The deploy job refuses any other key.'
            error={err('manager_known_hosts')}
          >
            <Textarea
              id={id('known')}
              value={d.manager_known_hosts}
              onChange={(e) => set({ manager_known_hosts: e.target.value })}
              rows={3}
              spellCheck={false}
              placeholder='swarm1.example.com ssh-ed25519 AAAA…'
              className='font-mono text-[12px]'
            />
          </Field>
        </div>
        <Field id={id('job')} label='Deploy job' hint='The pipeline job that deploys.'>
          <Input
            id={id('job')}
            value={d.deploy_job}
            onChange={(e) => set({ deploy_job: e.target.value })}
            placeholder='deploy'
            className={mono}
          />
        </Field>
        <Field id={id('pin')} label='Version pin file' hint='The file that names the version.'>
          <Input
            id={id('pin')}
            value={d.pin_file}
            onChange={(e) => set({ pin_file: e.target.value })}
            placeholder='.hub/nivaro-version'
            className={mono}
          />
        </Field>
      </FormGroup>

      <HostnamesGroup d={d} set={set} err={err} id={id} />

      {failure != null && (
        <ErrorNotice description={createError(failure, 'Could not save the target')} />
      )}
      {synced && (
        <p
          role='status'
          className={cn(
            'm-0 text-[12px]',
            synced.tone === 'ok'
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-amber-800 dark:text-amber-300'
          )}
        >
          {synced.text}
        </p>
      )}
      {checks && <TargetChecks result={checks} />}

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
          {save.isPending ? 'Saving…' : target ? 'Save' : 'Add target'}
        </Button>
        {target && (
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
        {target && dirty && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Save first: Test checks the saved settings.
          </span>
        )}
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          {target ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}

function FormGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className='m-0 min-w-0 border-0 p-0'>
      <legend className='mb-2 p-0 text-[11px] font-medium text-slate-600 dark:text-muted-foreground'>
        {title}
      </legend>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>{children}</div>
    </fieldset>
  )
}

const CHECK_LABEL: Record<TargetCheck['id'], string> = {
  connection: 'Connection',
  token: 'Token',
  namespace: 'Namespace',
  template: 'Template'
}

function TargetChecks({ result }: { result: { ok: boolean; checks: TargetCheck[] } }) {
  return (
    <div
      role='status'
      className='rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/40'
    >
      <p className='m-0 mb-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
        {result.ok ? 'Everything works' : 'Something needs fixing'}
      </p>
      <ul className='m-0 list-none space-y-1 p-0'>
        {result.checks.map((c) => (
          <li key={c.id} className='flex items-start gap-1.5 text-[12px]'>
            {c.ok ? (
              <Check
                className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
                aria-label='Passed'
              />
            ) : (
              <X
                className='mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400'
                aria-label='Failed'
              />
            )}
            <span className='min-w-0 break-words text-slate-700 dark:text-slate-200'>
              <span className='font-medium'>{CHECK_LABEL[c.id] ?? c.id}:</span> {c.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** How a target's hostnames are made (GitLab and GitHub targets alike). */
function HostnamesGroup<D extends HostnameDraft>({
  d,
  set,
  err,
  id
}: {
  d: D
  set: (patch: Partial<D>) => void
  err: (k: keyof HostnameDraft) => string | null
  id: (f: string) => string
}) {
  const mono = 'h-8 font-mono text-[13px]'
  return (
    <FormGroup title='Hostnames'>
      <Field
        id={id('dns')}
        label='How names are made'
        hint={isManagedDns(d.dns_mode) ? managedDnsHint(d.dns_mode) : undefined}
      >
        <SimpleSelect
          value={d.dns_mode}
          onChange={(v) => set(withDnsMode(d, v as DnsMode))}
          options={DNS_OPTIONS}
          ariaLabel='How names are made'
          className='h-8 text-left text-[13px]'
          triggerProps={{ id: id('dns') }}
        />
      </Field>
      {isManagedDns(d.dns_mode) && (
        <Field
          id={id('zone')}
          label={zoneFieldWords(d.dns_mode).label}
          hint={zoneFieldWords(d.dns_mode).hint}
          error={err('dns_zone_resource_id')}
        >
          <ManagedResourcePicker
            key={d.dns_mode}
            id={id('zone')}
            type={MANAGED_DNS[d.dns_mode].zoneType}
            filter={{ scope: 'shared' }}
            value={d.dns_zone_resource_id}
            onChange={(v) => set({ dns_zone_resource_id: v } as Partial<D>)}
            placeholder={zoneFieldWords(d.dns_mode).placeholder}
          />
        </Field>
      )}
      <Field
        id={id('wild')}
        label={d.dns_mode !== 'manual' ? 'Wildcard domain' : 'Wildcard domain (optional)'}
        hint={
          d.dns_mode !== 'manual'
            ? 'Production gets <app>.<domain>, the others <app>--<env>.<domain>.'
            : 'When set, every requested name must end in it.'
        }
        error={err('wildcard_domain')}
      >
        <Input
          id={id('wild')}
          value={d.wildcard_domain}
          onChange={(e) => set({ wildcard_domain: e.target.value } as Partial<D>)}
          placeholder='apps.example.com'
          className={mono}
        />
      </Field>
      <Field
        id={id('edge')}
        label='Edge address'
        hint={
          isManagedDns(d.dns_mode)
            ? 'What each record points at: an address makes an A or AAAA record, a name a CNAME.'
            : 'Where the names point (shown in the DNS ticket).'
        }
        error={err('edge_address')}
      >
        <Input
          id={id('edge')}
          value={d.edge_address}
          onChange={(e) => set({ edge_address: e.target.value } as Partial<D>)}
          placeholder='edge.example.com or 203.0.113.10'
          className={mono}
        />
      </Field>
      <div className='grid grid-cols-[1fr_96px] gap-3'>
        <Field id={id('scheme')} label='Scheme'>
          <SimpleSelect
            value={d.scheme}
            onChange={(v) => set({ scheme: v as HostnameDraft['scheme'] } as Partial<D>)}
            options={SCHEME_OPTIONS}
            ariaLabel='Scheme'
            className='h-8 text-left text-[13px]'
            triggerProps={{ id: id('scheme') }}
          />
        </Field>
        <Field id={id('port')} label='Port' error={err('port')}>
          <Input
            id={id('port')}
            value={d.port}
            onChange={(e) => set({ port: e.target.value } as Partial<D>)}
            placeholder='443'
            inputMode='numeric'
            className={mono}
          />
        </Field>
      </div>
      <div className='sm:col-span-2'>
        <Field
          id={id('cert')}
          label='Certificate note'
          hint='How the certificate is made, for the DNS ticket (e.g. "covered by *.apps.example.com").'
        >
          <Textarea
            id={id('cert')}
            value={d.cert_note}
            onChange={(e) => set({ cert_note: e.target.value } as Partial<D>)}
            rows={2}
            className='text-[13px]'
          />
        </Field>
      </div>
    </FormGroup>
  )
}

/** A new target: pick GitLab or GitHub first, then that kind's form. */
function NewTarget({ onClose, onSaved }: { onClose: () => void; onSaved: (id: number) => void }) {
  const [kind, setKind] = useState<'gitlab' | 'github'>('gitlab')
  return (
    <div className='space-y-2'>
      <fieldset className={segmentGroup}>
        <legend className='sr-only'>Where new repositories are made</legend>
        {(
          [
            ['gitlab', 'GitLab group'],
            ['github', 'GitHub (through a connection)']
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type='button'
            aria-pressed={kind === k}
            className={segmentButton(kind === k)}
            onClick={() => setKind(k)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {kind === 'github' ? (
        <GithubTargetForm key='new-github' target={null} onClose={onClose} onSaved={onSaved} />
      ) : (
        <TargetForm key='new-gitlab' target={null} onClose={onClose} onSaved={onSaved} />
      )}
    </div>
  )
}

interface GithubDraft extends HostnameDraft {
  name: string
  connection_id: number | null
  template: string
  visibility: 'private' | 'internal'
  deploy_workflow: string
  source_branch: string
}

function githubDraftOf(t: HubGithubTarget | null): GithubDraft {
  const c: Partial<HubGithubTarget['config']> = t?.config ?? {}
  return {
    name: t?.name ?? '',
    connection_id: t?.connection_id ?? null,
    template: c.template ?? '',
    visibility: c.visibility ?? 'private',
    deploy_workflow: c.deploy_workflow ?? 'deploy.yml',
    source_branch: c.source_branch ?? 'main',
    dns_mode: dnsModeOf(c.dns_mode),
    dns_zone_resource_id: c.dns_zone_resource_id ?? null,
    wildcard_domain: c.wildcard_domain ?? '',
    edge_address: c.edge_address ?? '',
    scheme: c.scheme ?? 'https',
    port: c.port != null ? String(c.port) : '',
    cert_note: c.cert_note ?? ''
  }
}

/** What the GitHub form refuses before the API is asked (the API checks everything again). */
export function githubTargetDraftErrors(
  d: GithubDraft
): Partial<Record<keyof GithubDraft, string>> {
  const e: Partial<Record<keyof GithubDraft, string>> = {}
  if (!d.name.trim()) e.name = 'Give the target a name'
  if (!d.connection_id) e.connection_id = 'Pick the GitHub connection repositories are made through'
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(d.template.trim()))
    e.template = 'owner/repo of a template repository'
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(d.deploy_workflow.trim()))
    e.deploy_workflow = 'A workflow file name like deploy.yml'
  if (!d.source_branch.trim()) e.source_branch = 'The branch environments deploy from'
  Object.assign(e, hostnameErrors(d))
  return e
}

const VISIBILITY_OPTIONS = [
  { value: 'private', label: 'Private' },
  { value: 'internal', label: 'Internal (organisation members)' }
]

function GithubTargetForm({
  target,
  onClose,
  onSaved
}: {
  target: HubGithubTarget | null
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const qc = useQueryClient()
  const [d, setD] = useState<GithubDraft>(() => githubDraftOf(target))
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [checks, setChecks] = useState<{ ok: boolean; checks: TargetCheck[] } | null>(null)
  const [savedDraft, setSavedDraft] = useState(() => JSON.stringify(githubDraftOf(target)))
  const set = (patch: Partial<GithubDraft>) => setD((x) => ({ ...x, ...patch }))
  const errors = githubTargetDraftErrors(d)
  const invalid = Object.values(errors).some(Boolean)
  const err = (k: keyof GithubDraft) => (tried ? (errors[k] ?? null) : null)
  const dirty = JSON.stringify(d) !== savedDraft

  const save = useMutation({
    mutationFn: () =>
      saveTarget(target?.id ?? null, {
        kind: 'github',
        name: d.name.trim(),
        connection_id: d.connection_id,
        config: {
          template: d.template.trim(),
          visibility: d.visibility,
          deploy_workflow: d.deploy_workflow.trim(),
          source_branch: d.source_branch.trim(),
          ...hostnameBody(d)
        }
      }),
    onSuccess: (answer) => {
      setFailure(null)
      setSavedDraft(JSON.stringify(d))
      void qc.invalidateQueries({ queryKey: createKeys.targets() })
      if (answer.data?.id) onSaved(answer.data.id)
    },
    onError: (e) => setFailure(e)
  })
  const test = useMutation({
    mutationFn: () => testTarget(target?.id ?? 0),
    onSuccess: setChecks,
    onError: (e) => createToast(e, 'Could not test the target')
  })
  const remove = useMutation({
    mutationFn: () => deleteTarget(target?.id ?? 0),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: createKeys.targets() })
      onClose()
    },
    onError: (e) => createToast(e, 'Could not delete the target')
  })

  const id = (f: string) => `hub-ghtarget-${target?.id ?? 'new'}-${f}`
  const mono = 'h-8 font-mono text-[13px]'
  return (
    <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-start gap-3'>
        <h3 className='m-0 min-w-0 flex-1 truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {target ? target.name : 'New GitHub target'}
        </h3>
        {target && (
          <ConfirmButton
            title='Delete target'
            confirmLabel='Delete this target?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
          </ConfirmButton>
        )}
      </div>

      <FormGroup title='GitHub'>
        <Field id={id('name')} label='Name' error={err('name')}>
          <Input
            id={id('name')}
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder='Apps on GitHub'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field
          id={id('conn')}
          label='Connection'
          hint='The GitHub connection new repositories are made through. Its keys stay with the connection.'
          error={err('connection_id')}
        >
          <ConnectionPicker
            id={id('conn')}
            provider='github'
            value={d.connection_id}
            onChange={(c) => set({ connection_id: c })}
          />
        </Field>
        <Field
          id={id('template')}
          label='Template repository'
          hint='Each new repository is made from it (owner/repo, marked as a template on GitHub).'
          error={err('template')}
        >
          <Input
            id={id('template')}
            value={d.template}
            onChange={(e) => set({ template: e.target.value })}
            placeholder='acme/nivaro-app-template'
            className={mono}
          />
        </Field>
        <Field id={id('visibility')} label='Visibility'>
          <SimpleSelect
            value={d.visibility}
            onChange={(v) => set({ visibility: v === 'internal' ? 'internal' : 'private' })}
            options={VISIBILITY_OPTIONS}
            ariaLabel='Visibility'
            className='h-8 text-left text-[13px]'
            triggerProps={{ id: id('visibility') }}
          />
        </Field>
        <Field
          id={id('workflow')}
          label='Deploy workflow'
          hint='The file under .github/workflows that deploys an environment (inputs version and environment).'
          error={err('deploy_workflow')}
        >
          <Input
            id={id('workflow')}
            value={d.deploy_workflow}
            onChange={(e) => set({ deploy_workflow: e.target.value })}
            placeholder='deploy.yml'
            className={mono}
          />
        </Field>
        <Field
          id={id('branch')}
          label='Branch'
          hint='The branch environments deploy from.'
          error={err('source_branch')}
        >
          <Input
            id={id('branch')}
            value={d.source_branch}
            onChange={(e) => set({ source_branch: e.target.value })}
            placeholder='main'
            className={mono}
          />
        </Field>
      </FormGroup>

      <HostnamesGroup d={d} set={set} err={err} id={id} />

      {failure != null && (
        <ErrorNotice description={createError(failure, 'Could not save the target')} />
      )}
      {checks && <TargetChecks result={checks} />}

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
          {save.isPending ? 'Saving…' : target ? 'Save' : 'Add target'}
        </Button>
        {target && (
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
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          {target ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}
