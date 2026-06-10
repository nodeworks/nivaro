import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BrainCircuit,
  Clock,
  Database,
  Globe,
  Mail,
  MessageSquare,
  Plus,
  Radio,
  Send,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
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
import { api, type CMSSettings, type Role } from '@/lib/api'
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
  | 'localization'
  | 'microsoft'
  | 'ai'
  | 'presence'
  | 'sla'
  | 'content'
  | 'email'
  | 'sms'

const NAV: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'project', label: 'Project', icon: <Settings2 className='h-3.5 w-3.5' /> },
  { id: 'localization', label: 'Localization', icon: <Globe className='h-3.5 w-3.5' /> },
  { id: 'microsoft', label: 'Microsoft', icon: <MessageSquare className='h-3.5 w-3.5' /> },
  { id: 'ai', label: 'AI Features', icon: <BrainCircuit className='h-3.5 w-3.5' /> },
  { id: 'presence', label: 'Presence', icon: <Radio className='h-3.5 w-3.5' /> },
  { id: 'sla', label: 'SLA', icon: <Clock className='h-3.5 w-3.5' /> },
  { id: 'content', label: 'Content', icon: <Database className='h-3.5 w-3.5' /> },
  { id: 'email', label: 'Email', icon: <Mail className='h-3.5 w-3.5' /> },
  { id: 'sms', label: 'SMS', icon: <MessageSquare className='h-3.5 w-3.5' /> }
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

  const [activeSection, setActiveSection] = useState<Section>('project')

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
  const [defaultLanguage, setDefaultLanguage] = useState('en-US')
  const [availableLocales, setAvailableLocales] = useState<string[]>(['en'])
  const [newLocale, setNewLocale] = useState('')
  const [teamsWebhook, setTeamsWebhook] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [sessionTtl, setSessionTtl] = useState(20)
  const [sweepInterval, setSweepInterval] = useState(8000)
  const [pingInterval, setPingInterval] = useState(10000)
  const [aiModel, setAiModel] = useState('claude-haiku-4-5-20251001')
  const [aiMaxGenerate, setAiMaxGenerate] = useState(500)
  const [aiMaxSummarize, setAiMaxSummarize] = useState(200)
  const [slaStart, setSlaStart] = useState(9)
  const [slaEnd, setSlaEnd] = useState(17)
  const [slaBusinessDays, setSlaBusinessDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [fileMaxMb, setFileMaxMb] = useState(50)
  const [collectionPageSize, setCollectionPageSize] = useState(25)
  const [activityRetentionDays, setActivityRetentionDays] = useState<number | ''>('')
  const [revisionRetentionCount, setRevisionRetentionCount] = useState<number | ''>('')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState<number | ''>(587)
  const [smtpUser, setSmtpUser] = useState('')
  const [smtpPass, setSmtpPass] = useState('')
  const [smtpFrom, setSmtpFrom] = useState('')
  const [smtpSecure, setSmtpSecure] = useState(false)
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
    setDefaultLanguage(settings.default_language ?? 'en-US')
    setAvailableLocales(toLocaleArray((settings as Record<string, unknown>).available_locales))
    setTeamsWebhook(settings.teams_webhook_url ?? '')
    setAnthropicKey(settings.anthropic_api_key ?? '')
    setSessionTtl(settings.presence_session_ttl ?? 20)
    setSweepInterval(settings.presence_sweep_interval ?? 8000)
    setPingInterval(settings.presence_ping_interval ?? 10000)
    setAiModel(settings.ai_model ?? 'claude-haiku-4-5-20251001')
    setAiMaxGenerate(settings.ai_max_tokens_generate ?? 500)
    setAiMaxSummarize(settings.ai_max_tokens_summarize ?? 200)
    setSlaStart(settings.sla_business_day_start ?? 9)
    setSlaEnd(settings.sla_business_day_end ?? 17)
    setSlaBusinessDays(
      (settings.sla_business_days ?? '1,2,3,4,5').split(',').map(Number).filter(Boolean)
    )
    setFileMaxMb(settings.file_max_size_mb ?? 50)
    setCollectionPageSize(settings.collection_page_size ?? 25)
    setActivityRetentionDays(settings.activity_retention_days ?? '')
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
      project_color: projectColor
    })
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
      sms_region: smsRegion || null
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
      smtp_secure: smtpSecure
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
      presence_session_ttl: sessionTtl,
      presence_sweep_interval: sweepInterval,
      presence_ping_interval: pingInterval
    })
  }

  function saveSla() {
    mutation.mutate({
      sla_business_day_start: slaStart,
      sla_business_day_end: slaEnd,
      sla_business_days: slaBusinessDays.join(',')
    })
  }

  function saveContent() {
    mutation.mutate({
      file_max_size_mb: fileMaxMb,
      collection_page_size: collectionPageSize,
      activity_retention_days: activityRetentionDays === '' ? null : activityRetentionDays,
      revision_retention_count: revisionRetentionCount === '' ? null : revisionRetentionCount
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
                    <div className='flex items-center gap-3'>
                      <input
                        type='color'
                        value={projectColor}
                        onChange={(e) => setProjectColor(e.target.value)}
                        className='h-9 w-14 cursor-pointer rounded-lg border border-slate-200 p-1 dark:border-border'
                      />
                      <code className='font-mono text-[12px] text-slate-500 dark:text-muted-foreground'>
                        {projectColor}
                      </code>
                    </div>
                  </Field>
                </SectionWrap>
              )}

              {activeSection === 'localization' && (
                <SectionWrap
                  title='Localization'
                  onSave={saveLocalization}
                  saving={mutation.isPending}
                >
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
                  title='Presence Tracking'
                  onSave={savePresence}
                  saving={mutation.isPending}
                >
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
