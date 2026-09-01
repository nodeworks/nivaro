import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BrainCircuit,
  Check,
  Clock,
  Database,
  Download,
  Globe,
  HardDrive,
  KeyRound,
  Mail,
  MessageSquare,
  Palette,
  Plus,
  Radio,
  Send,
  Server,
  Settings2,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { usePersistedTab } from '@/hooks/usePersistedTab'
import { api, type CMSSettings, type Role } from '@/lib/api'
import { ADMIN_LOCALES, useLocale } from '@/lib/i18n'
import { applyThemeSettings, THEME_RADIUS_PRESETS } from '@/lib/theme-settings'
import { useSettings } from '@/lib/useSettings'
import { cn } from '@/lib/utils'

const LANGUAGES = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'es-ES', label: 'Spanish' }
]

type AdGroupRow = { ad_group_id: string; role_id: string }

/** available_locales is stored as a JSON array (nvarchar) on nivaro_settings. */
function toLocaleArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
    } catch {
      /* fall through */
    }
  }
  return ['en']
}
const EMAIL_PROVIDERS: Array<{ label: string; host: string; port: number; secure: boolean }> = [
  { label: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false },
  { label: 'Outlook / Office 365', host: 'smtp.office365.com', port: 587, secure: false },
  { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
  { label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, secure: false },
  { label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false },
  { label: 'Postmark', host: 'smtp.postmarkapp.com', port: 587, secure: false },
  { label: 'Resend', host: 'smtp.resend.com', port: 465, secure: true },
  { label: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, secure: false },
  { label: 'Mailchimp / Mandrill', host: 'smtp.mandrillapp.com', port: 587, secure: false },
  { label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 587, secure: false }
]

const SMS_PROVIDERS: Array<{
  value: string
  label: string
  sidLabel: string
  sidPlaceholder: string
  tokenLabel: string
  tokenPlaceholder: string
  hasRegion?: boolean
}> = [
  {
    value: 'twilio',
    label: 'Twilio',
    sidLabel: 'Account SID',
    sidPlaceholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    tokenLabel: 'Auth token',
    tokenPlaceholder: 'your_auth_token'
  },
  {
    value: 'aws-sns',
    label: 'Amazon SNS',
    sidLabel: 'Access key ID',
    sidPlaceholder: 'AKIAIOSFODNN7EXAMPLE',
    tokenLabel: 'Secret access key',
    tokenPlaceholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    hasRegion: true
  },
  {
    value: 'vonage',
    label: 'Vonage (Nexmo)',
    sidLabel: 'API key',
    sidPlaceholder: 'a1b2c3d4',
    tokenLabel: 'API secret',
    tokenPlaceholder: 'your_api_secret'
  },
  {
    value: 'sinch',
    label: 'Sinch',
    sidLabel: 'Service plan ID',
    sidPlaceholder: 'your_service_plan_id',
    tokenLabel: 'API token',
    tokenPlaceholder: 'your_api_token'
  },
  {
    value: 'messagebird',
    label: 'MessageBird',
    sidLabel: 'API key',
    sidPlaceholder: 'your_api_key',
    tokenLabel: 'API key (repeated)',
    tokenPlaceholder: 'same as API key'
  }
]

type Section =
  | 'project'
  | 'appearance'
  | 'localization'
  | 'microsoft'
  | 'ai'
  | 'presence'
  | 'sla'
  | 'content'
  | 'email'
  | 'sms'
  | 'sso'
  | 'profile-fields'
  | 'storage'
  | 'backups'
  | 'instance'

const NAV: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'project', label: 'Project', icon: <Settings2 className='h-3.5 w-3.5' /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette className='h-3.5 w-3.5' /> },
  { id: 'localization', label: 'Localization', icon: <Globe className='h-3.5 w-3.5' /> },
  { id: 'microsoft', label: 'Microsoft', icon: <MessageSquare className='h-3.5 w-3.5' /> },
  { id: 'ai', label: 'AI Features', icon: <BrainCircuit className='h-3.5 w-3.5' /> },
  { id: 'presence', label: 'Presence', icon: <Radio className='h-3.5 w-3.5' /> },
  { id: 'sla', label: 'SLA', icon: <Clock className='h-3.5 w-3.5' /> },
  { id: 'content', label: 'Content', icon: <Database className='h-3.5 w-3.5' /> },
  { id: 'email', label: 'Email', icon: <Mail className='h-3.5 w-3.5' /> },
  { id: 'sms', label: 'SMS', icon: <MessageSquare className='h-3.5 w-3.5' /> },
  { id: 'sso', label: 'Sign-in providers', icon: <KeyRound className='h-3.5 w-3.5' /> },
  { id: 'profile-fields', label: 'Profile fields', icon: <UserRound className='h-3.5 w-3.5' /> },
  { id: 'storage', label: 'File storage', icon: <HardDrive className='h-3.5 w-3.5' /> },
  { id: 'backups', label: 'Backups', icon: <Download className='h-3.5 w-3.5' /> },
  { id: 'instance', label: 'This Instance', icon: <Server className='h-3.5 w-3.5' /> }
]

const AI_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku — fast, economical' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet — balanced' },
  { value: 'claude-opus-4-8', label: 'Opus — most capable' }
]

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' }
]

// ─── Section wrapper ──────────────────────────────────────────────────────────

