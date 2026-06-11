import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

interface WorkflowTemplate {
  id: string
  name: string
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

interface SlaRuleFormData {
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
}

const FORM_DEFAULTS: SlaRuleFormData = {
  workflow_template: '',
  state_key: '',
  name: '',
  duration_hours: 24,
  warning_threshold_pct: 80,
  business_hours_only: false,
  notify_on_warning: true,
  notify_on_breach: true,
  escalation_user: null,
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
  onSave,
  onCancel,
  saving
}: {
  initial?: SlaRuleFormData
  templates: WorkflowTemplate[]
  users: CmsUser[]
  onSave: (data: SlaRuleFormData) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<SlaRuleFormData>(initial ?? FORM_DEFAULTS)

  function set<K extends keyof SlaRuleFormData>(key: K, value: SlaRuleFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const isValid =
    form.workflow_template.trim() !== '' &&
    form.state_key.trim() !== '' &&
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
        <Select value={form.workflow_template} onValueChange={(v) => set('workflow_template', v)}>
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
        <Label htmlFor='sla-state-key'>State Key</Label>
        <Input
          id='sla-state-key'
          value={form.state_key}
          onChange={(e) => set('state_key', e.target.value)}
          placeholder='e.g. in_review'
        />
        <p className='text-[11px] text-muted-foreground'>
          The workflow state key this SLA applies to.
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

      <DialogFooter>
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
    queryFn: () =>
      api
        .get<{ data: WorkflowTemplate[] }>('/pipelines/workflow-templates')
        .then((r) => r.data.data)
  })

  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['users-list-for-sla'],
    queryFn: () => api.get<{ data: CmsUser[] }>('/users').then((r) => r.data.data)
  })

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SlaRule | null>(null)
  const [deleting, setDeleting] = useState<SlaRule | null>(null)

  const createMut = useMutation({
    mutationFn: (body: SlaRuleFormData) => api.post('/sla/rules', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-rules'] })
      setCreating(false)
      toast.success('SLA rule created')
    },
    onError: () => toast.error('Failed to create SLA rule')
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: SlaRuleFormData }) =>
      api.patch(`/sla/rules/${id}`, body),
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

  function toFormData(rule: SlaRule): SlaRuleFormData {
    return {
      workflow_template: rule.workflow_template,
      state_key: rule.state_key,
      name: rule.name,
      duration_hours: rule.duration_hours,
      warning_threshold_pct: rule.warning_threshold_pct,
      business_hours_only: rule.business_hours_only,
      notify_on_warning: rule.notify_on_warning,
      notify_on_breach: rule.notify_on_breach,
      escalation_user: rule.escalation_user,
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
