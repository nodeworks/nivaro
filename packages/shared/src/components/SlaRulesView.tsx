import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronsUpDown,
  Clock,
  Eye,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation, useNivaroClient } from '../context'
import { del, get, patch, post } from '../lib/commands'
import { cn, titleCase } from '../lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from './ui/command'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select'
import { Switch } from './ui/switch'

/**
 * SLA rules — "how long may a record sit in each workflow state before we
 * flag it". Shared view (admin hosts it at /sla-rules; headless frontends can
 * mount it too — needs NivaroProvider; every route it calls is requireAdmin).
 *
 * Layout: rules grouped by workflow template, each rule rendered as a
 * timeline row (green → amber at the warning threshold → red at breach) so
 * the whole policy reads at a glance. The editor is a wide two-column
 * dialog: what/when on the left, who-gets-told on the right.
 */

interface WorkflowTemplate {
  id: string
  name: string
}

interface StateOption {
  key: string
  label: string
  color?: string | null
}

interface CmsUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  role?: string | null
}

interface LadderTier {
  after_hours: number
  notify: string
}

export interface SlaRule {
  id: number
  workflow_template: string
  state_key: string
  name: string
  duration_hours: number
  warning_threshold_pct: number
  business_hours_only: boolean
  notify_on_warning: boolean
  notify_on_breach: boolean
  escalation_user: string | null
  escalation_ladder?: LadderTier[]
  is_active: boolean
  template_name?: string
}

interface SlaRuleFormValues {
  workflow_template: string
  state_keys: string[]
  name: string
  duration_hours: number
  warning_threshold_pct: number
  business_hours_only: boolean
  notify_on_warning: boolean
  notify_on_breach: boolean
  escalation_user: string | null
  escalation_ladder: LadderTier[]
  is_active: boolean
}

const FORM_DEFAULTS: SlaRuleFormValues = {
  workflow_template: '',
  state_keys: [],
  name: '',
  duration_hours: 24,
  warning_threshold_pct: 80,
  business_hours_only: false,
  notify_on_warning: true,
  notify_on_breach: true,
  escalation_user: null,
  escalation_ladder: [],
  is_active: true
}

function userLabel(u: CmsUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}

function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return '—'
  const rounded = Math.round(h * 10) / 10
  if (rounded >= 48 && rounded % 24 === 0) return `${rounded / 24}d`
  return `${rounded}h`
}

/** The rule as a proportional timeline: on-track → warning zone → breach. */
function SlaTimeline({
  durationHours,
  warningPct,
  compact
}: {
  durationHours: number
  warningPct: number
  compact?: boolean
}) {
  const pct = Math.min(99, Math.max(1, warningPct))
  const warnAt = (durationHours * pct) / 100
  return (
    <div className={cn('min-w-0', compact ? 'w-full' : '')}>
      <div className='flex h-2 w-full overflow-hidden rounded-full'>
        <div className='bg-emerald-400/80 dark:bg-emerald-500/70' style={{ width: `${pct}%` }} />
        <div className='flex-1 bg-amber-400/90 dark:bg-amber-500/80' />
        <div className='w-1.5 shrink-0 bg-red-500' />
      </div>
      <div className='mt-1 flex items-center justify-between text-[10.5px] leading-tight text-slate-400'>
        <span>0h</span>
        <span className='text-amber-600 dark:text-amber-400'>warns {fmtHours(warnAt)}</span>
        <span className='text-red-500'>breach {fmtHours(durationHours)}</span>
      </div>
    </div>
  )
}

function RolePill({ name }: { name: string | undefined }) {
  if (!name) return null
  return (
    <span className='shrink-0 whitespace-nowrap rounded-full bg-slate-100 px-1.5 py-px text-[10px] text-slate-500 dark:bg-muted dark:text-muted-foreground'>
      {name}
    </span>
  )
}

/**
 * Searchable person picker — alphabetical, role pill per person. `specials`
 * render above the people (the ladder's "owners"/"managers" targets), and
 * `userValue` maps a picked person to the stored value ('user:<id>' for
 * ladder tiers, the bare id for the escalation user).
 */