function SectionWrap({
  title,
  children,
  onSave,
  saving
}: {
  title: string
  children: React.ReactNode
  onSave: () => void
  saving: boolean
}) {
  return (
    <div className='p-8'>
      <div className='max-w-lg'>
        <h2 className='mb-6 text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          {title}
        </h2>
        <div className='space-y-5'>{children}</div>
        <div className='mt-7 border-t border-slate-100 pt-5 dark:border-border'>
          <Button size='sm' onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Per-instance overrides section ──────────────────────────────────────────
// Several instances (local dev + staging) can share ONE database and therefore
// one settings row — this section overrides individual settings for THIS
// instance only (keyed by NIVARO_INSTANCE env, defaulting to NODE_ENV).
// Typical use: a local SMTP setup while staging keeps the relay config.

const INSTANCE_OVERRIDE_KEYS = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'smtp_secure',
  'mail_test_mode',
  'mail_test_recipient',
  'mail_test_allowlist',
  'environment_label',
  'sms_provider',
  'sms_account_sid',
  'sms_auth_token',
  'sms_from',
  'sms_region',
  'sms_test_mode',
  'sms_test_recipient',
  'sms_test_allowlist'
]

function coerceOverrideValue(raw: string): unknown {
  const v = raw.trim()
  if (v === '') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

function InstanceOverridesSection() {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['instance-overrides'],
    queryFn: () =>
      api
        .get<{ data: { instance_key: string; overrides: Record<string, unknown> } }>(
          '/settings/instance-overrides'
        )
        .then((r) => r.data.data)
  })
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([])
  const [hydrated, setHydrated] = useState(false)
  if (data && !hydrated) {
    setRows(
      Object.entries(data.overrides).map(([key, v]) => ({ key, value: v == null ? '' : String(v) }))
    )
    setHydrated(true)
  }
  const save = useMutation({
    mutationFn: () => {
      const overrides: Record<string, unknown> = {}
      for (const r of rows) {
        if (r.key) overrides[r.key] = coerceOverrideValue(r.value)
      }
      return api.put('/settings/instance-overrides', { overrides })
    },
    onSuccess: () => {
      toast.success('Instance overrides saved')
      queryClient.invalidateQueries({ queryKey: ['instance-overrides'] })
    },
    onError: () => toast.error('Could not save overrides')
  })
  const unused = INSTANCE_OVERRIDE_KEYS.filter((k) => !rows.some((r) => r.key === k))
  return (
    <SectionWrap title='This Instance' onSave={() => save.mutate()} saving={save.isPending}>
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Overrides for{' '}
        <span className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11.5px] text-slate-700 dark:bg-muted dark:text-slate-300'>
          {data?.instance_key ?? '…'}
        </span>{' '}
        only. When several environments share this database, values set here win over the shared
        settings on this instance — e.g. a local mail server while staging keeps its relay. Leave a
        value blank to force the setting back to this instance's env-var fallback.
      </p>
      <div className='space-y-2'>
        {rows.map((r, i) => (
          <div key={i} className='flex items-center gap-2'>
            <div className='w-52 shrink-0'>
              <Select
                value={r.key}
                onValueChange={(v) =>
                  setRows((rs) => rs.map((x, j) => (j === i ? { ...x, key: v } : x)))
                }
              >
                <SelectTrigger className='h-8 text-[12px]'>
                  <SelectValue placeholder='Setting…' />
                </SelectTrigger>
                <SelectContent>
                  {[r.key, ...unused].filter(Boolean).map((k) => (
                    <SelectItem key={k} value={k} className='font-mono text-[12px]'>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              value={r.value}
              onChange={(e) =>
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
              placeholder='value (blank = clear to env fallback)'
              className='h-8 flex-1 text-[12.5px]'
            />
            <button
              type='button'
              className='rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-500 dark:hover:bg-accent'
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              aria-label='Remove override'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
        ))}
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='gap-1.5'
          disabled={unused.length === 0}
          onClick={() => setRows((rs) => [...rs, { key: unused[0] ?? '', value: '' }])}
        >
          <Plus className='h-3.5 w-3.5' />
          Add override
        </Button>
      </div>
    </SectionWrap>
  )
}

// ─── Backups section ──────────────────────────────────────────────────────────

function BackupsSection() {
  const [includeSystem, setIncludeSystem] = useState(false)
  const { data: manifest } = useQuery({
    queryKey: ['backup-manifest', includeSystem],
    queryFn: () =>
      api
        .get<{ data: { business: string[]; system: string[]; excluded: string[] } }>(
          '/backups/manifest',
          { params: { include_system: includeSystem } }
        )
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  return (
    <div className='p-8'>
      <div className='max-w-lg'>
        <h2 className='mb-2 text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          Backups
        </h2>
        <p className='mb-6 text-[12px] text-muted-foreground'>
          Download a logical backup of this instance — a gzip stream of newline-delimited JSON, one
          record per row, restorable with standard tooling. Files on disk/object storage are not
          included.
        </p>
        <div className='space-y-4'>
          <label className='flex items-start gap-2 text-[13px] text-slate-700 dark:text-slate-300'>
            <input
              type='checkbox'
              checked={includeSystem}
              onChange={(e) => setIncludeSystem(e.target.checked)}
              className='mt-0.5'
            />
            <span>
              Include system configuration tables
              <span className='block text-[11px] text-muted-foreground'>
                Schema registry, roles, policies, workflows, layouts… Volatile tables (sessions,
                logs, caches, embeddings) are always excluded.
              </span>
            </span>
          </label>
          {manifest && (
            <p className='text-[12px] text-muted-foreground'>
              {manifest.business.length} business collection
              {manifest.business.length !== 1 ? 's' : ''}
              {includeSystem ? ` + ${manifest.system.length} system tables` : ''} will be exported.
            </p>
          )}
          <Button
            size='sm'
            onClick={() =>
              window.open(`/api/backups/export?include_system=${includeSystem}`, '_blank')
            }
          >
            <Download className='mr-1.5 h-3.5 w-3.5' />
            Download backup
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Custom profile fields (#683) ────────────────────────────────────────────
// Admin-defined extra user fields (cost center, skills, floor…) stored in the
// generic EAV tables with collection='nivaro_users'; users self-serve values
// on their Profile page.

interface ProfileFieldDef {
  id: number
  key: string
  label: string
  type: string
  options: unknown
  required: boolean | number
  sort: number
  is_active: boolean | number
}

function ProfileFieldDefsSection() {
  const qc = useQueryClient()
  const { data: defs = [] } = useQuery({
    queryKey: ['profile-field-defs'],
    queryFn: () =>
      api
        .get<{ data: ProfileFieldDef[] }>('/attribute-definitions?collection=nivaro_users')
        .then((r) => r.data.data)
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['profile-field-defs'] })
  const [nf, setNf] = useState({ key: '', label: '', type: 'text', choices: '' })

  const create = useMutation({
    mutationFn: () =>
      api.post('/attribute-definitions', {
        collection: 'nivaro_users',
        key: nf.key.trim(),
        label: nf.label.trim(),
        type: nf.type,
        options:
          nf.type === 'select' && nf.choices.trim()
            ? nf.choices
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean)
            : null,
        sort: defs.length
      }),
    onSuccess: () => {
      setNf({ key: '', label: '', type: 'text', choices: '' })
      invalidate()
      toast.success('Field added')
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Create failed'
      )
  })
  const patchDef = useMutation({
    mutationFn: (p: { id: number } & Record<string, unknown>) =>
      api.patch(`/attribute-definitions/${p.id}`, p),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/attribute-definitions/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Field removed (values cleaned up)')
    }
  })

  return (
    <div className='p-8'>
      <div className='max-w-[720px] space-y-4'>
        <div>
          <h2 className='text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            Custom profile fields
          </h2>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Extra fields every user can fill in on their own profile — cost center, skills, office
            floor, anything your org tracks about people.
          </p>
        </div>
        <div className='space-y-2'>
          {defs.map((d) => (
            <div
              key={d.id}
              className='flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
            >
              <Switch
                checked={d.is_active === true || d.is_active === 1}
                onCheckedChange={(v) => patchDef.mutate({ id: d.id, is_active: v })}
              />
              <span className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                {d.label}
              </span>
              <code className='font-mono text-[11px] text-slate-400'>{d.key}</code>
              <Badge variant='secondary' className='text-[10px]'>
                {d.type}
              </Badge>
              <button
                type='button'
                onClick={() => remove.mutate(d.id)}
                className='ml-auto rounded p-1 text-slate-400 hover:text-red-500'
                aria-label='Delete field'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </div>
          ))}
          {defs.length === 0 && <p className='text-[12px] text-slate-400'>No custom fields yet.</p>}
        </div>
        <div className='rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/20'>
          <p className='mb-2 text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
            Add a field
          </p>
          <div className='flex flex-wrap items-end gap-2'>
            <div>
              <p className='mb-1 text-[10.5px] text-slate-500'>Label</p>
              <Input
                value={nf.label}
                onChange={(e) =>
                  setNf({
                    ...nf,
                    label: e.target.value,
                    key:
                      nf.key ||
                      e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_|_$/g, '')
                  })
                }
                placeholder='Cost center'
                className='h-8 w-44 text-[12.5px]'
              />
            </div>
            <div>
              <p className='mb-1 text-[10.5px] text-slate-500'>Key</p>
              <Input
                value={nf.key}
                onChange={(e) => setNf({ ...nf, key: e.target.value })}
                placeholder='cost_center'
                className='h-8 w-36 font-mono text-[12px]'
              />
            </div>
            <div>
              <p className='mb-1 text-[10.5px] text-slate-500'>Type</p>
              <Select value={nf.type} onValueChange={(v) => setNf({ ...nf, type: v })}>
                <SelectTrigger className='h-8 w-28 text-[12px]'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['text', 'number', 'boolean', 'date', 'select'].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {nf.type === 'select' && (
              <div>
                <p className='mb-1 text-[10.5px] text-slate-500'>Choices (comma list)</p>
                <Input
                  value={nf.choices}
                  onChange={(e) => setNf({ ...nf, choices: e.target.value })}
                  placeholder='Remote, Hybrid, On-site'
                  className='h-8 w-52 text-[12.5px]'
                />
              </div>
            )}
            <Button
              size='sm'
              className='h-8'
              disabled={!nf.key.trim() || !nf.label.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Add
            </Button>
          </div>
        </div>
        <p className='text-[11px] text-slate-400'>
          Values are self-served on each user&apos;s Profile page. Deactivating hides a field
          without deleting stored values; deleting removes both.
        </p>
      </div>
    </div>
  )
}

// ─── Sign-in providers section (#538) ────────────────────────────────────────
// Additional OIDC providers beyond the primary env-configured issuer. Each
// active row is a "Continue with <label>" button on the login page.

interface SsoProvider {
  id: number
  key: string
  label: string
  issuer: string
  client_id: string
  client_secret: string | null
  scopes: string | null
  logo_url: string | null
  button_color: string | null
  is_active: boolean
  sort: number
}

/** Raw <svg> markup pasted into the logo field becomes a data URI the login
 *  page's <img> can render; anything else passes through untouched. */
function normalizeLogoInput(v: string): string {
  const t = v.trim()
  if (!t.toLowerCase().startsWith('<svg')) return v
  try {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(t)))}`
  } catch {
    return v
  }
}

const BUTTON_COLOR_PRESETS: Array<{ value: string; swatch: string; label: string }> = [
  { value: '#0a66c2', swatch: '#0a66c2', label: 'Blue' },
  { value: '#6264a7', swatch: '#6264a7', label: 'Purple' },
  { value: '#d93025', swatch: '#d93025', label: 'Red' },
  { value: '#059669', swatch: '#059669', label: 'Green' },
  { value: '#f59e0b', swatch: '#f59e0b', label: 'Amber' },
  { value: '#24292f', swatch: '#24292f', label: 'Black' }
]

const EMPTY_SSO_DRAFT = {
  key: '',
  label: '',
  issuer: '',
  client_id: '',
  client_secret: '',
  scopes: 'openid profile email',
  logo_url: '',
  button_color: '',
  is_active: true
}

function SsoProvidersSection() {
  const queryClient = useQueryClient()
  interface DefaultProvider {
    label: string
    issuer: string
    client_id: string
    effective_enabled: boolean
    disabled_by_env: boolean
    disabled_in_settings: boolean
    can_disable: boolean
  }
  const { data: ssoPayload, isLoading } = useQuery<{
    data: SsoProvider[]
    default_provider: DefaultProvider | null
  }>({
    queryKey: ['sso-providers'],
    queryFn: () =>
      api
        .get<{ data: SsoProvider[]; default_provider: DefaultProvider | null }>('/sso-providers')
        .then((r) => r.data)
  })
  const providers = ssoPayload?.data ?? []
  const defaultProvider = ssoPayload?.default_provider ?? null
  const toggleDefault = useMutation({
    mutationFn: (is_active: boolean) => api.patch('/sso-providers/default', { is_active }),
    onSuccess: () => {
      invalidate()
      toast.success('Default provider updated')
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Could not update the default provider'
      toast.error(msg)
    }
  })
  const [editingId, setEditingId] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState(EMPTY_SSO_DRAFT)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sso-providers'] })

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        key: draft.key.trim(),
        label: draft.label.trim(),
        issuer: draft.issuer.trim(),
        client_id: draft.client_id.trim(),
        client_secret: draft.client_secret || null,
        scopes: draft.scopes.trim() || null,
        logo_url: draft.logo_url.trim() || null,
        button_color: draft.button_color.trim() || null,
        is_active: draft.is_active
      }
      if (editingId === 'new') await api.post('/sso-providers', body)
      else await api.patch(`/sso-providers/${editingId}`, body)
    },
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      setDraft(EMPTY_SSO_DRAFT)
      toast.success('Sign-in provider saved')
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Failed to save provider')
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/sso-providers/${id}`),
    onSuccess: () => {
      invalidate()
      setPendingDelete(null)
      toast.success('Provider removed')
    },
    onError: () => toast.error('Failed to remove provider')
  })

  const toggleActive = useMutation({
    mutationFn: (p: SsoProvider) =>
      api.patch(`/sso-providers/${p.id}`, { is_active: !p.is_active }),
    onSuccess: invalidate,
    onError: () => toast.error('Failed to update provider')
  })

  function startEdit(p: SsoProvider) {
    setEditingId(p.id)
    setDraft({
      key: p.key,
      label: p.label,
      issuer: p.issuer,
      client_id: p.client_id,
      client_secret: p.client_secret ?? '',
      scopes: p.scopes ?? '',
      logo_url: p.logo_url ?? '',
      button_color: p.button_color ?? '',
      is_active: p.is_active
    })
  }

  return (
    <div className='p-8'>
      <div className='max-w-lg'>
        <h2 className='mb-2 text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          Sign-in providers
        </h2>
        <p className='mb-6 text-[12px] text-muted-foreground'>
          Additional OIDC identity providers beyond the primary one this deployment is configured
          with. Each active provider becomes a "Continue with …" button on the login page and runs
          the same PKCE flow. Register the callback URL{' '}
          <span className='font-mono text-[11px]'>{window.location.origin}/api/auth/callback</span>{' '}
          with the identity provider.
        </p>

        <div className='space-y-2'>
          {isLoading && <Skeleton className='h-12 w-full rounded-lg' />}
          {!isLoading && defaultProvider && (
            <div className='rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/30'>
              <div className='flex items-center gap-2'>
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                    {defaultProvider.label}
                    <span className='ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                      Default · from .env
                    </span>
                  </p>
                  <p className='mt-0.5 truncate font-mono text-[10.5px] text-slate-400'>
                    {defaultProvider.issuer}
                  </p>
                </div>
                <Switch
                  checked={defaultProvider.effective_enabled}
                  disabled={
                    toggleDefault.isPending ||
                    defaultProvider.disabled_by_env ||
                    (defaultProvider.effective_enabled && !defaultProvider.can_disable)
                  }
                  onCheckedChange={(v) => toggleDefault.mutate(v)}
                />
              </div>
              {defaultProvider.disabled_by_env && (
                <p className='mt-1.5 text-[11px] text-amber-600 dark:text-amber-400'>
                  Disabled by OIDC_ENABLED=false in the deployment environment — the toggle here
                  can't override it.
                </p>
              )}
              {!defaultProvider.disabled_by_env &&
                defaultProvider.effective_enabled &&
                !defaultProvider.can_disable && (
                  <p className='mt-1.5 text-[11px] text-slate-400 dark:text-muted-foreground'>
                    Add and enable a custom provider below before disabling the default — with no
                    alternative it would lock everyone out.
                  </p>
                )}
              {defaultProvider.disabled_in_settings && !defaultProvider.effective_enabled && (
                <p className='mt-1.5 text-[11px] text-slate-400 dark:text-muted-foreground'>
                  Hidden from the login page — custom providers below carry sign-in.
                </p>
              )}
            </div>
          )}
          {!isLoading && providers.length === 0 && editingId === null && (
            <p className='rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-[12px] text-slate-400 dark:border-border'>
              No additional providers configured. The primary sign-in button is unaffected.
            </p>
          )}
          {providers.map((p) => (
            <div
              key={p.id}
              className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
            >
              <div className='flex items-center gap-2'>
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                    {p.label}
                    <span className='ml-2 font-mono text-[10.5px] text-slate-400'>{p.key}</span>
                  </p>
                  <p className='truncate text-[11px] text-slate-400'>{p.issuer}</p>
                </div>
                <Switch
                  checked={p.is_active}
                  onCheckedChange={() => toggleActive.mutate(p)}
                  aria-label={`${p.label} active`}
                />
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 px-2 text-[11.5px]'
                  onClick={() => startEdit(p)}
                >
                  Edit
                </Button>
                {pendingDelete === p.id ? (
                  <>
                    <Button
                      size='sm'
                      variant='destructive'
                      className='h-7 px-2 text-[11.5px]'
                      onClick={() => remove.mutate(p.id)}
                    >
                      Confirm
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 px-2 text-[11.5px]'
                      onClick={() => setPendingDelete(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 px-2 text-slate-400 hover:text-red-500'
                    onClick={() => setPendingDelete(p.id)}
                    aria-label={`Remove ${p.label}`}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {editingId === null ? (
          <Button
            size='sm'
            variant='outline'
            className='mt-4 gap-1.5'
            onClick={() => {
              setEditingId('new')
              setDraft(EMPTY_SSO_DRAFT)
            }}
          >
            <Plus className='h-3.5 w-3.5' />
            Add provider
          </Button>
        ) : (
          <div className='mt-4 space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <p className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
              {editingId === 'new' ? 'New provider' : 'Edit provider'}
            </p>
            <Field label='Name' hint='Shown on the login button — "Continue with <name>".'>
              <Input
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                placeholder='Okta'
                className='h-8 text-[13px]'
              />
            </Field>
            <Field
              label='Key'
              hint='URL slug for the login link. Lowercase letters, digits, dashes.'
            >
              <Input
                value={draft.key}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    key: e.target.value.toLowerCase().replace(/\s+/g, '-')
                  }))
                }
                placeholder='okta'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field
              label='Issuer URL'
              hint='The OIDC issuer — discovery runs against <issuer>/.well-known/openid-configuration.'
            >
              <Input
                value={draft.issuer}
                onChange={(e) => setDraft((d) => ({ ...d, issuer: e.target.value }))}
                placeholder='https://your-org.okta.com'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field label='Client ID'>
              <Input
                value={draft.client_id}
                onChange={(e) => setDraft((d) => ({ ...d, client_id: e.target.value }))}
                className='h-8 font-mono text-[13px]'
                autoComplete='off'
              />
            </Field>
            <Field
              label='Client secret'
              hint={
                editingId !== 'new' && draft.client_secret === '••••••'
                  ? 'Configured. Enter a new value to replace.'
                  : 'Optional for providers using PKCE-only public clients.'
              }
            >
              <Input
                type='password'
                value={draft.client_secret}
                onChange={(e) => setDraft((d) => ({ ...d, client_secret: e.target.value }))}
                placeholder='••••••••'
                className='h-8 font-mono text-[13px]'
                autoComplete='new-password'
              />
            </Field>
            <Field label='Scopes' hint='Space or comma separated. "openid" is always requested.'>
              <Input
                value={draft.scopes}
                onChange={(e) => setDraft((d) => ({ ...d, scopes: e.target.value }))}
                placeholder='openid profile email'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field
              label='Logo'
              hint='Optional icon on the login button — paste raw <svg> markup, an https image URL, or a data:image URI.'
            >
              <div className='flex items-start gap-2'>
                <textarea
                  value={draft.logo_url}
                  onChange={(e) => setDraft((d) => ({ ...d, logo_url: normalizeLogoInput(e.target.value) }))}
                  placeholder='<svg …>, https://… or data:image/png;base64,…'
                  rows={2}
                  className='min-h-[32px] w-full rounded-md border border-slate-200 bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none transition-colors focus:border-slate-400 dark:border-border'
                />
                {draft.logo_url.trim() !== '' && (
                  <img
                    src={draft.logo_url.trim()}
                    alt=''
                    className='mt-1 h-6 w-6 shrink-0 rounded object-contain'
                  />
                )}
              </div>
            </Field>
            <Field
              label='Button color'
              hint="Pick a preset, the theme's accent, or any hex / CSS color. Empty = the default button style."
            >
              <div className='flex flex-wrap items-center gap-2'>
                {/* Sensible defaults + the theme accent */}
                {BUTTON_COLOR_PRESETS.map((c) => (
                  <button
                    key={c.value}
                    type='button'
                    title={c.label}
                    aria-label={`Use ${c.label}`}
                    onClick={() => setDraft((d) => ({ ...d, button_color: c.value }))}
                    className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                      draft.button_color.trim() === c.value
                        ? 'border-slate-900 dark:border-white'
                        : 'border-transparent'
                    }`}
                    style={{ backgroundColor: c.swatch }}
                  />
                ))}
                <button
                  type='button'
                  onClick={() => setDraft((d) => ({ ...d, button_color: 'accent' }))}
                  className={`h-7 rounded-full border-2 bg-[#00ceff] px-2.5 text-[11px] font-semibold text-slate-900 transition-transform hover:scale-105 ${
                    draft.button_color.trim() === 'accent'
                      ? 'border-slate-900 dark:border-white'
                      : 'border-transparent'
                  }`}
                  title="The portal theme's accent color"
                >
                  Accent
                </button>
                <Input
                  value={draft.button_color}
                  onChange={(e) => setDraft((d) => ({ ...d, button_color: e.target.value }))}
                  placeholder='#0a66c2'
                  className='h-8 w-32 font-mono text-[13px]'
                />
                <input
                  type='color'
                  aria-label='Pick button color'
                  value={/^#[0-9a-fA-F]{6}$/.test(draft.button_color.trim()) ? draft.button_color.trim() : '#00ceff'}
                  onChange={(e) => setDraft((d) => ({ ...d, button_color: e.target.value }))}
                  className='h-8 w-10 cursor-pointer rounded border border-slate-200 bg-transparent dark:border-border'
                />
              </div>
            </Field>
            <div className='flex items-center justify-between'>
              <span className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                Active
              </span>
              <Switch
                checked={draft.is_active}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
              />
            </div>
            <div className='flex gap-2 border-t border-slate-100 pt-3 dark:border-border'>
              <Button
                size='sm'
                onClick={() => save.mutate()}
                disabled={
                  save.isPending ||
                  !draft.label.trim() ||
                  !draft.key.trim() ||
                  !draft.issuer.trim() ||
                  !draft.client_id.trim()
                }
              >
                {save.isPending ? 'Saving…' : editingId === 'new' ? 'Add provider' : 'Save changes'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  setEditingId(null)
                  setDraft(EMPTY_SSO_DRAFT)
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── File storage section (#527) ─────────────────────────────────────────────

const STORAGE_MASK = '••••••'

function FileStorageSection() {
  const queryClient = useQueryClient()
  const { data: stored, isLoading } = useQuery<{
    driver: string
    config: Record<string, unknown> | null
  }>({
    queryKey: ['storage-config'],
    queryFn: () =>
      api
        .get<{ data: { driver: string; config: Record<string, unknown> | null } }>(
          '/files/storage-config'
        )
        .then((r) => r.data.data)
  })

  const [driver, setDriver] = useState<'local' | 's3' | 'azure-blob'>('local')
  const [s3, setS3] = useState({
    bucket: '',
    region: '',
    access_key_id: '',
    secret_access_key: '',
    endpoint: ''
  })
  const [az, setAz] = useState({ account: '', container: '', account_key: '' })
  const [hydrated, setHydrated] = useState(false)
  const [testing, setTesting] = useState(false)
  if (stored && !hydrated) {
    const d = stored.driver === 's3' || stored.driver === 'azure-blob' ? stored.driver : 'local'
    setDriver(d)
    const c = stored.config ?? {}
    if (d === 's3') {
      setS3({
        bucket: String(c.bucket ?? ''),
        region: String(c.region ?? ''),
        access_key_id: String(c.access_key_id ?? ''),
        secret_access_key: String(c.secret_access_key ?? ''),
        endpoint: String(c.endpoint ?? '')
      })
    } else if (d === 'azure-blob') {
      setAz({
        account: String(c.account ?? ''),
        container: String(c.container ?? ''),
        account_key: String(c.account_key ?? '')
      })
    }
    setHydrated(true)
  }

  function currentConfig(): Record<string, unknown> | null {
    if (driver === 's3') {
      return {
        bucket: s3.bucket.trim(),
        region: s3.region.trim() || undefined,
        access_key_id: s3.access_key_id.trim(),
        secret_access_key: s3.secret_access_key,
        endpoint: s3.endpoint.trim() || undefined
      }
    }
    if (driver === 'azure-blob') {
      return {
        account: az.account.trim(),
        container: az.container.trim(),
        account_key: az.account_key
      }
    }
    return null
  }

  const save = useMutation({
    mutationFn: () => api.put('/files/storage-config', { driver, config: currentConfig() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storage-config'] })
      toast.success('Storage settings saved')
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Failed to save storage settings')
  })

  async function testConnection() {
    setTesting(true)
    try {
      const r = await api.post<{ data: { ok: boolean; error?: string } }>('/files/storage-test', {
        driver,
        config: currentConfig()
      })
      if (r.data.data.ok)
        toast.success('Storage connection OK — probe object written and read back')
      else
        toast.error(`Storage test failed: ${r.data.data.error ?? 'unknown error'}`, {
          duration: 9000
        })
    } catch (e) {
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Test failed'
      )
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className='p-8'>
      <div className='max-w-lg'>
        <h2 className='mb-2 text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          File storage
        </h2>
        <p className='mb-6 text-[12px] text-muted-foreground'>
          Where uploaded files are stored. Switching drivers affects{' '}
          <strong>new uploads only</strong> — existing files are not migrated; reads fall back to
          the previous storage so history keeps serving either way.
        </p>

        {isLoading ? (
          <Skeleton className='h-24 w-full rounded-lg' />
        ) : (
          <div className='space-y-5'>
            <Field label='Driver'>
              <Select value={driver} onValueChange={(v) => setDriver(v as typeof driver)}>
                <SelectTrigger className='h-8 text-[13px]'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='local'>Local disk (default)</SelectItem>
                  <SelectItem value='s3'>S3-compatible (AWS S3, Cloudflare R2, MinIO)</SelectItem>
                  <SelectItem value='azure-blob'>Azure Blob Storage</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {driver === 's3' && (
              <>
                <Field label='Bucket'>
                  <Input
                    value={s3.bucket}
                    onChange={(e) => setS3((p) => ({ ...p, bucket: e.target.value }))}
                    placeholder='my-bucket'
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
                <Field label='Region' hint='Default us-east-1. Use "auto" for Cloudflare R2.'>
                  <Input
                    value={s3.region}
                    onChange={(e) => setS3((p) => ({ ...p, region: e.target.value }))}
                    placeholder='us-east-1'
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
                <Field label='Access key ID'>
                  <Input
                    value={s3.access_key_id}
                    onChange={(e) => setS3((p) => ({ ...p, access_key_id: e.target.value }))}
                    placeholder='AKIA…'
                    className='h-8 font-mono text-[13px]'
                    autoComplete='off'
                  />
                </Field>
                <Field
                  label='Secret access key'
                  hint={
                    s3.secret_access_key === STORAGE_MASK
                      ? 'Configured. Enter a new value to replace.'
                      : undefined
                  }
                >
                  <Input
                    type='password'
                    value={s3.secret_access_key}
                    onChange={(e) => setS3((p) => ({ ...p, secret_access_key: e.target.value }))}
                    placeholder='••••••••'
                    className='h-8 font-mono text-[13px]'
                    autoComplete='new-password'
                  />
                </Field>
                <Field
                  label='Endpoint'
                  hint='Optional — custom endpoint for R2 / MinIO. Leave blank for AWS S3.'
                >
                  <Input
                    value={s3.endpoint}
                    onChange={(e) => setS3((p) => ({ ...p, endpoint: e.target.value }))}
                    placeholder='https://<account>.r2.cloudflarestorage.com'
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
              </>
            )}

            {driver === 'azure-blob' && (
              <>
                <Field label='Storage account'>
                  <Input
                    value={az.account}
                    onChange={(e) => setAz((p) => ({ ...p, account: e.target.value }))}
                    placeholder='mystorageaccount'
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
                <Field label='Container'>
                  <Input
                    value={az.container}
                    onChange={(e) => setAz((p) => ({ ...p, container: e.target.value }))}
                    placeholder='files'
                    className='h-8 font-mono text-[13px]'
                  />
                </Field>
                <Field
                  label='Account key'
                  hint={
                    az.account_key === STORAGE_MASK
                      ? 'Configured. Enter a new value to replace.'
                      : "Shared Key from the storage account's Access keys blade."
                  }
                >
                  <Input
                    type='password'
                    value={az.account_key}
                    onChange={(e) => setAz((p) => ({ ...p, account_key: e.target.value }))}
                    placeholder='••••••••'
                    className='h-8 font-mono text-[13px]'
                    autoComplete='new-password'
                  />
                </Field>
              </>
            )}

            {driver === 'local' && (
              <p className='rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[12px] text-slate-500 dark:border-border dark:bg-muted/30'>
                Files are written to this server's disk (or whatever the STORAGE_PROVIDER env var
                configures) — the historic behavior.
              </p>
            )}

            <div className='flex gap-2 border-t border-slate-100 pt-5 dark:border-border'>
              <Button size='sm' onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              {driver !== 'local' && (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={testConnection}
                  disabled={testing}
                  className='gap-1.5'
                >
                  <Check className='h-3.5 w-3.5' />
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Field row helper ─────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-1.5'>
      <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>{label}</Label>
      {children}
      {hint && <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>{hint}</p>}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const queryClient = useQueryClient()
  const { data: settings, isLoading } = useSettings()
  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data)
  })

  const [activeSection, setActiveSection] = usePersistedTab<Section>('nvr_tab_settings', 'project')

  function toAdGroupArray(v: unknown): AdGroupRow[] {
    if (Array.isArray(v)) return v as AdGroupRow[]
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v)
        return Array.isArray(p) ? p : []
      } catch {
        return []
      }
    }
    return []
  }

  const [adGroupRows, setAdGroupRows] = useState<AdGroupRow[]>(() =>
    toAdGroupArray(settings?.ad_group_role_map)
  )
  const [adGroupsInitialized, setAdGroupsInitialized] = useState(false)
  if (settings && !adGroupsInitialized) {
    setAdGroupRows(toAdGroupArray(settings.ad_group_role_map))
    setAdGroupsInitialized(true)
  }

  // Local draft state for each section
  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [projectUrl, setProjectUrl] = useState('')
  const [projectColor, setProjectColor] = useState('#00ceff')
  const [brandLogo, setBrandLogo] = useState<string | null>(null)
  const [brandLoginTitle, setBrandLoginTitle] = useState('')
  const [brandLoginMessage, setBrandLoginMessage] = useState('')
  // Login help/support links (#347) — [{label, url}] JSON on settings.
  const [loginLinks, setLoginLinks] = useState<Array<{ label: string; url: string }>>([])
  // Theme studio (#662)
  const [themeRadius, setThemeRadius] = useState<string>('')
  const [themeFont, setThemeFont] = useState<string>('')
  const [defaultLanguage, setDefaultLanguage] = useState('en-US')
  const [availableLocales, setAvailableLocales] = useState<string[]>(['en'])
  const [newLocale, setNewLocale] = useState('')
  const [teamsWebhook, setTeamsWebhook] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(true)
  const [sessionTtl, setSessionTtl] = useState(20)
  const [sweepInterval, setSweepInterval] = useState(8000)
  const [pingInterval, setPingInterval] = useState(10000)
  const [aiModel, setAiModel] = useState('claude-haiku-4-5-20251001')
  const [aiMaxGenerate, setAiMaxGenerate] = useState(500)
  const [aiMaxSummarize, setAiMaxSummarize] = useState(200)
  const [slaStart, setSlaStart] = useState(9)
  const [slaTimezone, setSlaTimezone] = useState('')
  const [zoneSource, setZoneSource] = useState('')
  const [zoneMap, setZoneMap] = useState<Record<string, string>>({})
  const [slaEnd, setSlaEnd] = useState(17)
  const [slaBusinessDays, setSlaBusinessDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [slaHolidays, setSlaHolidays] = useState<string[]>([])
  const [newHoliday, setNewHoliday] = useState('')
  const { locale: adminLocale, setLocale: setAdminLocale } = useLocale()
  const [fileMaxMb, setFileMaxMb] = useState(50)
  const [collectionPageSize, setCollectionPageSize] = useState(25)
  const [activityRetentionDays, setActivityRetentionDays] = useState<number | ''>('')
  const [revisionRetentionCount, setRevisionRetentionCount] = useState<number | ''>('')
  const [fieldWatchEnabled, setFieldWatchEnabled] = useState(false)
  const [lockIdleMinutes, setLockIdleMinutes] = useState<number | ''>('')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState<number | ''>(587)
  const [smtpUser, setSmtpUser] = useState('')
  const [smtpPass, setSmtpPass] = useState('')
  const [smtpFrom, setSmtpFrom] = useState('')
  const [smtpSecure, setSmtpSecure] = useState(false)
  const [mailTestMode, setMailTestMode] = useState(false)
  const [mailTestRecipient, setMailTestRecipient] = useState('')
  const [mailTestAllowlist, setMailTestAllowlist] = useState('')
  const [environmentLabel, setEnvironmentLabel] = useState('')
  const [smsTestMode, setSmsTestMode] = useState(false)
  const [smsTestRecipient, setSmsTestRecipient] = useState('')
  const [smsTestAllowlist, setSmsTestAllowlist] = useState('')
  const [testTo, setTestTo] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [smsProvider, setSmsProvider] = useState('')
  const [smsAccountSid, setSmsAccountSid] = useState('')
  const [smsAuthToken, setSmsAuthToken] = useState('')
  const [smsFrom, setSmsFrom] = useState('')
  const [smsRegion, setSmsRegion] = useState('us-east-1')
  const [smsTestTo, setSmsTestTo] = useState('')
  const [smsTestSending, setSmsTestSending] = useState(false)

  // Hydrate local state from settings once
  const [hydrated, setHydrated] = useState(false)
  if (settings && !hydrated) {
    setProjectName(settings.project_name ?? '')
    setProjectDescription(settings.project_description ?? '')
    setProjectUrl(settings.project_url ?? '')
    setProjectColor(settings.project_color ?? '#00ceff')
    setBrandLogo((settings as { brand_logo?: string | null }).brand_logo ?? null)
    setBrandLoginTitle((settings as { brand_login_title?: string | null }).brand_login_title ?? '')
    setBrandLoginMessage(
      (settings as { brand_login_message?: string | null }).brand_login_message ?? ''
    )
    try {
      const raw = JSON.parse((settings as { login_links?: string | null }).login_links ?? '[]')
      setLoginLinks(Array.isArray(raw) ? raw : [])
    } catch {
      setLoginLinks([])
    }
    setThemeRadius((settings as { theme_radius?: string | null }).theme_radius ?? '')
    setThemeFont((settings as { theme_font?: string | null }).theme_font ?? '')
    setDefaultLanguage(settings.default_language ?? 'en-US')
    setAvailableLocales(toLocaleArray((settings as Record<string, unknown>).available_locales))
    setTeamsWebhook(settings.teams_webhook_url ?? '')
    setAnthropicKey(settings.anthropic_api_key ?? '')
    setTwoFactorEnabled(settings.two_factor_enabled !== false)
    setSessionTtl(settings.presence_session_ttl ?? 20)
    setSweepInterval(settings.presence_sweep_interval ?? 8000)
    setPingInterval(settings.presence_ping_interval ?? 10000)
    setAiModel(settings.ai_model ?? 'claude-haiku-4-5-20251001')
    setAiMaxGenerate(settings.ai_max_tokens_generate ?? 500)
    setAiMaxSummarize(settings.ai_max_tokens_summarize ?? 200)
    setSlaStart(settings.sla_business_day_start ?? 9)
    setSlaTimezone(String((settings as Record<string, unknown>).sla_timezone ?? ''))
    try {
      const zm = (settings as Record<string, unknown>).sla_zone_map
      const parsed = zm ? JSON.parse(String(zm)) : null
      if (parsed && typeof parsed === 'object') {
        setZoneSource(String(parsed.source_collection ?? ''))
        setZoneMap(
          parsed.zones && typeof parsed.zones === 'object'
            ? (parsed.zones as Record<string, string>)
            : {}
        )
      }
    } catch {
      /* malformed — start empty */
    }
    setSlaEnd(settings.sla_business_day_end ?? 17)
    try {
      const h = settings.sla_holidays ? JSON.parse(String(settings.sla_holidays)) : []
      setSlaHolidays(Array.isArray(h) ? h : [])
    } catch {
      setSlaHolidays([])
    }
    setSlaBusinessDays(
      (settings.sla_business_days ?? '1,2,3,4,5').split(',').map(Number).filter(Boolean)
    )
    setFileMaxMb(settings.file_max_size_mb ?? 50)
    setCollectionPageSize(settings.collection_page_size ?? 25)
    setActivityRetentionDays(settings.activity_retention_days ?? '')
    setFieldWatchEnabled(!!(settings as { field_watch_enabled?: boolean }).field_watch_enabled)
    setLockIdleMinutes(
      (settings as { lock_idle_release_minutes?: number | null }).lock_idle_release_minutes ?? ''
    )
    setRevisionRetentionCount(settings.revision_retention_count ?? '')
    const s = settings as Record<string, unknown>
    setSmsProvider((s.sms_provider as string) ?? '')
    setSmsAccountSid((s.sms_account_sid as string) ?? '')
    setSmsAuthToken((s.sms_auth_token as string) ?? '')
    setSmsFrom((s.sms_from as string) ?? '')
    setSmsRegion((s.sms_region as string) ?? 'us-east-1')
    setSmtpHost((s.smtp_host as string) ?? '')
    setSmtpPort((s.smtp_port as number) ?? 587)
    setSmtpUser((s.smtp_user as string) ?? '')
    setSmtpPass((s.smtp_pass as string) ?? '')
    setSmtpFrom((s.smtp_from as string) ?? '')
    setSmtpSecure(s.smtp_secure === 1 || s.smtp_secure === true)
    setMailTestMode(s.mail_test_mode === 1 || s.mail_test_mode === true)
    setMailTestRecipient((s.mail_test_recipient as string) ?? '')
    setMailTestAllowlist((s.mail_test_allowlist as string) ?? '')
    setEnvironmentLabel((s.environment_label as string) ?? '')
    setSmsTestMode(s.sms_test_mode === 1 || s.sms_test_mode === true)
    setSmsTestRecipient((s.sms_test_recipient as string) ?? '')
    setSmsTestAllowlist((s.sms_test_allowlist as string) ?? '')
    setHydrated(true)
  }

  const mutation = useMutation({
    mutationFn: (body: Partial<CMSSettings>) =>
      api.patch('/settings', body).then((r) => r.data.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Settings saved')
    },
    onError: () => toast.error('Failed to save settings')
  })

  function saveProject() {
    mutation.mutate({
      project_name: projectName,
      project_description: projectDescription || null,
      project_url: projectUrl || null,
      project_color: projectColor,
      brand_logo: brandLogo,
      brand_login_title: brandLoginTitle.trim() || null,
      brand_login_message: brandLoginMessage.trim() || null,
      login_links: JSON.stringify(loginLinks.filter((l) => l.label.trim() && l.url.trim()))
    })
  }

  function saveAppearance() {
    mutation.mutate(
      {
        theme_radius: themeRadius || null,
        theme_font: themeFont || null
      } as unknown as Partial<CMSSettings>,
      {
        onSuccess: () =>
          // Instant feedback — AppLayout re-applies on the settings refetch too.
          applyThemeSettings({ theme_radius: themeRadius || null, theme_font: themeFont || null })
      }
    )
  }

  function saveLocalization() {
    mutation.mutate({
      default_language: defaultLanguage,
      // available_locales backs the field-translations feature; sent even though it
      // is not (yet) part of the typed CMSSettings shape — the settings route is a
      // generic singleton PATCH.
      available_locales: availableLocales
    } as Partial<CMSSettings> & { available_locales: string[] })
  }

  function addLocale() {
    const code = newLocale.trim().toLowerCase()
    if (!code) return
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(code)) {
      toast.error('Enter a valid locale code, e.g. "de" or "fr-CA"')
      return
    }
    if (availableLocales.includes(code)) {
      toast.message(`Locale "${code}" is already in the list`)
      return
    }
    setAvailableLocales((prev) => [...prev, code])
    setNewLocale('')
  }

  function removeLocale(code: string) {
    setAvailableLocales((prev) => (prev.length > 1 ? prev.filter((l) => l !== code) : prev))
  }

  function saveSms() {
    mutation.mutate({
      sms_provider: smsProvider || null,
      sms_account_sid: smsAccountSid || null,
      sms_auth_token: smsAuthToken || null,
      sms_from: smsFrom || null,
      sms_region: smsRegion || null,
      sms_test_mode: smsTestMode,
      sms_test_recipient: smsTestRecipient || null,
      sms_test_allowlist: smsTestAllowlist || null
    } as unknown as Partial<CMSSettings>)
  }

  async function sendTestSms() {
    if (!smsTestTo) {
      toast.error('Enter a phone number')
      return
    }
    setSmsTestSending(true)
    try {
      await api.post('/settings/sms/test', { to: smsTestTo })
      toast.success(`Test SMS sent to ${smsTestTo}`)
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to send'
      toast.error(msg)
    } finally {
      setSmsTestSending(false)
    }
  }

  function saveEmail() {
    mutation.mutate({
      smtp_host: smtpHost || null,
      smtp_port: smtpPort || null,
      smtp_user: smtpUser || null,
      smtp_pass: smtpPass || null,
      smtp_from: smtpFrom || null,
      smtp_secure: smtpSecure,
      mail_test_mode: mailTestMode,
      mail_test_recipient: mailTestRecipient || null,
      mail_test_allowlist: mailTestAllowlist || null,
      environment_label: environmentLabel.trim() || null
    } as unknown as Partial<CMSSettings>)
  }

  async function sendTestEmail() {
    if (!testTo) {
      toast.error('Enter a recipient address')
      return
    }
    setTestSending(true)
    try {
      await api.post('/settings/mail/test', { to: testTo })
      toast.success(`Test email sent to ${testTo}`)
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to send'
      toast.error(msg)
    } finally {
      setTestSending(false)
    }
  }

  function saveMicrosoft() {
    mutation.mutate({
      teams_webhook_url: teamsWebhook || null,
      ad_group_role_map: adGroupRows.filter((r) => r.ad_group_id && r.role_id)
    })
  }

  function saveAI() {
    mutation.mutate({
      anthropic_api_key: anthropicKey || null,
      ai_model: aiModel,
      ai_max_tokens_generate: aiMaxGenerate,
      ai_max_tokens_summarize: aiMaxSummarize
    })
  }

  function savePresence() {
    mutation.mutate({
      two_factor_enabled: twoFactorEnabled,
      presence_session_ttl: sessionTtl,
      presence_sweep_interval: sweepInterval,
      presence_ping_interval: pingInterval
    })
  }

  function saveSla() {
    const zones = Object.fromEntries(
      Object.entries(zoneMap).filter(([, tz]) => String(tz ?? '').trim() !== '')
    )
    mutation.mutate({
      sla_business_day_start: slaStart,
      sla_timezone: slaTimezone.trim() || null,
      sla_business_day_end: slaEnd,
      sla_business_days: slaBusinessDays.join(','),
      sla_holidays: JSON.stringify(slaHolidays),
      sla_zone_map:
        zoneSource.trim() && Object.keys(zones).length > 0
          ? JSON.stringify({ source_collection: zoneSource.trim(), zones })
          : null
    })
  }

  function saveContent() {
    mutation.mutate({
      file_max_size_mb: fileMaxMb,
      collection_page_size: collectionPageSize,
      activity_retention_days: activityRetentionDays === '' ? null : activityRetentionDays,
      revision_retention_count: revisionRetentionCount === '' ? null : revisionRetentionCount,
      field_watch_enabled: fieldWatchEnabled,
      lock_idle_release_minutes: lockIdleMinutes === '' ? null : lockIdleMinutes
    })
  }

  function toggleSlaDay(day: number) {
    setSlaBusinessDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    )
  }

  const addAdGroupRow = () => setAdGroupRows((p) => [...p, { ad_group_id: '', role_id: '' }])
  const removeAdGroupRow = (i: number) => setAdGroupRows((p) => p.filter((_, idx) => idx !== i))
  const updateAdGroupRow = (i: number, field: keyof AdGroupRow, value: string) =>
    setAdGroupRows((p) => p.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)))

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          Settings
        </h1>
      </div>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left nav */}
        <aside className='flex w-[200px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <nav className='flex-1 overflow-y-auto py-3'>
            {NAV.map((item) => (
              <button
                key={item.id}
                type='button'
                onClick={() => setActiveSection(item.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] transition-colors',
                  activeSection === item.id
                    ? 'bg-[#00ceff]/10 font-medium text-slate-900 dark:bg-[#00ceff]/[0.07] dark:text-foreground'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-muted/50'
                )}
              >
                <span
                  className={cn(activeSection === item.id ? 'text-[#00ceff]' : 'text-slate-400')}
                >
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Right content */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {isLoading || !settings ? (
            <div className='p-8 space-y-5'>
              {[1, 2, 3].map((k) => (
                <Skeleton key={k} className='h-12 w-full rounded-lg' />
              ))}
            </div>
          ) : (
            <>
              {activeSection === 'project' && (
                <SectionWrap title='Project' onSave={saveProject} saving={mutation.isPending}>
                  <Field label='Project Name' hint='Shown in the sidebar and browser tab title.'>
                    <Input
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field label='Description' hint='Shown below the project name in the sidebar.'>
                    <Textarea
                      value={projectDescription}
                      onChange={(e) => setProjectDescription(e.target.value)}
                      placeholder='e.g. My Project'
                      rows={2}
                      className='resize-none text-[13px]'
                    />
                  </Field>
                  <Field label='Project URL'>
                    <Input
                      type='url'
                      placeholder='https://…'
                      value={projectUrl}
                      onChange={(e) => setProjectUrl(e.target.value)}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field label='Accent Color'>
                    <div className='flex flex-col gap-3'>
                      <div className='flex flex-wrap gap-2'>
                        {[
                          '#00ceff',
                          '#1e96d2',
                          '#3b82f6',
                          '#6366f1',
                          '#8b5cf6',
                          '#10b981',
                          '#14b8a6',
                          '#f97316',
                          '#f43f5e',
                          '#64748b'
                        ].map((c) => (
                          <button
                            key={c}
                            type='button'
                            onClick={() => setProjectColor(c)}
                            className='relative h-7 w-7 rounded-full border-2 transition-transform hover:scale-110'
                            style={{
                              backgroundColor: c,
                              borderColor: projectColor === c ? 'white' : 'transparent',
                              boxShadow: projectColor === c ? `0 0 0 2px ${c}` : undefined
                            }}
                            aria-label={c}
                          >
                            {projectColor === c && (
                              <Check className='absolute inset-0 m-auto h-3.5 w-3.5 text-white drop-shadow' />
                            )}
                          </button>
                        ))}
                      </div>
                      <div className='flex items-center gap-2'>
                        <input
                          type='color'
                          value={projectColor}
                          onChange={(e) => setProjectColor(e.target.value)}
                          className='h-7 w-7 cursor-pointer rounded-md border border-slate-200 p-0.5 dark:border-border'
                          title='Custom color'
                        />
                        <input
                          type='text'
                          value={projectColor}
                          onChange={(e) => {
                            const v = e.target.value
                            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setProjectColor(v)
                          }}
                          className='h-7 w-28 rounded-md border border-slate-200 bg-transparent px-2 font-mono text-[12px] text-slate-600 dark:border-border dark:text-muted-foreground'
                          spellCheck={false}
                        />
                      </div>
                    </div>
                  </Field>
                  <Field
                    label='Logo'
                    hint='Shown on the login page and the sidebar. PNG/SVG with transparency works best.'
                  >
                    <div className='flex items-center gap-3'>
                      {brandLogo && (
                        <img
                          src={`/api/files/${brandLogo}`}
                          alt='Logo'
                          className='max-h-12 max-w-[180px] rounded border border-slate-200 bg-white object-contain p-1 dark:border-border'
                        />
                      )}
                      <label className='inline-flex h-8 cursor-pointer items-center rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'>
                        {brandLogo ? 'Replace…' : 'Upload logo…'}
                        <input
                          type='file'
                          accept='image/*'
                          className='hidden'
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const fd = new FormData()
                            fd.append('file', file)
                            try {
                              const r = await api.post('/files/upload', fd, {
                                headers: { 'Content-Type': 'multipart/form-data' }
                              })
                              const id = r.data?.data?.id ?? r.data?.id
                              if (id) {
                                setBrandLogo(String(id))
                                toast.success('Logo uploaded — Save to apply')
                              }
                            } catch {
                              toast.error('Upload failed')
                            }
                          }}
                        />
                      </label>
                      {brandLogo && (
                        <button
                          type='button'
                          onClick={() => setBrandLogo(null)}
                          className='text-[12px] text-slate-400 hover:text-red-500'
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </Field>
                  <Field
                    label='Login page headline'
                    hint='Replaces the big product name on the login screen. Blank = project name.'
                  >
                    <Input
                      value={brandLoginTitle}
                      onChange={(e) => setBrandLoginTitle(e.target.value)}
                      placeholder='e.g. EFP Portal'
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field label='Login page message' hint='The line under the headline.'>
                    <Input
                      value={brandLoginMessage}
                      onChange={(e) => setBrandLoginMessage(e.target.value)}
                      placeholder='e.g. Engineering Facilities Planning'
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field
                    label='Login page links'
                    hint='Help/support links shown under the login headline (https only).'
                  >
                    <div className='space-y-1.5'>
                      {loginLinks.map((l, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
                        <div key={i} className='flex items-center gap-1.5'>
                          <Input
                            value={l.label}
                            onChange={(e) =>
                              setLoginLinks((prev) =>
                                prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                              )
                            }
                            placeholder='Label (e.g. Help desk)'
                            className='h-8 w-[180px] text-[12.5px]'
                          />
                          <Input
                            value={l.url}
                            onChange={(e) =>
                              setLoginLinks((prev) =>
                                prev.map((x, j) => (j === i ? { ...x, url: e.target.value } : x))
                              )
                            }
                            placeholder='https://…'
                            className='h-8 flex-1 font-mono text-[12px]'
                          />
                          <button
                            type='button'
                            onClick={() => setLoginLinks((prev) => prev.filter((_, j) => j !== i))}
                            className='rounded-md px-2 py-1 text-[12px] text-slate-400 hover:bg-muted hover:text-red-500'
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      {loginLinks.length < 6 && (
                        <button
                          type='button'
                          onClick={() => setLoginLinks((prev) => [...prev, { label: '', url: '' }])}
                          className='rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-[12px] text-slate-500 hover:bg-muted dark:border-border'
                        >
                          ＋ Add link
                        </button>
                      )}
                    </div>
                  </Field>
                </SectionWrap>
              )}

              {activeSection === 'appearance' && (
                <SectionWrap title='Appearance' onSave={saveAppearance} saving={mutation.isPending}>
                  <Field
                    label='Corner radius'
                    hint='How rounded cards, buttons and inputs render across the whole admin.'
                  >
                    <div className='flex flex-wrap gap-2'>
                      {[
                        { value: '', label: 'Default', px: '6px' },
                        { value: 'sharp', label: 'Sharp', px: THEME_RADIUS_PRESETS.sharp },
                        { value: 'soft', label: 'Soft', px: THEME_RADIUS_PRESETS.soft },
                        { value: 'round', label: 'Round', px: THEME_RADIUS_PRESETS.round }
                      ].map((opt) => (
                        <button
                          key={opt.value || 'default'}
                          type='button'
                          onClick={() => setThemeRadius(opt.value)}
                          className={cn(
                            'flex items-center gap-2 border px-3 py-2 text-[12.5px] transition-colors',
                            themeRadius === opt.value
                              ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-slate-900 dark:text-foreground'
                              : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted/50'
                          )}
                          style={{ borderRadius: opt.px }}
                        >
                          <span
                            className='inline-block h-4 w-4 border border-slate-300 bg-slate-100 dark:border-border dark:bg-muted'
                            style={{ borderRadius: opt.px }}
                          />
                          {opt.label}
                          <span className='text-[10.5px] text-slate-400'>{opt.px}</span>
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field
                    label='Font pairing'
                    hint='Only zero-download stacks are offered — code surfaces keep JetBrains Mono.'
                  >
                    <div className='flex flex-col gap-2'>
                      {[
                        {
                          value: '',
                          label: 'DM Sans',
                          note: 'Default — bundled with the admin',
                          stack: `'DM Sans', system-ui, sans-serif`
                        },
                        {
                          value: 'system-ui',
                          label: 'System UI',
                          note: 'Your operating system’s native font',
                          stack: `system-ui, -apple-system, 'Segoe UI', sans-serif`
                        },
                        {
                          value: 'serif',
                          label: 'Serif',
                          note: 'Georgia — editorial feel, no download',
                          stack: `Georgia, 'Times New Roman', serif`
                        }
                      ].map((opt) => (
                        <button
                          key={opt.value || 'dm-sans'}
                          type='button'
                          onClick={() => setThemeFont(opt.value)}
                          className={cn(
                            'flex items-baseline justify-between rounded-lg border px-3 py-2.5 text-left transition-colors',
                            themeFont === opt.value
                              ? 'border-nvr-cyan bg-nvr-cyan/10'
                              : 'border-slate-200 hover:bg-slate-50 dark:border-border dark:hover:bg-muted/50'
                          )}
                        >
                          <span>
                            <span
                              className='block text-[13.5px] font-medium text-slate-800 dark:text-foreground'
                              style={{ fontFamily: opt.stack }}
                            >
                              {opt.label}
                            </span>
                            <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                              {opt.note}
                            </span>
                          </span>
                          <span
                            className='text-[15px] text-slate-500 dark:text-muted-foreground'
                            style={{ fontFamily: opt.stack }}
                          >
                            Aa
                          </span>
                        </button>
                      ))}
                    </div>
                  </Field>
                  <p className='text-[11.5px] text-slate-400 dark:text-muted-foreground'>
                    The accent color is configured under{' '}
                    <button
                      type='button'
                      onClick={() => setActiveSection('project')}
                      className='font-medium text-nvr-navy underline decoration-dotted dark:text-nvr-cyan'
                    >
                      Project
                    </button>
                    .
                  </p>
                </SectionWrap>
              )}

              {activeSection === 'localization' && (
                <SectionWrap
                  title='Localization'
                  onSave={saveLocalization}
                  saving={mutation.isPending}
                >
                  <Field
                    label='Admin interface language'
                    hint='Applies to this browser only — stored locally, takes effect immediately. Navigation and shell are translated; page-level translation is incremental.'
                  >
                    <div className='flex flex-wrap gap-1.5'>
                      {ADMIN_LOCALES.map((l) => (
                        <button
                          key={l.value}
                          type='button'
                          onClick={() => setAdminLocale(l.value)}
                          className={cn(
                            'rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors',
                            adminLocale === l.value
                              ? 'bg-[#00ceff1a] text-nvr-navy dark:text-[#00ceff]'
                              : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-muted dark:text-muted-foreground'
                          )}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label='Default Language'>
                    <Select value={defaultLanguage} onValueChange={setDefaultLanguage}>
                      <SelectTrigger className='h-8 text-[13px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANGUAGES.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  <div className='space-y-1.5'>
                    <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      Available Locales
                    </Label>
                    <div className='flex flex-wrap items-center gap-1.5'>
                      {availableLocales.map((code, i) => (
                        <span
                          key={code}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium',
                            i === 0
                              ? 'bg-[#00ceff]/15 text-[#0a2540] dark:bg-[#00ceff]/20 dark:text-[#00ceff]'
                              : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
                          )}
                        >
                          {code}
                          {i === 0 && (
                            <span className='text-[9px] font-sans uppercase tracking-wide opacity-60'>
                              default
                            </span>
                          )}
                          {availableLocales.length > 1 && (
                            <button
                              type='button'
                              onClick={() => removeLocale(code)}
                              className='text-slate-400 transition-colors hover:text-red-500'
                              aria-label={`Remove locale ${code}`}
                            >
                              <X className='h-3 w-3' />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                    <div className='flex items-center gap-2'>
                      <Input
                        value={newLocale}
                        onChange={(e) => setNewLocale(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addLocale()
                          }
                        }}
                        placeholder='e.g. de, fr-CA'
                        className='h-8 w-36 font-mono text-[12px]'
                      />
                      <Button type='button' variant='outline' size='sm' onClick={addLocale}>
                        <Plus className='mr-1 h-3.5 w-3.5' /> Add
                      </Button>
                    </div>
                    <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                      Used by per-field translations. The first locale is the default — its values
                      live on the record itself; every additional locale gets a translation input on
                      translatable fields.
                    </p>
                  </div>
                </SectionWrap>
              )}

              {activeSection === 'microsoft' && (
                <SectionWrap
                  title='Microsoft Integration'
                  onSave={saveMicrosoft}
                  saving={mutation.isPending}
                >
                  <Field
                    label='Teams Incoming Webhook URL'
                    hint='In-app notifications will also be posted to this Teams channel.'
                  >
                    <Input
                      type='url'
                      placeholder='https://outlook.office.com/webhook/…'
                      value={teamsWebhook}
                      onChange={(e) => setTeamsWebhook(e.target.value)}
                      className='h-8 text-[13px]'
                    />
                  </Field>

                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                        Azure AD Group → Role Mapping
                      </Label>
                      <Button type='button' variant='outline' size='sm' onClick={addAdGroupRow}>
                        <Plus className='mr-1 h-3.5 w-3.5' /> Add
                      </Button>
                    </div>
                    <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                      Maps Azure AD group IDs to Nivaro roles. First match wins on login.
                    </p>
                    {adGroupRows.length > 0 && (
                      <div className='space-y-2'>
                        {adGroupRows.map((row, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: stable index list
                          <div key={i} className='flex items-center gap-2'>
                            <Input
                              placeholder='Azure AD group ID (GUID)'
                              value={row.ad_group_id}
                              onChange={(e) => updateAdGroupRow(i, 'ad_group_id', e.target.value)}
                              className='flex-1 h-8 font-mono text-[12px]'
                            />
                            <Select
                              value={row.role_id}
                              onValueChange={(v) => updateAdGroupRow(i, 'role_id', v)}
                            >
                              <SelectTrigger className='h-8 w-40 text-[12px]'>
                                <SelectValue placeholder='Select role…' />
                              </SelectTrigger>
                              <SelectContent>
                                {roles.map((r) => (
                                  <SelectItem key={r.id} value={r.id}>
                                    {r.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon'
                              className='h-8 w-8 shrink-0 text-slate-400 hover:text-red-500'
                              onClick={() => removeAdGroupRow(i)}
                            >
                              <Trash2 className='h-3.5 w-3.5' />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </SectionWrap>
              )}

              {activeSection === 'ai' && (
                <SectionWrap title='AI Features' onSave={saveAI} saving={mutation.isPending}>
                  <Field
                    label='Anthropic API Key'
                    hint={
                      settings.anthropic_api_key
                        ? 'Key configured. Leave blank to remove, or enter a new value to replace.'
                        : 'Required for AI field generation and record summarization. Leave blank to disable.'
                    }
                  >
                    <Input
                      type='password'
                      placeholder='sk-ant-…'
                      value={anthropicKey}
                      onChange={(e) => setAnthropicKey(e.target.value)}
                      className='h-8 font-mono text-[13px]'
                      autoComplete='off'
                    />
                  </Field>
                  <Field
                    label='Model'
                    hint='Used for all AI generation and summarization requests.'
                  >
                    <Select value={aiModel} onValueChange={setAiModel}>
                      <SelectTrigger className='h-8 text-[13px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AI_MODELS.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    label='Max tokens — field generation'
                    hint='Token budget for the /ai/generate endpoint.'
                  >
                    <Input
                      type='number'
                      min={100}
                      max={4096}
                      step={100}
                      value={aiMaxGenerate}
                      onChange={(e) => setAiMaxGenerate(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field
                    label='Max tokens — summarization'
                    hint='Token budget for the /ai/summarize endpoint.'
                  >
                    <Input
                      type='number'
                      min={50}
                      max={2048}
                      step={50}
                      value={aiMaxSummarize}
                      onChange={(e) => setAiMaxSummarize(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                </SectionWrap>
              )}

              {activeSection === 'presence' && (
                <SectionWrap
                  title='Presence & Security'
                  onSave={savePresence}
                  saving={mutation.isPending}
                >
                  <Field
                    label='Two-factor authentication'
                    hint='Off hides two-factor setup from every profile. Turn it off when this deployment does not ask for a code — offering a setup flow nothing enforces leaves people holding a dead authenticator entry.'
                  >
                    <Switch checked={twoFactorEnabled} onCheckedChange={setTwoFactorEnabled} />
                  </Field>
                  <Field
                    label='Session TTL (seconds)'
                    hint='How long a session stays active in Redis after the last ping. Must be longer than the ping interval.'
                  >
                    <Input
                      type='number'
                      min={5}
                      max={300}
                      value={sessionTtl}
                      onChange={(e) => setSessionTtl(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field
                    label='Server sweep interval (ms)'
                    hint='How often the server pushes the current session list to the admin presence page.'
                  >
                    <Input
                      type='number'
                      min={1000}
                      max={60000}
                      step={1000}
                      value={sweepInterval}
                      onChange={(e) => setSweepInterval(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field
                    label='Client ping interval (ms)'
                    hint='How often the embedded tracker script pings the server. Takes effect when the script is next loaded.'
                  >
                    <Input
                      type='number'
                      min={2000}
                      max={60000}
                      step={1000}
                      value={pingInterval}
                      onChange={(e) => setPingInterval(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                </SectionWrap>
              )}

              {activeSection === 'sla' && (
                <SectionWrap
                  title='SLA Business Hours'
                  onSave={saveSla}
                  saving={mutation.isPending}
                >
                  <Field
                    label='Timezone'
                    hint="IANA zone the business hours are expressed in (e.g. America/New_York). Empty = the API server's own zone — deployed containers run UTC, so set this."
                  >
                    <Input
                      value={slaTimezone}
                      onChange={(e) => setSlaTimezone(e.target.value)}
                      placeholder='America/New_York'
                      list='sla-tz-options'
                      className='h-8 text-[13px]'
                    />
                    {slaTimezone.trim() !== '' &&
                      (() => {
                        try {
                          new Intl.DateTimeFormat('en-US', { timeZone: slaTimezone.trim() })
                          return null
                        } catch {
                          return (
                            <p className='mt-1 text-[11px] text-red-500'>
                              Not a valid IANA timezone — it will be ignored.
                            </p>
                          )
                        }
                      })()}
                  </Field>
                  <RegionalClocksBlock
                    source={zoneSource}
                    onSourceChange={setZoneSource}
                    zoneMap={zoneMap}
                    onZoneMapChange={setZoneMap}
                    fallbackZone={slaTimezone.trim() || 'server local time'}
                  />
                  <Field label='Business day start (hour)' hint='24-hour format. Default: 9 (9am).'>
                    <Input
                      type='number'
                      min={0}
                      max={23}
                      value={slaStart}
                      onChange={(e) => setSlaStart(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field
                    label='Business day end (hour)'
                    hint='24-hour format, exclusive. Default: 17 (5pm).'
                  >
                    <Input
                      type='number'
                      min={1}
                      max={24}
                      value={slaEnd}
                      onChange={(e) => setSlaEnd(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <div className='space-y-1.5'>
                    <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      Working days
                    </Label>
                    <div className='flex gap-1.5'>
                      {DAYS.map((d) => (
                        <button
                          key={d.value}
                          type='button'
                          onClick={() => toggleSlaDay(d.value)}
                          className={cn(
                            'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                            slaBusinessDays.includes(d.value)
                              ? 'bg-[#00ceff]/15 text-[#00ceff] dark:bg-[#00ceff]/20'
                              : 'bg-slate-100 text-slate-400 hover:bg-slate-200 dark:bg-muted dark:text-muted-foreground'
                          )}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                    <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                      Used for business-hours SLA elapsed time calculations.
                    </p>
                  </div>
                  <div className='space-y-1.5'>
                    <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      Holidays
                    </Label>
                    <div className='flex items-center gap-2'>
                      <Input
                        type='date'
                        value={newHoliday}
                        onChange={(e) => setNewHoliday(e.target.value)}
                        className='h-8 w-40 text-[13px]'
                      />
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={!newHoliday || slaHolidays.includes(newHoliday)}
                        onClick={() => {
                          setSlaHolidays((prev) => [...prev, newHoliday].sort())
                          setNewHoliday('')
                        }}
                      >
                        <Plus className='mr-1 h-3.5 w-3.5' /> Add
                      </Button>
                    </div>
                    {slaHolidays.length > 0 && (
                      <div className='flex flex-wrap gap-1.5 pt-1'>
                        {slaHolidays.map((d) => (
                          <span
                            key={d}
                            className='inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'
                          >
                            {d}
                            <button
                              type='button'
                              onClick={() => setSlaHolidays((prev) => prev.filter((x) => x !== d))}
                              className='text-slate-400 hover:text-red-500'
                              aria-label={`Remove ${d}`}
                            >
                              <X className='h-3 w-3' />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                      Holiday dates count zero business hours regardless of weekday.
                    </p>
                  </div>
                </SectionWrap>
              )}

              {activeSection === 'content' && (
                <SectionWrap title='Content' onSave={saveContent} saving={mutation.isPending}>
                  <Field
                    label='File upload limit (MB)'
                    hint='Maximum size for a single file upload. Requires server restart to take effect.'
                  >
                    <Input
                      type='number'
                      min={1}
                      max={2048}
                      value={fileMaxMb}
                      onChange={(e) => setFileMaxMb(Number(e.target.value))}
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field
                    label='Collection page size'
                    hint='Default rows per page in the collection browser.'
                  >
                    <Select
                      value={String(collectionPageSize)}
                      onValueChange={(v) => setCollectionPageSize(Number(v))}
                    >
                      <SelectTrigger className='h-8 text-[13px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[10, 25, 50, 100].map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} rows
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    label='Activity log retention (days)'
                    hint='Delete activity log entries older than this many days. Leave blank to keep forever.'
                  >
                    <Input
                      type='number'
                      min={1}
                      placeholder='No limit'
                      value={activityRetentionDays}
                      onChange={(e) =>
                        setActivityRetentionDays(
                          e.target.value === '' ? '' : Number(e.target.value)
                        )
                      }
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <Field
                    label='Revision history limit (per item)'
                    hint='Keep only the most recent N revisions per record. Leave blank to keep all.'
                  >
                    <Input
                      type='number'
                      min={1}
                      placeholder='No limit'
                      value={revisionRetentionCount}
                      onChange={(e) =>
                        setRevisionRetentionCount(
                          e.target.value === '' ? '' : Number(e.target.value)
                        )
                      }
                      className='h-8 text-[13px]'
                    />
                  </Field>
                  <div className='flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 dark:border-border'>
                    <div>
                      <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                        Field-level record watches
                      </p>
                      <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                        Lets anyone watch one field on one record ("tell me when THIS PO's amount
                        changes") from the field's bell icon. Off by default.
                      </p>
                    </div>
                    <Switch checked={fieldWatchEnabled} onCheckedChange={setFieldWatchEnabled} />
                  </div>
                  <Field
                    label='Idle lock release (minutes)'
                    hint='Release a record edit lock after this many minutes without keyboard or mouse input from the holder — an abandoned tab stops holding the record hostage. Blank = never release on idle.'
                  >
                    <Input
                      type='number'
                      min={1}
                      value={lockIdleMinutes}
                      onChange={(e) =>
                        setLockIdleMinutes(e.target.value === '' ? '' : Number(e.target.value))
                      }
                      placeholder='e.g. 15'
                      className='h-8 w-40 text-[13px]'
                    />
                  </Field>
                </SectionWrap>
              )}

              {activeSection === 'email' && (
                <SectionWrap title='Email / SMTP' onSave={saveEmail} saving={mutation.isPending}>
                  {/* Provider presets */}
                  <div>
                    <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      Provider preset
                    </p>
                    <div className='flex flex-wrap gap-1.5'>
                      {EMAIL_PROVIDERS.map((p) => (
                        <button
                          key={p.label}
                          type='button'
                          onClick={() => {
                            setSmtpHost(p.host)
                            setSmtpPort(p.port)
                            setSmtpSecure(p.secure)
                          }}
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                            smtpHost === p.host
                              ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
                              : 'border-slate-200 text-slate-600 hover:border-slate-400 dark:border-border dark:text-slate-400'
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Field
                    label='SMTP host'
                    hint='DB value overrides SMTP_HOST env var. Leave blank to keep using env var.'
                  >
                    <Input
                      placeholder='smtp.example.com'
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      className='h-8 font-mono text-[13px]'
                    />
                  </Field>
                  <div className='grid grid-cols-2 gap-4'>
                    <Field label='SMTP port' hint='Usually 587 (STARTTLS) or 465 (TLS).'>
                      <Input
                        type='number'
                        min={1}
                        max={65535}
                        placeholder='587'
                        value={smtpPort}
                        onChange={(e) => setSmtpPort(e.target.value ? Number(e.target.value) : '')}
                        className='h-8 text-[13px]'
                      />
                    </Field>
                    <Field label='Secure (TLS)' hint='Enable for port 465. Leave off for STARTTLS.'>
                      <div className='flex h-8 items-center'>
                        <Switch checked={smtpSecure} onCheckedChange={setSmtpSecure} />
                      </div>
                    </Field>
                  </div>
                  <Field label='SMTP username'>
                    <Input
                      placeholder='no-reply@example.com'
                      value={smtpUser}
                      onChange={(e) => setSmtpUser(e.target.value)}
                      className='h-8 text-[13px]'
                      autoComplete='off'
                    />
                  </Field>
                  <Field
                    label='SMTP password'
                    hint={
                      (settings as Record<string, unknown>)?.smtp_pass
                        ? 'Password set. Enter a new value to replace, or leave as-is.'
                        : 'Leave blank to keep using SMTP_PASSWORD env var.'
                    }
                  >
                    <Input
                      type='password'
                      placeholder='••••••••'
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                      className='h-8 font-mono text-[13px]'
                      autoComplete='new-password'
                    />
                  </Field>
                  <Field
                    label='Mail from'
                    hint='Sender address shown on all outgoing emails. Overrides MAIL_FROM env var.'
                  >
                    <Input
                      placeholder='Nivaro <no-reply@example.com>'
                      value={smtpFrom}
                      onChange={(e) => setSmtpFrom(e.target.value)}
                      className='h-8 text-[13px]'
                    />
                  </Field>

                  {/* Test mode */}
                  <div
                    className={
                      mailTestMode
                        ? 'rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10'
                        : 'rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-border dark:bg-muted/30'
                    }
                  >
                    <div className='mb-2 flex items-center justify-between'>
                      <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                        Test mode
                      </p>
                      <Switch checked={mailTestMode} onCheckedChange={setMailTestMode} />
                    </div>
                    <p className='mb-3 text-[11px] text-slate-400'>
                      When on, every outgoing email is redirected to the test recipient instead of
                      its real recipients — subjects are tagged with the original addresses. Use in
                      dev and staging so real users never receive system mail. The MAIL_TEST_MODE
                      env var forces this on regardless of this switch.
                    </p>
                    {mailTestMode && (
                      <div className='space-y-3'>
                        <Field
                          label='Test recipient'
                          hint='All redirected mail goes here. If empty (and no MAIL_TEST_RECIPIENT env var), non-allowlisted mail is dropped with a server log.'
                        >
                          <Input
                            type='email'
                            placeholder='dev@example.com'
                            value={mailTestRecipient}
                            onChange={(e) => setMailTestRecipient(e.target.value)}
                            className='h-8 text-[13px]'
                          />
                        </Field>
                        <Field
                          label='Allowlist'
                          hint='Comma-separated emails and/or @domains that still receive mail normally, e.g. "qa@acme.com, @nodeworks.com".'
                        >
                          <Input
                            placeholder='qa@acme.com, @nodeworks.com'
                            value={mailTestAllowlist}
                            onChange={(e) => setMailTestAllowlist(e.target.value)}
                            className='h-8 text-[13px]'
                          />
                        </Field>
                      </div>
                    )}
                  </div>

                  {/* Environment label */}
                  <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-border dark:bg-muted/30'>
                    <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      Environment label
                    </p>
                    <p className='mb-3 text-[11px] text-slate-400'>
                      Prefixed onto every outgoing email subject — "[STAGING] Approval needed" — so
                      recipients always know which instance is talking. Leave empty on production.
                    </p>
                    <Input
                      placeholder='STAGING'
                      value={environmentLabel}
                      onChange={(e) => setEnvironmentLabel(e.target.value)}
                      className='h-8 w-56 text-[13px]'
                      maxLength={50}
                    />
                  </div>

                  {/* Test email */}
                  <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-border dark:bg-muted/30'>
                    <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      Send test email
                    </p>
                    <p className='mb-3 text-[11px] text-slate-400'>
                      Saves current settings first, then sends a test message using the active SMTP
                      config.
                    </p>
                    <div className='flex gap-2'>
                      <Input
                        type='email'
                        placeholder='you@example.com'
                        value={testTo}
                        onChange={(e) => setTestTo(e.target.value)}
                        className='h-8 flex-1 text-[13px]'
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') sendTestEmail()
                        }}
                      />
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        className='h-8 gap-1.5 text-[12px]'
                        disabled={testSending || mutation.isPending}
                        onClick={async () => {
                          saveEmail()
                          await sendTestEmail()
                        }}
                      >
                        <Send className='h-3.5 w-3.5' />
                        {testSending ? 'Sending…' : 'Send test'}
                      </Button>
                    </div>
                  </div>
                </SectionWrap>
              )}
              {activeSection === 'sms' &&
                (() => {
                  const providerMeta = SMS_PROVIDERS.find((p) => p.value === smsProvider)
                  return (
                    <SectionWrap title='SMS' onSave={saveSms} saving={mutation.isPending}>
                      {/* Provider chips */}
                      <div>
                        <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                          Provider
                        </p>
                        <div className='flex flex-wrap gap-1.5'>
                          {SMS_PROVIDERS.map((p) => (
                            <button
                              key={p.value}
                              type='button'
                              onClick={() => setSmsProvider(p.value)}
                              className={cn(
                                'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                                smsProvider === p.value
                                  ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
                                  : 'border-slate-200 text-slate-600 hover:border-slate-400 dark:border-border dark:text-slate-400'
                              )}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {providerMeta && (
                        <>
                          <Field label={providerMeta.sidLabel}>
                            <Input
                              placeholder={providerMeta.sidPlaceholder}
                              value={smsAccountSid}
                              onChange={(e) => setSmsAccountSid(e.target.value)}
                              className='h-8 font-mono text-[13px]'
                              autoComplete='off'
                            />
                          </Field>
                          <Field
                            label={providerMeta.tokenLabel}
                            hint={
                              (settings as Record<string, unknown>)?.sms_auth_token
                                ? 'Configured. Enter a new value to replace.'
                                : undefined
                            }
                          >
                            <Input
                              type='password'
                              placeholder='••••••••'
                              value={smsAuthToken}
                              onChange={(e) => setSmsAuthToken(e.target.value)}
                              className='h-8 font-mono text-[13px]'
                              autoComplete='new-password'
                            />
                          </Field>
                          <Field
                            label='From'
                            hint={
                              providerMeta.value === 'aws-sns'
                                ? 'Alphanumeric sender ID (max 11 chars) or phone number.'
                                : 'Phone number (E.164) or alphanumeric sender ID.'
                            }
                          >
                            <Input
                              placeholder='+12125550100'
                              value={smsFrom}
                              onChange={(e) => setSmsFrom(e.target.value)}
                              className='h-8 font-mono text-[13px]'
                            />
                          </Field>
                          {providerMeta.hasRegion && (
                            <Field label='AWS region' hint='SNS endpoint region.'>
                              <Input
                                placeholder='us-east-1'
                                value={smsRegion}
                                onChange={(e) => setSmsRegion(e.target.value)}
                                className='h-8 font-mono text-[13px]'
                              />
                            </Field>
                          )}
                        </>
                      )}

                      {/* Test mode */}
                      <div
                        className={
                          smsTestMode
                            ? 'rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10'
                            : 'rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-border dark:bg-muted/30'
                        }
                      >
                        <div className='mb-2 flex items-center justify-between'>
                          <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                            Test mode
                          </p>
                          <Switch checked={smsTestMode} onCheckedChange={setSmsTestMode} />
                        </div>
                        <p className='mb-3 text-[11px] text-slate-400'>
                          When on, every outgoing SMS is redirected to the test number instead of
                          its real recipient — the message is prefixed with the original number. Use
                          in dev and staging so real users never receive system texts. The
                          SMS_TEST_MODE env var forces this on regardless of this switch.
                        </p>
                        {smsTestMode && (
                          <div className='space-y-3'>
                            <Field
                              label='Test number'
                              hint='All redirected SMS goes here. If empty (and no SMS_TEST_RECIPIENT env var), non-allowlisted SMS is dropped with a server log.'
                            >
                              <Input
                                placeholder='+12125550100'
                                value={smsTestRecipient}
                                onChange={(e) => setSmsTestRecipient(e.target.value)}
                                className='h-8 font-mono text-[13px]'
                              />
                            </Field>
                            <Field
                              label='Allowlist'
                              hint='Comma-separated phone numbers that still receive SMS normally. Formatting is ignored when matching.'
                            >
                              <Input
                                placeholder='+12125550100, +13105550199'
                                value={smsTestAllowlist}
                                onChange={(e) => setSmsTestAllowlist(e.target.value)}
                                className='h-8 font-mono text-[13px]'
                              />
                            </Field>
                          </div>
                        )}
                      </div>

                      {/* Test SMS */}
                      <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-border dark:bg-muted/30'>
                        <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                          Send test SMS
                        </p>
                        <p className='mb-3 text-[11px] text-slate-400'>
                          Saves current settings first, then sends a test message.
                        </p>
                        <div className='flex gap-2'>
                          <Input
                            placeholder='+12125550100'
                            value={smsTestTo}
                            onChange={(e) => setSmsTestTo(e.target.value)}
                            className='h-8 flex-1 font-mono text-[13px]'
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                saveSms()
                                sendTestSms()
                              }
                            }}
                          />
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            className='h-8 gap-1.5 text-[12px]'
                            disabled={smsTestSending || mutation.isPending || !smsProvider}
                            onClick={() => {
                              saveSms()
                              sendTestSms()
                            }}
                          >
                            <Send className='h-3.5 w-3.5' />
                            {smsTestSending ? 'Sending…' : 'Send test'}
                          </Button>
                        </div>
                      </div>
                    </SectionWrap>
                  )
                })()}

              {activeSection === 'sso' && <SsoProvidersSection />}

              {activeSection === 'profile-fields' && <ProfileFieldDefsSection />}

              {activeSection === 'storage' && <FileStorageSection />}

              {activeSection === 'backups' && <BackupsSection />}

              {activeSection === 'instance' && <InstanceOverridesSection />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Regional SLA clocks ────────────────────────────────────────────────────
// Per-record timezone overrides: pick a geography collection (regions), map
// each of its records to an IANA zone. Records linked to a mapped region
// count business hours on that region's clock; everything else follows the
// instance timezone above. Saved with the SLA section's Save button.

const ZONE_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern — America/New_York' },
  { value: 'America/Chicago', label: 'Central — America/Chicago' },
  { value: 'America/Denver', label: 'Mountain — America/Denver' },
  { value: 'America/Phoenix', label: 'Arizona (no DST) — America/Phoenix' },
  { value: 'America/Los_Angeles', label: 'Pacific — America/Los_Angeles' },
  { value: 'America/Anchorage', label: 'Alaska — America/Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii — Pacific/Honolulu' },
  { value: 'UTC', label: 'UTC' }
]

function zoneRecordLabel(r: Record<string, unknown>): string {
  for (const k of ['name', 'short_name', 'label', 'title']) {
    const v = r[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return `#${String(r.id ?? '')}`
}

function RegionalClocksBlock({
  source,
  onSourceChange,
  zoneMap,
  onZoneMapChange,
  fallbackZone
}: {
  source: string
  onSourceChange: (v: string) => void
  zoneMap: Record<string, string>
  onZoneMapChange: (v: Record<string, string>) => void
  fallbackZone: string
}) {
  const trimmed = source.trim()
  const sourceValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) && !/^nivaro_/i.test(trimmed)
  const { data: records, isFetching, isError } = useQuery({
    queryKey: ['sla-zone-source-records', trimmed],
    enabled: sourceValid,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await api.get(`/items/${trimmed}?limit=200`)
      return (res.data.data ?? []) as Array<Record<string, unknown>>
    }
  })

  const rows = (records ?? [])
    .map((r) => ({ id: String(r.id), label: zoneRecordLabel(r) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const mappedCount = rows.filter((r) => (zoneMap[r.id] ?? '').trim() !== '').length
  // A stored zone outside the curated list (hand-set via API) must still render.
  const choicesFor = (tz: string) =>
    tz && !ZONE_CHOICES.some((c) => c.value === tz)
      ? [{ value: tz, label: tz }, ...ZONE_CHOICES]
      : ZONE_CHOICES

  return (
    <div className='space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 dark:border-border dark:bg-muted/30'>
      <div>
        <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Regional clocks
        </Label>
        <p className='mt-0.5 text-[11px] text-slate-400 dark:text-muted-foreground'>
          Records linked to a mapped region count business hours on that region's clock. Unmapped
          regions — and records with no region — follow the timezone above ({fallbackZone}).
        </p>
      </div>
      <div className='flex items-center gap-2'>
        <Label className='shrink-0 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
          Region collection
        </Label>
        <Input
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          placeholder='regions'
          className='h-7 w-44 text-[12px]'
        />
        {rows.length > 0 && (
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            {mappedCount} of {rows.length} mapped
          </span>
        )}
      </div>
      {!trimmed && (
        <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
          Enter the collection that holds your regions (e.g. <code>regions</code>) to map clocks.
        </p>
      )}
      {sourceValid && isError && (
        <p className='text-[11px] text-red-500'>
          Couldn't load records from “{trimmed}” — check the collection name.
        </p>
      )}
      {sourceValid && isFetching && rows.length === 0 && (
        <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>Loading records…</p>
      )}
      {rows.length > 0 && (
        <div className='max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
          {rows.map((r) => {
            const tz = (zoneMap[r.id] ?? '').trim()
            return (
              <div key={r.id} className='flex items-center justify-between gap-3 px-3 py-1.5'>
                <span className='truncate text-[12px] text-slate-700 dark:text-slate-200'>
                  {r.label}
                </span>
                <Select
                  value={tz || '__default__'}
                  onValueChange={(v) => {
                    const next = { ...zoneMap }
                    if (v === '__default__') delete next[r.id]
                    else next[r.id] = v
                    onZoneMapChange(next)
                  }}
                >
                  <SelectTrigger
                    className={cn(
                      'h-7 w-64 shrink-0 text-[12px]',
                      !tz && 'text-slate-400 dark:text-muted-foreground'
                    )}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='__default__' className='text-[12px]'>
                      Instance default
                    </SelectItem>
                    {choicesFor(tz).map((c) => (
                      <SelectItem key={c.value} value={c.value} className='text-[12px]'>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
