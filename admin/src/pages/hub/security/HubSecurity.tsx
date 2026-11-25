import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, RefreshCw, ScanSearch } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { HubToolbar } from '@/components/hub-page'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/lib/auth'
import { cn, formatDate, formatRelative } from '@/lib/utils'
import { HUB_MASK } from '../hub-api'
import { Field, ghostButton, SecretInput, SectionCard, smallButton } from '../hub-parts'
import {
  blobError,
  type CertRow,
  checkCerts,
  download,
  type EnvLabel,
  type Finding,
  fetchCerts,
  fetchSettings,
  fetchVulns,
  type PinnedImage,
  type SecuritySettings,
  type Severity,
  saveSettings,
  scanNow,
  securityKeys,
  securityToast
} from './security-api'
import { Chip, codeWords } from './security-parts'

/**
 * Security (Apps hub tab): certificate expiry + DNS of every environment name (warned at 30, 14
 * and 3 days), known vulnerabilities of every pinned Nivaro and extension image (from the
 * operator's scanner endpoint — nothing is sent anywhere until one is set), the per-app
 * compliance pack, and the settings. Owners see their own apps; only administrators change
 * anything.
 */
export default function HubSecurity() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  return (
    <section aria-labelledby='hub-security-title' className='flex flex-1 min-h-0 flex-col'>
      <h2 id='hub-security-title' className='sr-only'>
        Security
      </h2>
      <HubToolbar description='Certificate expiry and DNS of every environment name, known vulnerabilities of every pinned image (from your scanner), and the compliance pack per app.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <div className='space-y-4'>
          <CertificatesCard isAdmin={isAdmin} />
          <VulnerabilitiesCard isAdmin={isAdmin} />
          <ComplianceCard />
          {isAdmin && <SettingsCard />}
        </div>
      </div>
    </section>
  )
}

const primary = cn(smallButton, 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90 disabled:opacity-50')
const th = 'px-3 py-2 text-left text-[11px] font-medium text-slate-500 dark:text-muted-foreground'
const td = 'px-3 py-2 align-top text-[12px] text-slate-700 dark:text-slate-200'

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className='m-0 px-4 py-4 text-[12px] text-slate-500 dark:text-muted-foreground'>{children}</p>
)

const envOf = (envs: EnvLabel[], id: number) => envs.find((e) => e.environment_id === id)

// ─── Certificates ────────────────────────────────────────────────────────────────────────

function certWords(c: CertRow): { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string } {
  if (c.dns_ok === false) return { tone: 'bad', text: 'Name does not resolve' }
  if (c.state === 'expired') return { tone: 'bad', text: 'Expired' }
  if (c.state === 'error')
    return {
      tone: 'bad',
      text: c.authorized === false ? 'Does not verify' : 'Could not read'
    }
  if (c.state === 'warning') return { tone: 'warn', text: `${c.days_left} days left` }
  if (!c.expires_at) return { tone: 'neutral', text: 'No certificate (http)' }
  return { tone: 'good', text: `${c.days_left} days left` }
}

function CertificatesCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: securityKeys.certs(),
    queryFn: fetchCerts,
    refetchInterval: (query) => (query.state.data?.running ? 4000 : 120_000)
  })
  const check = useMutation({
    mutationFn: checkCerts,
    onSuccess: () => {
      toast.success('Checking every name now')
      void qc.invalidateQueries({ queryKey: securityKeys.certs() })
    },
    onError: (err) => securityToast(err, 'The check could not start')
  })
  const certs = q.data?.certificates ?? []
  const attention = certs.filter((c) => c.state !== 'ok').length
  return (
    <SectionCard
      title='Certificates and names'
      description={
        certs.length
          ? attention
            ? `${attention} of ${certs.length} names need attention. Owners are warned 30, 14 and 3 days before a certificate expires.`
            : `All ${certs.length} names resolve and their certificates are good for more than 30 days.`
          : 'Every environment address and hostname, checked every 6 hours.'
      }
      actions={
        isAdmin ? (
          <button
            type='button'
            className={ghostButton}
            disabled={check.isPending || q.data?.running}
            onClick={() => check.mutate()}
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5',
                q.data?.running && 'animate-spin motion-reduce:animate-none'
              )}
              aria-hidden
            />
            {q.data?.running ? 'Checking…' : 'Check now'}
          </button>
        ) : null
      }
    >
      {q.isPending ? (
        <div className='p-4'>
          <Skeleton className='h-24 w-full' />
        </div>
      ) : q.isError ? (
        <QueryErrorState
          error={q.error}
          what='the certificates'
          onRetry={() => void q.refetch()}
          className='m-3'
        />
      ) : certs.length === 0 ? (
        <Empty>Nothing checked yet. The first check runs within 6 hours, or press Check now.</Empty>
      ) : (
        <>
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 md:hidden dark:divide-border'>
            {certs.map((c) => {
              const env = envOf(q.data.environments, c.environment_id)
              const w = certWords(c)
              return (
                <li key={c.id} className='px-4 py-3'>
                  <div className='flex items-start justify-between gap-3'>
                    <span className='min-w-0 break-all text-[13px] font-medium text-slate-900 dark:text-foreground'>
                      {c.hostname}
                    </span>
                    <Chip tone={w.tone}>{w.text}</Chip>
                  </div>
                  <p className='m-0 mt-1 text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                    {[
                      env ? `${env.app_name} · ${env.env_key}` : null,
                      c.expires_at ? `expires ${formatDate(c.expires_at)}` : null,
                      c.state === 'error' && c.error_code
                        ? codeWords(c.error_code, c.error_code)
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              )
            })}
          </ul>
          <div className='hidden overflow-x-auto md:block'>
            <table className='w-full min-w-[640px] border-collapse'>
              <thead className='border-b border-slate-200 dark:border-border'>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Environment</th>
                  <th className={th}>State</th>
                  <th className={th}>Expires</th>
                  <th className={th}>Issuer</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {certs.map((c) => {
                  const env = envOf(q.data.environments, c.environment_id)
                  const w = certWords(c)
                  return (
                    <tr key={c.id}>
                      <td className={cn(td, 'font-medium text-slate-900 dark:text-foreground')}>
                        {c.hostname}
                        {c.port !== 443 && (
                          <span className='text-slate-500 dark:text-muted-foreground'>
                            :{c.port}
                          </span>
                        )}
                      </td>
                      <td className={td}>
                        <span className='inline-flex items-center gap-1.5'>
                          {env ? `${env.app_name} · ${env.env_key}` : c.environment_id}
                          <HubEnvTag envKey={env?.env_key} />
                        </span>
                      </td>
                      <td className={td}>
                        <Chip tone={w.tone}>{w.text}</Chip>
                        {c.error_code && c.state === 'error' && (
                          <span className='mt-0.5 block text-[11px] text-slate-500 dark:text-muted-foreground'>
                            {codeWords(c.error_code, c.error_code ?? '')}
                          </span>
                        )}
                      </td>
                      <td className={cn(td, 'tabular-nums')}>
                        {c.expires_at ? formatDate(c.expires_at) : '—'}
                      </td>
                      <td className={cn(td, 'text-slate-500 dark:text-muted-foreground')}>
                        {c.issuer ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  )
}

// ─── Vulnerabilities ─────────────────────────────────────────────────────────────────────

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']
const SEV_TONE: Record<Severity, 'bad' | 'warn' | 'neutral'> = {
  critical: 'bad',
  high: 'bad',
  medium: 'warn',
  low: 'neutral',
  unknown: 'neutral'
}
const SEV_WORD: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown'
}

const shortImage = (image: string) => {
  const [repo, digest] = image.split('@')
  return `${repo}@${digest?.slice(0, 19) ?? ''}`
}

function VulnerabilitiesCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: securityKeys.vulns(),
    queryFn: fetchVulns,
    refetchInterval: (query) => (query.state.data?.last_scan?.status === 'running' ? 4000 : 120_000)
  })
  const scan = useMutation({
    mutationFn: scanNow,
    onSuccess: () => {
      toast.success('Scan started')
      void qc.invalidateQueries({ queryKey: securityKeys.vulns() })
    },
    onError: (err) => securityToast(err, 'The scan could not start')
  })
  const [open, setOpen] = useState<string | null>(null)
  const d = q.data
  const running = d?.last_scan?.status === 'running'
  const total = useMemo(
    () =>
      d ? d.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length : 0,
    [d]
  )
  return (
    <SectionCard
      title='Image vulnerabilities'
      description={
        !d
          ? 'Known vulnerabilities of every pinned Nivaro and extension image.'
          : !d.scanner
            ? 'No scanner is set, so nothing is scanned and nothing leaves the Hub. An administrator sets the scanner endpoint below.'
            : d.last_scan
              ? `${total ? `${total} critical or high finding${total === 1 ? '' : 's'}. ` : ''}Last scan ${d.last_scan.finished_at ? formatRelative(d.last_scan.finished_at) : 'running'}${d.last_scan.status === 'failed' && d.last_scan.error ? ` — ${d.last_scan.error}` : ''}.`
              : 'Not scanned yet. The scan runs every night at 04:40.'
      }
      actions={
        isAdmin && d?.scanner ? (
          <button
            type='button'
            className={ghostButton}
            disabled={scan.isPending || running}
            onClick={() => scan.mutate()}
          >
            <ScanSearch className='h-3.5 w-3.5' aria-hidden />
            {running ? 'Scanning…' : 'Scan now'}
          </button>
        ) : null
      }
    >
      {q.isPending ? (
        <div className='p-4'>
          <Skeleton className='h-24 w-full' />
        </div>
      ) : q.isError ? (
        <QueryErrorState
          error={q.error}
          what='the image vulnerabilities'
          onRetry={() => void q.refetch()}
          className='m-3'
        />
      ) : q.data.images.length === 0 ? (
        <Empty>
          No pinned image yet. Images are known once an environment is deployed through a Docker
          stack or placed on a shared deployment.
        </Empty>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {q.data.images.map((img) => (
            <ImageRow
              key={img.image}
              image={img}
              envs={q.data.environments}
              findings={q.data.findings.filter((f) => f.digest === img.digest)}
              open={open === img.image}
              onToggle={() => setOpen(open === img.image ? null : img.image)}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function ImageRow({
  image,
  envs,
  findings,
  open,
  onToggle
}: {
  image: PinnedImage
  envs: EnvLabel[]
  findings: Finding[]
  open: boolean
  onToggle: () => void
}) {
  const names = image.environment_ids
    .map((id) => envOf(envs, id))
    .filter((e): e is EnvLabel => !!e)
    .map((e) => `${e.app_name} · ${e.env_key}`)
  const counts = SEV_ORDER.filter((s) => image.counts[s] > 0)
  return (
    <li>
      <button
        type='button'
        onClick={onToggle}
        aria-expanded={open}
        disabled={!findings.length}
        className='flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 text-left enabled:hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50'
      >
        <span className='min-w-0 flex-[1_1_300px]'>
          <span className='block truncate font-mono text-[12px] text-slate-900 dark:text-foreground'>
            {shortImage(image.image)}
          </span>
          <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
            {image.role === 'nivaro'
              ? 'Nivaro'
              : `Extension ${image.role.replace(/^extension:/, '')}`}{' '}
            · {names.join(', ')}
          </span>
        </span>
        <span className='flex flex-wrap items-center gap-1.5'>
          {counts.length ? (
            counts.map((s) => (
              <Chip key={s} tone={SEV_TONE[s]}>
                {image.counts[s]} {SEV_WORD[s].toLowerCase()}
              </Chip>
            ))
          ) : (
            <Chip tone='good'>No known findings</Chip>
          )}
        </span>
      </button>
      {open && (
        <div className='overflow-x-auto border-t border-slate-100 bg-slate-50/60 dark:border-border dark:bg-muted/30'>
          <table className='w-full min-w-[600px] border-collapse'>
            <thead>
              <tr>
                <th className={th}>Severity</th>
                <th className={th}>Vulnerability</th>
                <th className={th}>Package</th>
                <th className={th}>Fix</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {findings.map((f) => (
                <tr key={f.id}>
                  <td className={td}>
                    <Chip tone={SEV_TONE[f.severity]}>{SEV_WORD[f.severity]}</Chip>
                  </td>
                  <td className={td}>
                    {f.url && /^https:\/\//i.test(f.url) ? (
                      <a
                        href={f.url}
                        target='_blank'
                        rel='noreferrer noopener'
                        className='inline-flex items-center gap-1 font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400'
                      >
                        {f.vuln_id} <ExternalLink className='h-3 w-3' aria-hidden />
                      </a>
                    ) : (
                      <span className='font-medium'>{f.vuln_id}</span>
                    )}
                    {f.summary && (
                      <span className='mt-0.5 block max-w-[60ch] text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {f.summary}
                      </span>
                    )}
                  </td>
                  <td className={cn(td, 'font-mono text-[11px]')}>
                    {f.package}
                    {f.installed ? ` ${f.installed}` : ''}
                  </td>
                  <td className={td}>
                    {f.fixed_in ? (
                      <>
                        Fixed in <span className='font-mono text-[11px]'>{f.fixed_in}</span>
                        <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {image.role === 'nivaro'
                            ? 'Promote a release built on it (Releases).'
                            : 'Pin an extension image built on it.'}
                        </span>
                      </>
                    ) : (
                      <span className='text-slate-500 dark:text-muted-foreground'>No fix yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  )
}

// ─── Compliance pack ─────────────────────────────────────────────────────────────────────

function ComplianceCard() {
  const q = useQuery({ queryKey: securityKeys.certs(), queryFn: fetchCerts })
  const apps = useMemo(() => {
    const out: Array<{ id: number; key: string; name: string }> = []
    for (const e of q.data?.environments ?? [])
      if (!out.some((a) => a.id === e.app_id))
        out.push({ id: e.app_id, key: e.app_key, name: e.app_name })
    return out
  }, [q.data])
  const [appId, setAppId] = useState('')
  const [months, setMonths] = useState('12')
  const [busy, setBusy] = useState(false)
  const chosen = appId || (apps[0] ? String(apps[0].id) : '')
  const app = apps.find((a) => String(a.id) === chosen)
  const get = async () => {
    if (!app) return
    setBusy(true)
    try {
      await download(`/hub/apps/${app.id}/compliance-pack`, `compliance-${app.key}.zip`, {
        months: Number(months)
      })
    } catch (err) {
      securityToast(await blobError(err), 'The compliance pack could not be made')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SectionCard
      title='Compliance pack'
      description='One zip for an auditor: a summary PDF and CSVs of deploys, access reviews, break-glass access, backups and restore drills, secret rotations, incidents, certificates and vulnerabilities. It never carries a secret.'
    >
      {apps.length === 0 ? (
        <Empty>No app to report on.</Empty>
      ) : (
        <div className='flex flex-wrap items-end gap-3 px-4 py-4'>
          <Field id='cp-app' label='App'>
            <SimpleSelect
              value={chosen}
              onChange={setAppId}
              ariaLabel='App'
              options={apps.map((a) => ({ value: String(a.id), label: a.name }))}
              className='h-8 w-[200px] text-[13px]'
            />
          </Field>
          <Field id='cp-months' label='Covering'>
            <SimpleSelect
              value={months}
              onChange={setMonths}
              ariaLabel='Months covered'
              options={[
                { value: '3', label: 'Last 3 months' },
                { value: '6', label: 'Last 6 months' },
                { value: '12', label: 'Last 12 months' },
                { value: '24', label: 'Last 24 months' }
              ]}
              className='h-8 w-[170px] text-[13px]'
            />
          </Field>
          <button
            type='button'
            className={primary}
            disabled={!app || busy}
            onClick={() => void get()}
          >
            <Download className='h-3.5 w-3.5' aria-hidden />
            {busy ? 'Building…' : 'Download pack'}
          </button>
        </div>
      )}
    </SectionCard>
  )
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────

function SettingsCard() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: securityKeys.settings(), queryFn: fetchSettings })
  const [draft, setDraft] = useState<Partial<SecuritySettings>>({})
  const save = useMutation({
    mutationFn: () => saveSettings(draft),
    onSuccess: () => {
      toast.success('Security settings saved')
      setDraft({})
      void qc.invalidateQueries({ queryKey: securityKeys.settings() })
      void qc.invalidateQueries({ queryKey: securityKeys.vulns() })
      void qc.invalidateQueries({ queryKey: securityKeys.breakGlass() })
    },
    onError: (err) => securityToast(err, 'The settings could not be saved')
  })
  if (q.isPending)
    return (
      <SectionCard title='Settings'>
        <div className='p-4'>
          <Skeleton className='h-20 w-full' />
        </div>
      </SectionCard>
    )
  if (q.isError)
    return (
      <SectionCard title='Settings'>
        <QueryErrorState
          error={q.error}
          what='the security settings'
          onRetry={() => void q.refetch()}
          className='m-3'
        />
      </SectionCard>
    )
  const s = { ...q.data, ...draft }
  const dirty = Object.keys(draft).length > 0
  return (
    <SectionCard
      title='Settings'
      description='Hub administrators only.'
      actions={
        <button
          type='button'
          className={primary}
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div className='grid gap-4 px-4 py-4 md:grid-cols-2'>
        <Field
          id='sec-scanner'
          label='Scanner endpoint'
          hint='An https service that answers POST /scan {image} with its known vulnerabilities (a Trivy, Grype or OSV wrapper). Empty = no scan and no outbound call. A scanner on this machine or a private address must be named in SSRF_ALLOW_HOSTS.'
        >
          <Input
            id='sec-scanner'
            value={s.scanner_url ?? ''}
            placeholder='https://scanner.example.internal'
            onChange={(e) => setDraft((d) => ({ ...d, scanner_url: e.target.value || null }))}
            className='h-8 font-mono text-[13px]'
            spellCheck={false}
          />
        </Field>
        <Field
          id='sec-token'
          label='Scanner token'
          hint='Sent as a bearer to the scanner only. Stored sealed; never shown again.'
        >
          <SecretInput
            id='sec-token'
            value={draft.scanner_token ?? (q.data.scanner_token ? HUB_MASK : '')}
            stored={!!q.data.scanner_token}
            onChange={(v) => setDraft((d) => ({ ...d, scanner_token: v }))}
            placeholder='Optional'
          />
        </Field>
        <Field
          id='sec-hours'
          label='Longest break-glass grant'
          hint='What a request may ask for. Every grant ends by itself.'
        >
          <SimpleSelect
            value={String(s.break_glass_max_hours)}
            onChange={(v) => setDraft((d) => ({ ...d, break_glass_max_hours: Number(v) }))}
            ariaLabel='Longest break-glass grant'
            options={[1, 2, 4, 8, 12, 24].map((h) => ({
              value: String(h),
              label: `${h} hour${h === 1 ? '' : 's'}`
            }))}
            className='h-8 w-[160px] text-[13px]'
          />
        </Field>
        <div className='flex items-start gap-3 pt-5'>
          <Switch
            id='sec-tls'
            checked={s.tls_watch}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, tls_watch: v }))}
          />
          <label htmlFor='sec-tls' className='text-[12px] text-slate-700 dark:text-slate-200'>
            <span className='block font-medium'>Watch certificates and names</span>
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              Every 6 hours; owners and Hub administrators are warned 30, 14 and 3 days before a
              certificate expires, and when a name stops resolving.
            </span>
          </label>
        </div>
      </div>
    </SectionCard>
  )
}
