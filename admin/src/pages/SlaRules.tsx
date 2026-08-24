import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Clock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

interface WorkflowTemplate {
  id: string
  name: string
}

interface WorkflowStateOption {
  key: string
  label: string
}

interface CmsUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

interface SlaRule {
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
  is_active: boolean
  created_at: string
  updated_at: string
  template_name?: string
}

// What the form edits. state_keys is a multiselect: create fans out one
// POST per selected state; edit updates the rule with the single selection.
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
  escalation_ladder: Array<{ after_hours: number; notify: string }>
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
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name || u.email
}

function SlaRuleForm({
  initial,
  templates,
  users,
  multiState,
  onSave,
  onCancel,
  saving
}: {
  initial?: SlaRuleFormValues
  templates: WorkflowTemplate[]
  users: CmsUser[]
  /** create mode: pick many states, one rule per state; edit mode: single. */
  multiState: boolean
  onSave: (data: SlaRuleFormValues) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<SlaRuleFormValues>(initial ?? FORM_DEFAULTS)
  const [previewing, setPreviewing] = useState(false)
  const [whatIf, setWhatIf] = useState<{
    total: number
    proposed: { ok: number; warning: number; breached: number }
    flips: Array<{ collection: string; item: string; from: string; to: string }>
  } | null>(null)
  const [statesOpen, setStatesOpen] = useState(false)

  function set<K extends keyof SlaRuleFormValues>(key: K, value: SlaRuleFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // States of the selected template feed the state combobox.
  const { data: stateOptions = [] } = useQuery<WorkflowStateOption[]>({
    queryKey: ['pipeline-states-for-sla', form.workflow_template],
    enabled: !!form.workflow_template,
    queryFn: () =>
      api
        .get<{ data: { states: WorkflowStateOption[] } }>(`/pipelines/${form.workflow_template}`)
        .then((r) => r.data.data.states ?? [])
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

  return (
    <div className='space-y-4 px-6 pb-6'>
      <div className='space-y-1.5'>
        <Label htmlFor='sla-name'>Name</Label>
        <Input
          id='sla-name'
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder='e.g. Review SLA'
        />
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='sla-template'>Workflow Template</Label>
        <Select
          value={form.workflow_template}
          onValueChange={(v) =>
            setForm((prev) => ({ ...prev, workflow_template: v, state_keys: [] }))
          }
        >
          <SelectTrigger id='sla-template'>
            <SelectValue placeholder='Select workflow…' />
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
        <Label htmlFor='sla-state-key'>{multiState ? 'States' : 'State'}</Label>
        <Popover open={statesOpen} onOpenChange={setStatesOpen}>
          <PopoverTrigger asChild>
            <button
              id='sla-state-key'
              type='button'
              disabled={!form.workflow_template}
              className='flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-left text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50'
            >
              {form.state_keys.length === 0 ? (
                <span className='text-muted-foreground'>
                  {form.workflow_template ? 'Select state…' : 'Select a workflow template first'}
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
                      <code className='ml-auto text-[10px] text-muted-foreground'>{s.key}</code>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <p className='text-[11px] text-muted-foreground'>
          {multiState
            ? 'One SLA rule is created per selected state.'
            : 'The workflow state this SLA applies to.'}
        </p>
      </div>

      <div className='grid grid-cols-2 gap-4'>
        <div className='space-y-1.5'>
          <Label htmlFor='sla-duration'>Duration (hours)</Label>
          <Input
            id='sla-duration'
            type='number'
            min={1}
            value={form.duration_hours}
            onChange={(e) => set('duration_hours', Number(e.target.value))}
          />
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor='sla-warning-pct'>Warning at (%)</Label>
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

      <div className='space-y-1.5'>
        <Label htmlFor='sla-escalation'>Escalation User (optional)</Label>
        <Select
          value={form.escalation_user ?? '__none__'}
          onValueChange={(v) => set('escalation_user', v === '__none__' ? null : v)}
        >
          <SelectTrigger id='sla-escalation'>
            <SelectValue placeholder='None' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='__none__'>None</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {userLabel(u)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='space-y-2 rounded-lg border border-border p-4'>
        <div>
          <p className='text-sm font-medium'>Escalation ladder</p>
          <p className='text-[11px] text-muted-foreground'>
            After a breach: notify the owner immediately (the breach notice above), then climb
            these tiers until someone acknowledges on the record. Hours count PAST the breach.
          </p>
        </div>
        {form.escalation_ladder.map((tier, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
          <div key={idx} className='flex items-center gap-2'>
            <span className='text-[12px] text-muted-foreground'>after</span>
            <Input
              type='number'
              value={tier.after_hours}
              onChange={(e) =>
                set(
                  'escalation_ladder',
                  form.escalation_ladder.map((t, i) =>
                    i === idx ? { ...t, after_hours: Number(e.target.value) } : t
                  )
                )
              }
              className='h-8 w-[80px] text-[12px]'
            />
            <span className='text-[12px] text-muted-foreground'>h →</span>
            <Select
              value={tier.notify.startsWith('user:') ? tier.notify : tier.notify}
              onValueChange={(v) =>
                set(
                  'escalation_ladder',
                  form.escalation_ladder.map((t, i) => (i === idx ? { ...t, notify: v } : t))
                )
              }
            >
              <SelectTrigger className='h-8 flex-1 text-[12px]'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='owner'>Record owners (again)</SelectItem>
                <SelectItem value='manager'>Owners' managers</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={`user:${u.id}`}>
                    {userLabel(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type='button'
              onClick={() =>
                set(
                  'escalation_ladder',
                  form.escalation_ladder.filter((_, i) => i !== idx)
                )
              }
              className='text-[13px] text-slate-300 hover:text-red-500'
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
              { after_hours: (form.escalation_ladder.at(-1)?.after_hours ?? 0) + 4, notify: 'manager' }
            ])
          }
          className='text-[12px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground'
        >
          ＋ Add tier
        </button>
      </div>

      <div className='space-y-3 rounded-lg border border-border p-4'>
        <div className='flex items-center justify-between'>
          <div>
            <p className='text-sm font-medium'>Business Hours Only</p>
            <p className='text-[11px] text-muted-foreground'>Count only 9am–5pm Mon–Fri</p>
          </div>
          <Switch
            checked={form.business_hours_only}
            onCheckedChange={(v) => set('business_hours_only', v)}
          />
        </div>

        <div className='flex items-center justify-between'>
          <p className='text-sm font-medium'>Notify on Warning</p>
          <Switch
            checked={form.notify_on_warning}
            onCheckedChange={(v) => set('notify_on_warning', v)}
          />
        </div>

        <div className='flex items-center justify-between'>
          <p className='text-sm font-medium'>Notify on Breach</p>
          <Switch
            checked={form.notify_on_breach}
            onCheckedChange={(v) => set('notify_on_breach', v)}
          />
        </div>

        <div className='flex items-center justify-between'>
          <p className='text-sm font-medium'>Active</p>
          <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} />
        </div>
      </div>

      {/* SLA what-if simulator (#99) */}
      {whatIf && (
        <div className='rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] dark:border-border dark:bg-muted/40'>
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
      <DialogFooter>
        <Button
          variant='outline'
          disabled={!isValid || previewing}
          onClick={() => {
            setPreviewing(true)
            void api
              .post('/sla/what-if', {
                workflow_template: form.workflow_template,
                state_key: Array.isArray(form.state_keys) ? form.state_keys[0] : form.state_keys,
                duration_hours: form.duration_hours,
                warning_threshold_pct: form.warning_threshold_pct,
                business_hours_only: form.business_hours_only
              })
              .then((r) => setWhatIf(r.data.data))
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

export function SlaRulesPage() {
  const qc = useQueryClient()

  const { data: rules = [], isLoading } = useQuery<SlaRule[]>({
    queryKey: ['sla-rules'],
    queryFn: () => api.get<{ data: SlaRule[] }>('/sla/rules').then((r) => r.data.data)
  })

  const { data: templates = [] } = useQuery<WorkflowTemplate[]>({
    queryKey: ['workflow-templates-for-sla'],
    // Same template list the Workflows/Pipelines pages use — there is no
    // /pipelines/workflow-templates route (the old path 404'd silently and
    // left this dropdown empty).
    queryFn: () => api.get<{ data: WorkflowTemplate[] }>('/pipelines').then((r) => r.data.data)
  })

  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['users-list-for-sla'],
    queryFn: () => api.get<{ data: CmsUser[] }>('/users').then((r) => r.data.data)
  })

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SlaRule | null>(null)
  const [deleting, setDeleting] = useState<SlaRule | null>(null)

  const createMut = useMutation({
    // One rule per selected state; with several states the state label is
    // appended to the name so the resulting rows stay distinguishable.
    mutationFn: async (values: SlaRuleFormValues) => {
      const { state_keys, ...rest } = values
      const results = await Promise.allSettled(
        state_keys.map((state_key) =>
          api.post('/sla/rules', {
            ...rest,
            state_key,
            name:
              state_keys.length > 1
                ? `${rest.name} — ${titleCase(state_key.replace(/_/g, ' '))}`
                : rest.name
          })
        )
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      return { created: results.length - failed, failed }
    },
    onSuccess: ({ created, failed }) => {
      qc.invalidateQueries({ queryKey: ['sla-rules'] })
      setCreating(false)
      if (failed > 0) toast.warning(`${created} SLA rules created, ${failed} failed`)
      else toast.success(created > 1 ? `${created} SLA rules created` : 'SLA rule created')
    },
    onError: () => toast.error('Failed to create SLA rule')
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: SlaRuleFormValues }) => {
      const { state_keys, ...rest } = body
      return api.patch(`/sla/rules/${id}`, { ...rest, state_key: state_keys[0] })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-rules'] })
      setEditing(null)
      toast.success('SLA rule updated')
    },
    onError: () => toast.error('Failed to update SLA rule')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/sla/rules/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-rules'] })
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
      escalation_ladder: Array.isArray(
        (rule as SlaRule & { escalation_ladder?: unknown }).escalation_ladder
      )
        ? ((rule as SlaRule & { escalation_ladder?: Array<{ after_hours: number; notify: string }> })
            .escalation_ladder as Array<{ after_hours: number; notify: string }>)
        : [],
      is_active: rule.is_active
    }
  }

  return (
    <div className='flex flex-col h-full'>
      <div className='border-b border-border px-6 py-4 flex items-center justify-between shrink-0'>
        <div className='flex items-center gap-2.5'>
          <Clock className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>SLA Rules</h1>
        </div>
        <Button size='sm' onClick={() => setCreating(true)}>
          <Plus className='h-4 w-4 mr-1.5' />
          New SLA Rule
        </Button>
      </div>

      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-12 rounded-lg bg-muted animate-pulse' />
            ))}
          </div>
        ) : rules.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <Clock className='h-10 w-10 text-muted-foreground mb-3' />
            <p className='text-sm font-medium mb-1'>No SLA rules defined</p>
            <p className='text-xs text-muted-foreground mb-4'>
              Create rules to monitor time compliance for workflow states.
            </p>
            <Button size='sm' onClick={() => setCreating(true)}>
              <Plus className='h-4 w-4 mr-1.5' />
              New SLA Rule
            </Button>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Workflow Template</TableHead>
                  <TableHead>State Key</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Warning at</TableHead>
                  <TableHead>Business Hours</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className='w-20' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className='font-medium'>{rule.name}</TableCell>
                    <TableCell className='text-muted-foreground text-sm'>
                      {rule.template_name ?? rule.workflow_template}
                    </TableCell>
                    <TableCell>
                      <code className='text-xs bg-muted px-1.5 py-0.5 rounded'>
                        {rule.state_key}
                      </code>
                    </TableCell>
                    <TableCell className='text-sm'>{rule.duration_hours}h</TableCell>
                    <TableCell className='text-sm'>{rule.warning_threshold_pct}%</TableCell>
                    <TableCell>
                      {rule.business_hours_only ? (
                        <Badge
                          variant='outline'
                          className='text-[11px] bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20'
                        >
                          Business hrs
                        </Badge>
                      ) : (
                        <span className='text-xs text-muted-foreground'>Calendar</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {rule.is_active ? (
                        <Badge
                          variant='outline'
                          className='text-[11px] bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20'
                        >
                          Active
                        </Badge>
                      ) : (
                        <Badge variant='outline' className='text-[11px] text-muted-foreground'>
                          Inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1 justify-end'>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7'
                          onClick={() => setEditing(rule)}
                        >
                          <Pencil className='h-3.5 w-3.5' />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7 text-destructive hover:text-destructive'
                          onClick={() => setDeleting(rule)}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className='max-w-lg max-h-[90vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>New SLA Rule</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <SlaRuleForm
              templates={templates}
              users={users}
              multiState
              onSave={(body) => createMut.mutate(body)}
              onCancel={() => setCreating(false)}
              saving={createMut.isPending}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null)
        }}
      >
        <DialogContent className='max-w-lg max-h-[90vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>Edit SLA Rule</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {editing && (
              <SlaRuleForm
                initial={toFormData(editing)}
                templates={templates}
                users={users}
                multiState={false}
                onSave={(body) => updateMut.mutate({ id: editing.id, body })}
                onCancel={() => setEditing(null)}
                saving={updateMut.isPending}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete SLA Rule</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className='text-sm text-muted-foreground'>
              Are you sure you want to delete{' '}
              <span className='font-medium text-foreground'>{deleting?.name}</span>? This cannot be
              undone.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDeleting(null)}
              disabled={deleteMut.isPending}
            >
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