function UserCombobox({
  id,
  value,
  onChange,
  users,
  roleNames,
  placeholder,
  specials = [],
  clearable = true,
  userValue = (u) => u.id,
  compact
}: {
  id?: string
  value: string | null
  onChange: (value: string | null) => void
  users: CmsUser[]
  roleNames: Record<string, string>
  placeholder: string
  specials?: Array<{ value: string; label: string }>
  clearable?: boolean
  userValue?: (u: CmsUser) => string
  compact?: boolean
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  // A person picked via server search isn't in the preloaded list — remember
  // them so the trigger can still render the selection.
  const [picked, setPicked] = useState<CmsUser | null>(null)
  const special = value ? specials.find((s) => s.value === value) : null
  const selected =
    value && !special
      ? (users.find((u) => userValue(u).toUpperCase() === value.toUpperCase()) ??
        (picked && userValue(picked).toUpperCase() === value.toUpperCase() ? picked : null))
      : null
  // Server-side search: the preloaded list is capped, so an older account
  // would otherwise simply never appear no matter what is typed.
  const { data: searched } = useQuery<CmsUser[]>({
    queryKey: ['sla-user-search', search],
    enabled: open && search.trim().length > 0,
    staleTime: 60_000,
    queryFn: async () =>
      ((await client.request(
        get<{ data: CmsUser[] }>(
          `/users?search=${encodeURIComponent(search.trim())}&limit=30&sort=first_name`
        )
      )) as { data: CmsUser[] }).data
  })
  const sorted = useMemo(() => {
    const base = search.trim() && searched ? searched : users
    return [...base].sort((a, b) => userLabel(a).localeCompare(userLabel(b)))
  }, [users, searched, search])
  const roleFor = (u: CmsUser) => roleNames[String(u.role ?? '').toUpperCase()]
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type='button'
          className={cn(
            'flex w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left shadow-sm',
            compact ? 'h-8 text-[12px]' : 'h-9 text-sm'
          )}
        >
          {special ? (
            <span className='min-w-0 flex-1 truncate'>{special.label}</span>
          ) : selected ? (
            <>
              <span className='min-w-0 flex-1 truncate'>{userLabel(selected)}</span>
              <RolePill name={roleFor(selected)} />
            </>
          ) : (
            <span className='min-w-0 flex-1 truncate text-muted-foreground'>{placeholder}</span>
          )}
          <ChevronsUpDown className='ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] min-w-[440px] p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput placeholder='Search people…' value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{search.trim() ? 'No matches.' : 'Type to search…'}</CommandEmpty>
            <CommandGroup>
              {clearable && value && (
                <CommandItem
                  value='__none__'
                  onSelect={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                  className='text-[12px] text-muted-foreground'
                >
                  No one
                </CommandItem>
              )}
              {specials.map((s) => (
                <CommandItem
                  key={s.value}
                  value={`${s.label} ${s.value}`}
                  onSelect={() => {
                    onChange(s.value)
                    setOpen(false)
                  }}
                  className='gap-2 text-[12px]'
                >
                  <Check
                    className={cn('h-3.5 w-3.5 shrink-0', value === s.value ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className='font-medium'>{s.label}</span>
                </CommandItem>
              ))}
              {sorted.map((u) => {
                const v = userValue(u)
                return (
                  <CommandItem
                    key={u.id}
                    value={`${userLabel(u)} ${u.email}`}
                    onSelect={() => {
                      setPicked(u)
                      onChange(v)
                      setOpen(false)
                    }}
                    className='gap-2 text-[12px]'
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        value && value.toUpperCase() === v.toUpperCase()
                          ? 'opacity-100'
                          : 'opacity-0'
                      )}
                    />
                    <span className='min-w-0 flex-1 truncate whitespace-nowrap font-medium'>
                      {userLabel(u)}
                    </span>
                    <RolePill name={roleFor(u)} />
                    <span className='max-w-[42%] shrink-0 truncate whitespace-nowrap text-[10.5px] text-slate-400'>
                      {u.email}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ladderTierLabel(tier: LadderTier, users: CmsUser[]): string {
  if (tier.notify === 'owner') return 'owners again'
  if (tier.notify === 'manager') return 'managers'
  if (tier.notify.startsWith('user:')) {
    const u = users.find((x) => x.id.toUpperCase() === tier.notify.slice(5).toUpperCase())
    return u ? userLabel(u) : 'a specific person'
  }
  return tier.notify
}

// ─── Editor dialog ─────────────────────────────────────────────────────────

function SlaRuleForm({
  initial,
  templates,
  users,
  roleNames,
  multiState,
  onSave,
  onCancel,
  saving
}: {
  initial?: SlaRuleFormValues
  templates: WorkflowTemplate[]
  users: CmsUser[]
  roleNames: Record<string, string>
  /** create mode: pick many states, one rule per state; edit mode: single. */
  multiState: boolean
  onSave: (data: SlaRuleFormValues) => void
  onCancel: () => void
  saving: boolean
}) {
  const client = useNivaroClient()
  const [form, setForm] = useState<SlaRuleFormValues>(initial ?? FORM_DEFAULTS)
  const [statesOpen, setStatesOpen] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [whatIf, setWhatIf] = useState<{
    total: number
    proposed: { ok: number; warning: number; breached: number }
    flips: Array<{ collection: string; item: string; from: string; to: string }>
  } | null>(null)

  function set<K extends keyof SlaRuleFormValues>(key: K, value: SlaRuleFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const { data: stateOptions = [] } = useQuery<StateOption[]>({
    queryKey: ['sla-form-states', form.workflow_template],
    enabled: !!form.workflow_template,
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: { states: StateOption[] } }>(`/pipelines/${form.workflow_template}`)
      )) as { data: { states: StateOption[] } }
      return res.data.states ?? []
    }
  })
  const stateLabel = (key: string) => stateOptions.find((s) => s.key === key)?.label ?? key

  function toggleState(key: string) {
    setForm((prev) => {
      const has = prev.state_keys.includes(key)
      const next = multiState
        ? has
          ? prev.state_keys.filter((k) => k !== key)
          : [...prev.state_keys, key]
        : [key]
      return { ...prev, state_keys: next }
    })
    if (!multiState) setStatesOpen(false)
  }

  const isValid =
    form.workflow_template.trim() !== '' &&
    form.state_keys.length > 0 &&
    form.name.trim() !== '' &&
    form.duration_hours > 0

  const warnAtHours = (form.duration_hours * Math.min(99, Math.max(1, form.warning_threshold_pct))) / 100

  return (
    <div className='px-6 pb-6'>
      <div className='grid gap-x-8 gap-y-5 md:grid-cols-2'>
        {/* ── Left: what + when ── */}
        <div className='space-y-5'>
          <div className='space-y-1.5'>
            <Label htmlFor='sla-name'>Rule name</Label>
            <Input
              id='sla-name'
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder='e.g. Finance review turnaround'
            />
          </div>

          <div className='space-y-1.5'>
            <Label htmlFor='sla-template'>Workflow</Label>
            <Select
              value={form.workflow_template}
              onValueChange={(v) =>
                setForm((prev) => ({ ...prev, workflow_template: v, state_keys: [] }))
              }
            >
              <SelectTrigger id='sla-template'>
                <SelectValue placeholder='Select a workflow…' />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-1.5'>
            <Label htmlFor='sla-state-key'>{multiState ? 'States it applies to' : 'State'}</Label>
            <Popover modal open={statesOpen} onOpenChange={setStatesOpen}>
              <PopoverTrigger asChild>
                <button
                  id='sla-state-key'
                  type='button'
                  disabled={!form.workflow_template}
                  className='flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-left text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50'
                >
                  {form.state_keys.length === 0 ? (
                    <span className='text-muted-foreground'>
                      {form.workflow_template ? 'Select state…' : 'Pick a workflow first'}
                    </span>
                  ) : (
                    form.state_keys.map((k) => (
                      <Badge key={k} variant='outline' className='text-[11px] font-normal'>
                        {stateLabel(k)}
                      </Badge>
                    ))
                  )}
                  <ChevronsUpDown className='ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground' />
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search states…' />
                  <CommandList>
                    <CommandEmpty>No states found.</CommandEmpty>
                    <CommandGroup>
                      {stateOptions.map((s) => (
                        <CommandItem
                          key={s.key}
                          value={`${s.label} ${s.key}`}
                          onSelect={() => toggleState(s.key)}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-3.5 w-3.5',
                              form.state_keys.includes(s.key) ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          {s.label}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {multiState && (
              <p className='text-[11px] text-muted-foreground'>
                Pick several to create one rule per state in one go.
              </p>
            )}
          </div>

          <div className='space-y-3 rounded-lg border border-border p-4'>
            <p className='text-sm font-medium'>Timing</p>
            <div className='grid grid-cols-2 gap-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='sla-duration' className='whitespace-nowrap'>
                  Time allowed (hours)
                </Label>
                <Input
                  id='sla-duration'
                  type='number'
                  min={1}
                  value={form.duration_hours}
                  onChange={(e) => set('duration_hours', Number(e.target.value))}
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='sla-warning-pct' className='whitespace-nowrap'>
                  Warn at (%)
                </Label>
                <Input
                  id='sla-warning-pct'
                  type='number'
                  min={1}
                  max={99}
                  value={form.warning_threshold_pct}
                  onChange={(e) => set('warning_threshold_pct', Number(e.target.value))}
                />
              </div>
            </div>
            <p className='text-[11.5px] leading-relaxed text-muted-foreground'>
              A record may sit in this state for <b>{fmtHours(form.duration_hours)}</b> from the
              moment it arrives — after that it counts as <b className='text-red-500'>breached</b>.
              At {form.warning_threshold_pct}% of that time (
              <b className='text-amber-600 dark:text-amber-400'>{fmtHours(warnAtHours)}</b>) it
              turns amber, so owners get a heads-up while there is still time to act.
            </p>
            <SlaTimeline
              durationHours={form.duration_hours}
              warningPct={form.warning_threshold_pct}
            />
            <div className='flex items-center justify-between pt-1'>
              <div>
                <p className='text-[13px] font-medium'>Count business hours only</p>
                <p className='text-[11px] text-muted-foreground'>
                  The clock only runs during working hours (as configured in Settings — weekends
                  and holidays don't count).
                </p>
              </div>
              <Switch
                checked={form.business_hours_only}
                onCheckedChange={(v) => set('business_hours_only', v)}
              />
            </div>
          </div>
        </div>

        {/* ── Right: who gets told ── */}
        <div className='space-y-5'>
          <div className='space-y-3 rounded-lg border border-border p-4'>
            <p className='text-sm font-medium'>Notifications</p>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-[13px] font-medium'>When the warning hits</p>
                <p className='text-[11px] text-muted-foreground'>
                  Owners are notified as the record turns amber.
                </p>
              </div>
              <Switch
                checked={form.notify_on_warning}
                onCheckedChange={(v) => set('notify_on_warning', v)}
              />
            </div>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-[13px] font-medium'>When the SLA is breached</p>
                <p className='text-[11px] text-muted-foreground'>
                  Owners are notified the moment time runs out.
                </p>
              </div>
              <Switch
                checked={form.notify_on_breach}
                onCheckedChange={(v) => set('notify_on_breach', v)}
              />
            </div>
            <div className='space-y-1.5 pt-1'>
              <Label htmlFor='sla-escalation'>Also escalate to</Label>
              <UserCombobox
                id='sla-escalation'
                value={form.escalation_user}
                onChange={(v) => set('escalation_user', v)}
                users={users}
                roleNames={roleNames}
                placeholder='No one'
              />
              <p className='text-[11px] text-muted-foreground'>
                A specific person who is copied on the breach notice.
              </p>
            </div>
          </div>

          <div className='space-y-2 rounded-lg border border-border p-4'>
            <div>
              <p className='text-sm font-medium'>Escalation ladder</p>
              <p className='text-[11px] leading-relaxed text-muted-foreground'>
                If nobody acknowledges the breach on the record, keep climbing: each tier fires
                the given number of hours <i>past the breach</i>.
              </p>
            </div>
            {form.escalation_ladder.map((tier, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
              <div key={idx} className='flex items-center gap-2'>
                <span className='shrink-0 text-[12px] text-muted-foreground'>after</span>
                <Input
                  type='number'
                  min={1}
                  value={tier.after_hours}
                  onChange={(e) =>
                    set(
                      'escalation_ladder',
                      form.escalation_ladder.map((t, i) =>
                        i === idx ? { ...t, after_hours: Number(e.target.value) } : t
                      )
                    )
                  }
                  className='h-8 w-[72px] text-[12px]'
                />
                <span className='shrink-0 text-[12px] text-muted-foreground'>h, notify</span>
                <div className='min-w-0 flex-1'>
                  <UserCombobox
                    value={tier.notify}
                    onChange={(v) =>
                      set(
                        'escalation_ladder',
                        form.escalation_ladder.map((t, i) =>
                          i === idx ? { ...t, notify: v ?? 'manager' } : t
                        )
                      )
                    }
                    users={users}
                    roleNames={roleNames}
                    placeholder='Who to notify'
                    specials={[
                      { value: 'owner', label: 'Record owners (again)' },
                      { value: 'manager', label: "Owners' managers" }
                    ]}
                    clearable={false}
                    userValue={(u) => `user:${u.id}`}
                    compact
                  />
                </div>
                <button
                  type='button'
                  onClick={() =>
                    set(
                      'escalation_ladder',
                      form.escalation_ladder.filter((_, i) => i !== idx)
                    )
                  }
                  className='shrink-0 text-[13px] text-slate-300 hover:text-red-500'
                  aria-label='Remove tier'
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type='button'
              onClick={() =>
                set('escalation_ladder', [
                  ...form.escalation_ladder,
                  {
                    after_hours: (form.escalation_ladder.at(-1)?.after_hours ?? 0) + 4,
                    notify: 'manager'
                  }
                ])
              }
              className='text-[12px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground'
            >
              ＋ Add tier
            </button>
          </div>

          <div className='flex items-center justify-between rounded-lg border border-border p-4'>
            <div>
              <p className='text-sm font-medium'>Active</p>
              <p className='text-[11px] text-muted-foreground'>
                Paused rules keep their config but stop tracking and notifying.
              </p>
            </div>
            <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} />
          </div>
        </div>
      </div>

      {whatIf && (
        <div className='mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] dark:border-border dark:bg-muted/40'>
          <p>
            <b>{whatIf.total}</b> open record(s) in this state right now. Under the proposed rule:{' '}
            <span className='text-emerald-600'>{whatIf.proposed.ok} ok</span> ·{' '}
            <span className='text-amber-600'>{whatIf.proposed.warning} warning</span> ·{' '}
            <span className='text-red-600'>{whatIf.proposed.breached} breached</span>
          </p>
          {whatIf.flips.length > 0 && (
            <p className='mt-1 text-slate-500'>
              {whatIf.flips.length} record(s) flip status — e.g.{' '}
              {whatIf.flips
                .slice(0, 3)
                .map((f) => `${f.collection}/${f.item} (${f.from}→${f.to})`)
                .join(', ')}
            </p>
          )}
        </div>
      )}

      <DialogFooter className='mt-5'>
        <Button
          variant='outline'
          disabled={!isValid || previewing}
          onClick={() => {
            setPreviewing(true)
            void client
              .request(
                post('/sla/what-if', {
                  workflow_template: form.workflow_template,
                  state_key: form.state_keys[0],
                  duration_hours: form.duration_hours,
                  warning_threshold_pct: form.warning_threshold_pct,
                  business_hours_only: form.business_hours_only
                })
              )
              .then((r) => setWhatIf((r as { data: typeof whatIf }).data))
              .catch(() => toast.error('Preview failed'))
              .finally(() => setPreviewing(false))
          }}
        >
          {previewing ? 'Previewing…' : 'Preview impact'}
        </Button>
        <Button variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(form)} disabled={saving || !isValid}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** The records currently sitting under a rule — worst first. */
function RulePreviewPanel({ rule }: { rule: SlaRule }) {
  const client = useNivaroClient()
  const { urlFor, open } = useItemNavigation()
  const { data, isLoading } = useQuery<{
    total: number
    counts?: { ok: number; warning: number; breached: number }
    truncated?: boolean
    records: Array<{
      collection: string
      item: string
      label: string
      status: 'ok' | 'warning' | 'breached'
      elapsed_hours: number
      remaining_hours: number
      entered_at: string
    }>
  }>({
    queryKey: ['sla-rule-records', rule.id],
    queryFn: async () =>
      ((await client.request(get<{ data: never }>(`/sla/rules/${rule.id}/records`))) as {
        data: {
          total: number
          counts?: { ok: number; warning: number; breached: number }
          truncated?: boolean
          records: Array<{
            collection: string
            item: string
            label: string
            status: 'ok' | 'warning' | 'breached'
            elapsed_hours: number
            remaining_hours: number
            entered_at: string
          }>
        }
      }).data
  })

  const STATUS_PILL: Record<string, string> = {
    ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    breached: 'bg-red-500/10 text-red-700 dark:text-red-400'
  }

  return (
    <div className='border-t border-slate-100 bg-slate-50/60 px-4 py-3 dark:border-border dark:bg-muted/20'>
      {isLoading ? (
        <div className='space-y-2'>
          {[1, 2, 3].map((i) => (
            <div key={i} className='h-7 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : !data || data.total === 0 ? (
        <p className='text-[12px] text-slate-400'>No open records are in this state right now.</p>
      ) : (
        <>
          <p className='mb-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {data.total} open record{data.total === 1 ? '' : 's'} in this state —{' '}
            <span className='text-red-600 dark:text-red-400'>{data.counts?.breached ?? 0} breached</span>
            {' · '}
            <span className='text-amber-600 dark:text-amber-400'>{data.counts?.warning ?? 0} warning</span>
            {' · '}
            <span className='text-emerald-600 dark:text-emerald-400'>{data.counts?.ok ?? 0} on track</span>
            {data.truncated ? ' (showing the worst 200)' : ''}
          </p>
          <div className='overflow-x-auto rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='w-full text-[12px]' style={{ fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border'>
                  <th className='px-3 py-1.5 font-semibold'>Record</th>
                  <th className='px-3 py-1.5 font-semibold'>Status</th>
                  <th className='px-3 py-1.5 text-right font-semibold'>In state</th>
                  <th className='px-3 py-1.5 text-right font-semibold'>Time left</th>
                  <th className='px-3 py-1.5 text-right font-semibold'>Entered</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {data.records.map((r) => (
                  <tr key={`${r.collection}:${r.item}`}>
                    <td className='px-3 py-1.5'>
                      <a
                        href={urlFor({ collection: r.collection, itemId: r.item })}
                        onClick={(e) => {
                          e.preventDefault()
                          open({ collection: r.collection, itemId: r.item })
                        }}
                        className='text-nvr-cyan underline decoration-slate-300 decoration-1 underline-offset-2 hover:text-[#009abe]'
                      >
                        {r.label}
                      </a>
                    </td>
                    <td className='px-3 py-1.5'>
                      <span
                        className={cn(
                          'rounded-full px-2 py-px text-[10.5px] font-medium capitalize',
                          STATUS_PILL[r.status]
                        )}
                      >
                        {r.status === 'ok' ? 'On track' : r.status}
                      </span>
                    </td>
                    <td className='px-3 py-1.5 text-right'>{fmtHours(r.elapsed_hours)}</td>
                    <td
                      className={cn(
                        'px-3 py-1.5 text-right',
                        r.remaining_hours < 0 && 'text-red-600 dark:text-red-400'
                      )}
                    >
                      {r.remaining_hours < 0
                        ? `${fmtHours(Math.abs(r.remaining_hours))} over`
                        : fmtHours(r.remaining_hours)}
                    </td>
                    <td className='px-3 py-1.5 text-right text-slate-400'>
                      {new Date(r.entered_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── List view ─────────────────────────────────────────────────────────────

export function SlaRulesView() {
  const client = useNivaroClient()
  const qc = useQueryClient()

  const { data: rules = [], isLoading } = useQuery<SlaRule[]>({
    queryKey: ['sla-rules'],
    queryFn: async () =>
      ((await client.request(get<{ data: SlaRule[] }>('/sla/rules'))) as { data: SlaRule[] }).data
  })
  const { data: templates = [] } = useQuery<WorkflowTemplate[]>({
    queryKey: ['sla-templates'],
    queryFn: async () =>
      ((await client.request(get<{ data: WorkflowTemplate[] }>('/pipelines'))) as {
        data: WorkflowTemplate[]
      }).data
  })
  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['sla-users'],
    queryFn: async () =>
      ((await client.request(get<{ data: CmsUser[] }>('/users?limit=500'))) as { data: CmsUser[] })
        .data
  })
  const { data: roleNames = {} } = useQuery<Record<string, string>>({
    queryKey: ['sla-role-names'],
    staleTime: 300_000,
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: Array<{ id: string; name: string }> }>('/roles')
      )) as { data: Array<{ id: string; name: string }> }
      const map: Record<string, string> = {}
      for (const r of res.data ?? []) map[String(r.id).toUpperCase()] = r.name
      return map
    }
  })

  // State labels/colors per template that actually has rules — feeds friendly
  // state names in the list instead of raw keys.
  const templateIds = useMemo(
    () => [...new Set(rules.map((r) => r.workflow_template))],
    [rules]
  )
  const stateQueries = useQueries({
    queries: templateIds.map((tid) => ({
      queryKey: ['sla-template-states', tid],
      staleTime: 300_000,
      queryFn: async () => {
        const res = (await client.request(
          get<{ data: { states: StateOption[] } }>(`/pipelines/${tid}`)
        )) as { data: { states: StateOption[] } }
        return { tid, states: res.data.states ?? [] }
      }
    }))
  })
  const stateMeta = useMemo(() => {
    const map = new Map<string, StateOption & { sort: number }>()
    for (const q of stateQueries) {
      const d = q.data as { tid: string; states: StateOption[] } | undefined
      if (!d) continue
      d.states.forEach((s, i) => map.set(`${d.tid}:${s.key}`, { ...s, sort: i }))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateQueries.map((q) => (q.data ? '1' : '0')).join('')])

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SlaRule | null>(null)
  const [deleting, setDeleting] = useState<SlaRule | null>(null)
  const [previewId, setPreviewId] = useState<number | null>(null)

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['sla-rules'] })

  const createMut = useMutation({
    // One rule per selected state; with several states the state label is
    // appended so the resulting rows stay distinguishable.
    mutationFn: async (values: SlaRuleFormValues) => {
      const { state_keys, ...rest } = values
      const results = await Promise.allSettled(
        state_keys.map((state_key) =>
          client.request(
            post('/sla/rules', {
              ...rest,
              state_key,
              name:
                state_keys.length > 1
                  ? `${rest.name} — ${titleCase(state_key.replace(/_/g, ' '))}`
                  : rest.name
            })
          )
        )
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      return { created: results.length - failed, failed }
    },
    onSuccess: ({ created, failed }) => {
      invalidate()
      setCreating(false)
      if (failed > 0) toast.warning(`${created} SLA rules created, ${failed} failed`)
      else toast.success(created > 1 ? `${created} SLA rules created` : 'SLA rule created')
    },
    onError: () => toast.error('Failed to create SLA rule')
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: SlaRuleFormValues }) => {
      const { state_keys, ...rest } = body
      return client.request(patch(`/sla/rules/${id}`, { ...rest, state_key: state_keys[0] }))
    },
    onSuccess: () => {
      invalidate()
      setEditing(null)
      toast.success('SLA rule updated')
    },
    onError: () => toast.error('Failed to update SLA rule')
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      client.request(patch(`/sla/rules/${id}`, { is_active: active })),
    onSuccess: invalidate,
    onError: () => toast.error('Could not update the rule')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => client.request(del(`/sla/rules/${id}`)),
    onSuccess: () => {
      invalidate()
      setDeleting(null)
      toast.success('SLA rule deleted')
    },
    onError: () => toast.error('Failed to delete SLA rule')
  })

  function toFormData(rule: SlaRule): SlaRuleFormValues {
    return {
      workflow_template: rule.workflow_template,
      state_keys: [rule.state_key],
      name: rule.name,
      duration_hours: rule.duration_hours,
      warning_threshold_pct: rule.warning_threshold_pct,
      business_hours_only: rule.business_hours_only,
      notify_on_warning: rule.notify_on_warning,
      notify_on_breach: rule.notify_on_breach,
      escalation_user: rule.escalation_user,
      escalation_ladder: Array.isArray(rule.escalation_ladder) ? rule.escalation_ladder : [],
      is_active: rule.is_active
    }
  }

  // Group by template, rules within a group in the template's state order.
  const groups = useMemo(() => {
    const byTemplate = new Map<string, { name: string; rules: SlaRule[] }>()
    for (const r of rules) {
      const g = byTemplate.get(r.workflow_template) ?? {
        name: r.template_name ?? r.workflow_template,
        rules: []
      }
      g.rules.push(r)
      byTemplate.set(r.workflow_template, g)
    }
    for (const [tid, g] of byTemplate) {
      g.rules.sort(
        (a, b) =>
          (stateMeta.get(`${tid}:${a.state_key}`)?.sort ?? 999) -
          (stateMeta.get(`${tid}:${b.state_key}`)?.sort ?? 999)
      )
    }
    return [...byTemplate.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))
  }, [rules, stateMeta])

  const activeCount = rules.filter((r) => r.is_active).length

  return (
    <div className='space-y-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <p className='max-w-[72ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          How long a record may sit in each workflow state before it's flagged. Records turn amber
          at the warning point, red at breach — owners are notified, and breaches can escalate up
          a ladder until someone acknowledges.
        </p>
        <div className='flex items-center gap-3'>
          {rules.length > 0 && (
            <span className='whitespace-nowrap text-[12px] text-slate-400'>
              {activeCount} active · {rules.length} total
            </span>
          )}
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus className='mr-1.5 h-4 w-4' />
            New rule
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className='space-y-3'>
          {[1, 2, 3].map((i) => (
            <div key={i} className='h-16 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <div className='flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 py-20 text-center dark:border-border'>
          <Clock className='mb-3 h-10 w-10 text-muted-foreground' />
          <p className='mb-1 text-sm font-medium'>No SLA rules yet</p>
          <p className='mb-4 max-w-[46ch] text-xs text-muted-foreground'>
            Pick a workflow state and say how long a record may wait there — e.g. "Finance review
            within 2 business days". Owners get warned before it's late.
          </p>
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus className='mr-1.5 h-4 w-4' />
            New rule
          </Button>
        </div>
      ) : (
        <div className='space-y-5'>
          {groups.map(([tid, g]) => (
            <section key={tid} className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <header className='flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-border'>
                <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                  {g.name}
                </h2>
                <span className='text-[11.5px] text-slate-400'>
                  {g.rules.length} rule{g.rules.length === 1 ? '' : 's'}
                </span>
              </header>
              <ul className='divide-y divide-slate-100 dark:divide-border'>
                {g.rules.map((rule) => {
                  const meta = stateMeta.get(`${tid}:${rule.state_key}`)
                  const ladder = Array.isArray(rule.escalation_ladder)
                    ? rule.escalation_ladder
                    : []
                  const escUser = rule.escalation_user
                    ? users.find((u) => u.id.toUpperCase() === rule.escalation_user?.toUpperCase())
                    : null
                  return (
                    <li key={rule.id}>
                      <div
                        className={cn(
                          'group flex items-center gap-4 px-4 py-3',
                          !rule.is_active && 'opacity-55'
                        )}
                      >
                      <div className='w-[220px] min-w-0 shrink-0'>
                        <p className='flex items-center gap-1.5 truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                          {meta?.color && (
                            <span
                              className='h-2 w-2 shrink-0 rounded-full'
                              style={{ backgroundColor: meta.color }}
                            />
                          )}
                          {meta?.label ?? titleCase(rule.state_key.replace(/_/g, ' '))}
                        </p>
                        <p className='truncate text-[11.5px] text-slate-400'>{rule.name}</p>
                      </div>

                      <div className='w-[240px] shrink-0'>
                        <SlaTimeline
                          durationHours={rule.duration_hours}
                          warningPct={rule.warning_threshold_pct}
                          compact
                        />
                      </div>

                      <div className='flex min-w-0 flex-1 flex-wrap items-center gap-1.5'>
                        <Badge variant='outline' className='whitespace-nowrap text-[10.5px] font-normal'>
                          {rule.business_hours_only ? 'Business hours' : 'Calendar time'}
                        </Badge>
                        {(rule.notify_on_warning || rule.notify_on_breach) && (
                          <Badge variant='outline' className='gap-1 whitespace-nowrap text-[10.5px] font-normal'>
                            <Bell className='h-2.5 w-2.5' />
                            {rule.notify_on_warning && rule.notify_on_breach
                              ? 'Warn + breach'
                              : rule.notify_on_warning
                                ? 'Warn only'
                                : 'Breach only'}
                          </Badge>
                        )}
                        {escUser && (
                          <Badge variant='outline' className='gap-1 whitespace-nowrap text-[10.5px] font-normal'>
                            <ArrowUpRight className='h-2.5 w-2.5' />
                            {userLabel(escUser)}
                          </Badge>
                        )}
                        {ladder.length > 0 && (
                          <Badge
                            variant='outline'
                            className='whitespace-nowrap text-[10.5px] font-normal'
                            title={ladder
                              .map((t) => `+${t.after_hours}h → ${ladderTierLabel(t, users)}`)
                              .join(' · ')}
                          >
                            {ladder.length}-tier ladder
                          </Badge>
                        )}
                      </div>

                      <div className='flex shrink-0 items-center gap-1'>
                        <Button
                          variant='ghost'
                          size='sm'
                          className={cn(
                            'h-7 gap-1 px-2 text-[11.5px]',
                            previewId === rule.id
                              ? 'text-nvr-cyan'
                              : 'text-slate-500 dark:text-muted-foreground'
                          )}
                          onClick={() => setPreviewId(previewId === rule.id ? null : rule.id)}
                        >
                          <Eye className='h-3.5 w-3.5' />
                          Preview
                        </Button>
                        <Switch
                          checked={rule.is_active}
                          onCheckedChange={(v) => toggleMut.mutate({ id: rule.id, active: v })}
                          aria-label={rule.is_active ? 'Pause rule' : 'Activate rule'}
                        />
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100'
                          onClick={() => setEditing(rule)}
                        >
                          <Pencil className='h-3.5 w-3.5' />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7 text-destructive opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100'
                          onClick={() => setDeleting(rule)}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </Button>
                        </div>
                      </div>
                      {previewId === rule.id && <RulePreviewPanel rule={rule} />}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className='max-h-[92vh] overflow-y-auto sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>New SLA rule</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <SlaRuleForm
              templates={templates}
              users={users}
              roleNames={roleNames}
              multiState
              onSave={(body) => createMut.mutate(body)}
              onCancel={() => setCreating(false)}
              saving={createMut.isPending}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className='max-h-[92vh] overflow-y-auto sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Edit SLA rule</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {editing && (
              <SlaRuleForm
                initial={toFormData(editing)}
                templates={templates}
                users={users}
                roleNames={roleNames}
                multiState={false}
                onSave={(body) => updateMut.mutate({ id: editing.id, body })}
                onCancel={() => setEditing(null)}
                saving={updateMut.isPending}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete SLA rule</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className='px-6 text-sm text-muted-foreground'>
              Delete <span className='font-medium text-foreground'>{deleting?.name}</span>? Records
              in this state stop being tracked. This cannot be undone.
            </p>
          </DialogBody>
          <DialogFooter className='px-6 pb-6'>
            <Button variant='outline' onClick={() => setDeleting(null)} disabled={deleteMut.isPending}>
              Cancel
            </Button>
            <Button
              variant='destructive'
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
