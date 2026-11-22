import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, Globe, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { HUB_MASK } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SecretInput } from '../hub-parts'
import {
  createError,
  createKeys,
  createToast,
  deleteTarget,
  fetchTargets,
  type HubTarget,
  type HubTargetConfig,
  saveTarget,
  syncSummary,
  type TargetCheck,
  TEMPLATE_REF_RE,
  testTarget
} from './create-api'

/**
 * "Where new apps go" (Drivers tab, administrators): the GitLab targets a new app is created
 * on — namespace, template project and its pinned ref, the deploy host and how hostnames are
 * made. The token is sealed by the API and only ever shown as '••••••'.
 */
export function HubTargets() {
  const [open, setOpen] = useState(true)
  const [picked, setPicked] = useState<number | 'new' | null>(null)
  const targets = useQuery({ queryKey: createKeys.targets(), queryFn: fetchTargets })
  const current = picked === 'new' ? null : (targets.data?.find((t) => t.id === picked) ?? null)

  return (
    <section
      aria-labelledby='hub-targets-title'
      className='flex max-h-[55vh] shrink-0 flex-col border-t border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
        <button
          type='button'
          aria-expanded={open}
          aria-controls='hub-targets-body'
          onClick={() => setOpen((o) => !o)}
          className='inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
        >
          {open ? (
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-500' aria-hidden />
          ) : (
            <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-500' aria-hidden />
          )}
          <h2
            id='hub-targets-title'
            className='m-0 truncate text-[13px] font-semibold text-slate-900 dark:text-foreground'
          >
            Where new apps go
          </h2>
          {targets.data && (
            <span className='shrink-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              · {targets.data.length} {targets.data.length === 1 ? 'target' : 'targets'}
            </span>
          )}
        </button>
        <button
          type='button'
          className={cn(ghostButton, picked === 'new' && 'bg-accent')}
          onClick={() => {
            setOpen(true)
            setPicked('new')
          }}
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> New target
        </button>
      </header>

      {open && (
        <div
          id='hub-targets-body'
          className='min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50 p-3 sm:p-4 dark:bg-background'
        >
          <p className='m-0 max-w-[80ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
            A target is the GitLab namespace a new app's deploy repository is created in, the
            template it is copied from, the server it deploys to and how its hostnames are made.
          </p>
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
            <TargetForm
              key='new'
              target={null}
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
      )}
    </section>
  )
}

function TargetCard({
  target,
  active,
  onSelect
}: {
  target: HubTarget
  active: boolean
  onSelect: () => void
}) {
  const c = target.config
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
        <span
          data-tip={
            c.dns_mode === 'automatic'
              ? 'Hostnames are made under the wildcard domain'
              : 'Each hostname is requested by hand'
          }
          className='shrink-0 rounded-full border border-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
        >
          {c.dns_mode === 'automatic' ? 'Automatic names' : 'Names by hand'}
        </span>
      </span>
      <span className='mt-0.5 block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
        {c.namespace} · {c.template_project}@{c.template_ref}
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
  dns_mode: 'automatic' | 'manual'
  wildcard_domain: string
  edge_address: string
  scheme: 'https' | 'http'
  port: string
  cert_note: string
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
    dns_mode: c.dns_mode ?? 'automatic',
    wildcard_domain: c.wildcard_domain ?? '',
    edge_address: c.edge_address ?? '',
    scheme: c.scheme ?? 'https',
    port: c.port != null ? String(c.port) : '',
    cert_note: c.cert_note ?? ''
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
  if (d.dns_mode === 'automatic' && !d.wildcard_domain.trim())
    e.wildcard_domain = 'Automatic names need a wildcard domain like apps.example.com'
  const port = d.port.trim()
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535))
    e.port = 'A port from 1 to 65535, or leave empty'
  return e
}

const DNS_OPTIONS = [
  { value: 'automatic', label: 'Automatic (wildcard domain)' },
  { value: 'manual', label: 'By hand (a ticket per name)' }
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
      const opt = (v: string) => (v.trim() ? v.trim() : null)
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
          dns_mode: d.dns_mode,
          wildcard_domain: opt(d.wildcard_domain),
          edge_address: opt(d.edge_address),
          scheme: d.scheme,
          port: d.port.trim() ? Number(d.port.trim()) : null,
          cert_note: opt(d.cert_note)
        },
        // Unchanged = not sent (the stored token stays); cleared = removed.
        ...(token !== (stored ? HUB_MASK : '') ? { secret: token.trim() } : {})
      }
      return saveTarget(target?.id ?? null, body)
    },
    onSuccess: (answer) => {
      setFailure(null)
      const nextToken = answer.data?.secret ? HUB_MASK : ''
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

      <FormGroup title='Hostnames'>
        <Field id={id('dns')} label='How names are made'>
          <SimpleSelect
            value={d.dns_mode}
            onChange={(v) => set({ dns_mode: v as Draft['dns_mode'] })}
            options={DNS_OPTIONS}
            ariaLabel='How names are made'
            className='h-8 text-[13px]'
            triggerProps={{ id: id('dns') }}
          />
        </Field>
        <Field
          id={id('wild')}
          label={d.dns_mode === 'automatic' ? 'Wildcard domain' : 'Wildcard domain (optional)'}
          hint={
            d.dns_mode === 'automatic'
              ? 'Production gets <app>.<domain>, the others <app>--<env>.<domain>.'
              : 'When set, every requested name must end in it.'
          }
          error={err('wildcard_domain')}
        >
          <Input
            id={id('wild')}
            value={d.wildcard_domain}
            onChange={(e) => set({ wildcard_domain: e.target.value })}
            placeholder='apps.example.com'
            className={mono}
          />
        </Field>
        <Field
          id={id('edge')}
          label='Edge address'
          hint='Where the names point (shown in the DNS ticket).'
        >
          <Input
            id={id('edge')}
            value={d.edge_address}
            onChange={(e) => set({ edge_address: e.target.value })}
            placeholder='edge.example.com or 203.0.113.10'
            className={mono}
          />
        </Field>
        <div className='grid grid-cols-[1fr_96px] gap-3'>
          <Field id={id('scheme')} label='Scheme'>
            <SimpleSelect
              value={d.scheme}
              onChange={(v) => set({ scheme: v as Draft['scheme'] })}
              options={SCHEME_OPTIONS}
              ariaLabel='Scheme'
              className='h-8 text-[13px]'
              triggerProps={{ id: id('scheme') }}
            />
          </Field>
          <Field id={id('port')} label='Port' error={err('port')}>
            <Input
              id={id('port')}
              value={d.port}
              onChange={(e) => set({ port: e.target.value })}
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
              onChange={(e) => set({ cert_note: e.target.value })}
              rows={2}
              className='text-[13px]'
            />
          </Field>
        </div>
      </FormGroup>

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
      <legend className='mb-2 p-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
        {title}
      </legend>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>{children}</div>
    </fieldset>
  )
}

const CHECK_LABEL: Record<TargetCheck['id'], string> = {
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
