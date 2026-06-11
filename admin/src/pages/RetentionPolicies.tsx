import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  Trash2
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RetentionPolicy {
  id: number
  name: string
  inactivity_threshold_months: number
  action: 'redact' | 'delete' | 'suspend_only'
  redact_fields: string[]
  redact_value_template: string
  exclusion_emails: string[]
  exclusion_roles: string[]
  cron_schedule: string | null
  is_active: boolean
  dry_run_mode: boolean
  last_run_at: string | null
  last_run_affected_count: number | null
}

interface RetentionRun {
  id: number
  policy_id: number
  started_at: string
  finished_at: string | null
  affected_count: number
  dry_run: boolean
  errors: string[]
}

const DEFAULT_FIELDS = ['first_name', 'last_name', 'email', 'external_id', 'job_title', 'avatar']

const ACTION_LABELS: Record<string, string> = {
  redact: 'Redact PII',
  delete: 'Delete user',
  suspend_only: 'Suspend only'
}

// ─── Empty form ───────────────────────────────────────────────────────────────

const emptyPolicy = (): Partial<RetentionPolicy> => ({
  name: '',
  inactivity_threshold_months: 36,
  action: 'redact',
  redact_fields: [...DEFAULT_FIELDS],
  redact_value_template: 'Redacted_{{id}}',
  exclusion_emails: [],
  exclusion_roles: [],
  cron_schedule: null,
  is_active: true,
  dry_run_mode: false
})

// ─── Policy form ──────────────────────────────────────────────────────────────

function PolicyForm({
  initial,
  onSave,
  onCancel,
  saving
}: {
  initial?: Partial<RetentionPolicy>
  onSave: (data: Partial<RetentionPolicy>) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<Partial<RetentionPolicy>>(initial ?? emptyPolicy())
  const [exclusionEmailInput, setExclusionEmailInput] = useState('')

  function set<K extends keyof RetentionPolicy>(k: K, v: RetentionPolicy[K]) {
    setForm((p) => ({ ...p, [k]: v }))
  }

  const redactFields = form.redact_fields ?? DEFAULT_FIELDS

  function toggleField(f: string) {
    set(
      'redact_fields',
      redactFields.includes(f) ? redactFields.filter((x) => x !== f) : [...redactFields, f]
    )
  }

  function addExclusionEmail() {
    const email = exclusionEmailInput.trim()
    if (!email) return
    const current = form.exclusion_emails ?? []
    if (!current.includes(email)) set('exclusion_emails', [...current, email])
    setExclusionEmailInput('')
  }

  function removeExclusionEmail(email: string) {
    set(
      'exclusion_emails',
      (form.exclusion_emails ?? []).filter((e) => e !== email)
    )
  }

  return (
    <div className='space-y-5 rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
      {/* Name */}
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>
          Policy name <span className='text-destructive'>*</span>
        </Label>
        <Input
          value={form.name ?? ''}
          onChange={(e) => set('name', e.target.value)}
          placeholder='e.g. 3-year inactivity redaction'
          className='h-8 text-[13px]'
        />
      </div>

      {/* Threshold */}
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Inactivity threshold (months)</Label>
        <Input
          type='number'
          min={1}
          value={form.inactivity_threshold_months ?? 36}
          onChange={(e) => set('inactivity_threshold_months', Number(e.target.value))}
          className='h-8 w-32 text-[13px]'
        />
        <p className='text-[11px] text-slate-400'>
          Users with no activity for this many months will be processed.
        </p>
      </div>

      {/* Action */}
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Action</Label>
        <div className='flex gap-2'>
          {(['redact', 'delete', 'suspend_only'] as const).map((a) => (
            <button
              key={a}
              type='button'
              onClick={() => set('action', a)}
              className={`rounded-md border px-3 py-1.5 text-[12px] transition-colors ${
                form.action === a
                  ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-400'
              }`}
            >
              {ACTION_LABELS[a]}
            </button>
          ))}
        </div>
        {form.action === 'delete' && (
          <p className='flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400'>
            <AlertTriangle className='h-3 w-3' />
            Permanently deletes the user record. Cannot be undone.
          </p>
        )}
      </div>

      {/* Redact fields (only relevant for redact action) */}
      {form.action === 'redact' && (
        <div className='space-y-2'>
          <Label className='text-[12px]'>Fields to redact</Label>
          <div className='flex flex-wrap gap-1.5'>
            {DEFAULT_FIELDS.map((f) => (
              <button
                key={f}
                type='button'
                onClick={() => toggleField(f)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  redactFields.includes(f)
                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                    : 'border-slate-200 text-slate-400 hover:border-slate-300 dark:border-border'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Redaction template</Label>
            <Input
              value={form.redact_value_template ?? 'Redacted_{{id}}'}
              onChange={(e) => set('redact_value_template', e.target.value)}
              placeholder='Redacted_{{id}}'
              className='h-8 w-64 font-mono text-[12px]'
            />
            <p className='text-[11px] text-slate-400'>
              Use <code className='font-mono'>{'{{id}}'}</code> for email and external_id fields.
              Other fields become "Redacted".
            </p>
          </div>
        </div>
      )}

      {/* Exclusion emails */}
      <div className='space-y-2'>
        <Label className='text-[12px]'>Protected email addresses</Label>
        <div className='flex gap-2'>
          <Input
            value={exclusionEmailInput}
            onChange={(e) => setExclusionEmailInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addExclusionEmail()
              }
            }}
            placeholder='service-account@example.com'
            className='h-8 flex-1 text-[12px]'
          />
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={addExclusionEmail}
            className='h-8'
          >
            Add
          </Button>
        </div>
        {(form.exclusion_emails ?? []).length > 0 && (
          <div className='flex flex-wrap gap-1.5'>
            {(form.exclusion_emails ?? []).map((email) => (
              <span
                key={email}
                className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] dark:border-border dark:bg-muted'
              >
                {email}
                <button
                  type='button'
                  onClick={() => removeExclusionEmail(email)}
                  className='text-slate-400 hover:text-red-500'
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Cron schedule */}
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Cron schedule (optional)</Label>
        <Input
          value={form.cron_schedule ?? ''}
          onChange={(e) => set('cron_schedule', e.target.value || null)}
          placeholder='0 2 1 * *  (1st of month at 2am)'
          className='h-8 w-64 font-mono text-[12px]'
        />
        <p className='text-[11px] text-slate-400'>Leave blank for manual execution only.</p>
      </div>

      {/* Flags */}
      <div className='flex flex-wrap items-center gap-6'>
        <div className='flex items-center gap-2'>
          <Switch
            id='policy-active'
            checked={form.is_active ?? true}
            onCheckedChange={(v) => set('is_active', v)}
          />
          <Label htmlFor='policy-active' className='cursor-pointer text-[12px]'>
            Active
          </Label>
        </div>
        <div className='flex items-center gap-2'>
          <Switch
            id='policy-dryrun'
            checked={form.dry_run_mode ?? false}
            onCheckedChange={(v) => set('dry_run_mode', v)}
          />
          <Label htmlFor='policy-dryrun' className='cursor-pointer text-[12px]'>
            Dry-run mode
          </Label>
          <span className='text-[11px] text-slate-400'>(preview only, no changes written)</span>
        </div>
      </div>

      <div className='flex items-center justify-end gap-2 border-t border-slate-100 pt-4 dark:border-border'>
        <Button type='button' variant='outline' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          disabled={saving || !form.name?.trim()}
          onClick={() => onSave(form)}
        >
          {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save policy'}
        </Button>
      </div>
    </div>
  )
}

// ─── Run result modal ─────────────────────────────────────────────────────────

function RunResult({
  result,
  onClose
}: {
  result: { affected_count: number; affected_ids: string[]; dry_run: boolean; errors: string[] }
  onClose: () => void
}) {
  return (
    <div className='space-y-3 rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2'>
        {result.dry_run ? (
          <AlertTriangle className='h-4 w-4 text-amber-500' />
        ) : (
          <CheckCircle2 className='h-4 w-4 text-green-500' />
        )}
        <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          {result.dry_run ? 'Dry run complete' : 'Policy executed'}
        </p>
      </div>
      <p className='text-[13px] text-slate-600 dark:text-slate-300'>
        <span className='font-semibold text-slate-900 dark:text-slate-100'>
          {result.affected_count}
        </span>{' '}
        user{result.affected_count !== 1 ? 's' : ''}{' '}
        {result.dry_run ? 'would be affected' : 'processed'}.
      </p>
      {result.affected_ids.length > 0 && (
        <div>
          <p className='mb-1 text-[11px] font-medium text-slate-500'>Sample IDs:</p>
          <div className='flex flex-wrap gap-1'>
            {result.affected_ids.slice(0, 10).map((id) => (
              <code
                key={id}
                className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-muted'
              >
                {id}
              </code>
            ))}
            {result.affected_ids.length > 10 && (
              <span className='text-[11px] text-slate-400'>
                +{result.affected_ids.length - 10} more
              </span>
            )}
          </div>
        </div>
      )}
      {result.errors.length > 0 && (
        <div>
          <p className='mb-1 text-[11px] font-medium text-red-600'>Errors:</p>
          {result.errors.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: error list
            <p key={i} className='text-[11px] text-red-500'>
              {e}
            </p>
          ))}
        </div>
      )}
      <div className='flex justify-end'>
        <Button type='button' size='sm' variant='outline' onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function RetentionPoliciesPage() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [runResult, setRunResult] = useState<Record<string, unknown> | null>(null)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const { data: policies = [], isLoading } = useQuery<RetentionPolicy[]>({
    queryKey: ['retention-policies'],
    queryFn: () => api.get<{ data: RetentionPolicy[] }>('/retention').then((r) => r.data.data)
  })

  const { data: runs = [] } = useQuery<RetentionRun[]>({
    queryKey: ['retention-runs', selectedId],
    queryFn: () =>
      api.get<{ data: RetentionRun[] }>(`/retention/${selectedId}/runs`).then((r) => r.data.data),
    enabled: !!selectedId
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['retention-policies'] })

  const createMut = useMutation({
    mutationFn: (body: Partial<RetentionPolicy>) =>
      api.post('/retention', body).then((r) => r.data.data),
    onSuccess: () => {
      invalidate()
      setCreating(false)
      toast.success('Policy created')
    },
    onError: () => toast.error('Failed to create policy')
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<RetentionPolicy> }) =>
      api.patch(`/retention/${id}`, body).then((r) => r.data.data),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      toast.success('Policy updated')
    },
    onError: () => toast.error('Failed to update policy')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/retention/${id}`),
    onSuccess: () => {
      invalidate()
      if (selectedId === deleteMut.variables) setSelectedId(null)
      toast.success('Policy deleted')
    },
    onError: () => toast.error('Failed to delete policy')
  })

  async function runPolicy(id: number, dryRun: boolean) {
    setRunningId(id)
    try {
      const res = await api.post<{ data: Record<string, unknown> }>(
        `/retention/${id}/run${dryRun ? '?dry_run=true' : ''}`
      )
      setRunResult(res.data.data)
      invalidate()
      qc.invalidateQueries({ queryKey: ['retention-runs', id] })
    } catch {
      toast.error('Run failed')
    } finally {
      setRunningId(null)
    }
  }

  const selected = policies.find((p) => p.id === selectedId) ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5 dark:border-white/[0.07] dark:bg-[#0d1117]'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100'>
              Privacy & Retention
            </h1>
            <p className='mt-0.5 text-[12px] text-slate-400'>
              Configure policies to redact or delete inactive users to comply with data retention
              requirements.
            </p>
          </div>
          <Button
            size='sm'
            onClick={() => {
              setCreating(true)
              setEditingId(null)
            }}
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' />
            New policy
          </Button>
        </div>
      </div>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left — policy list */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 dark:border-white/[0.07]'>
          {isLoading ? (
            <div className='flex items-center justify-center py-12'>
              <Loader2 className='h-4 w-4 animate-spin text-slate-400' />
            </div>
          ) : policies.length === 0 && !creating ? (
            <div className='px-6 py-10 text-center text-[12px] text-slate-400'>
              No policies yet. Create one to get started.
            </div>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
              {policies.map((p) => (
                <li key={p.id}>
                  <button
                    type='button'
                    onClick={() => {
                      setSelectedId(p.id)
                      setCreating(false)
                      setEditingId(null)
                    }}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.03] ${
                      selectedId === p.id ? 'bg-nvr-cyan/[0.06] dark:bg-nvr-cyan/[0.08]' : ''
                    }`}
                  >
                    <div className='min-w-0 flex-1'>
                      <p className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                        {p.name}
                      </p>
                      <p className='mt-0.5 text-[11px] text-slate-400'>
                        {p.inactivity_threshold_months}mo · {ACTION_LABELS[p.action]}
                      </p>
                    </div>
                    <div className='flex shrink-0 items-center gap-1.5'>
                      {p.dry_run_mode && (
                        <Badge variant='outline' className='h-4 px-1 text-[9px]'>
                          dry run
                        </Badge>
                      )}
                      <div
                        className={`h-1.5 w-1.5 rounded-full ${p.is_active ? 'bg-green-500' : 'bg-slate-300'}`}
                      />
                      <ChevronRight className='h-3.5 w-3.5 text-slate-300' />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Right — detail / form */}
        <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          {runResult && (
            <div className='mb-4'>
              <RunResult
                result={runResult as Parameters<typeof RunResult>[0]['result']}
                onClose={() => setRunResult(null)}
              />
            </div>
          )}

          {creating && (
            <PolicyForm
              onSave={(data) => createMut.mutate(data)}
              onCancel={() => setCreating(false)}
              saving={createMut.isPending}
            />
          )}

          {!creating &&
            selected &&
            (editingId === selected.id ? (
              <PolicyForm
                initial={selected}
                onSave={(data) => updateMut.mutate({ id: selected.id, body: data })}
                onCancel={() => setEditingId(null)}
                saving={updateMut.isPending}
              />
            ) : (
              <div className='space-y-4'>
                {/* Policy detail card */}
                <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <div className='flex items-center justify-between border-b border-slate-100 px-5 py-3.5 dark:border-border'>
                    <div>
                      <h2 className='text-[14px] font-semibold text-slate-800 dark:text-slate-100'>
                        {selected.name}
                      </h2>
                      <p className='text-[11px] text-slate-400'>
                        {selected.inactivity_threshold_months} months inactivity ·{' '}
                        {ACTION_LABELS[selected.action]}
                        {selected.cron_schedule && ` · ${selected.cron_schedule}`}
                      </p>
                    </div>
                    <div className='flex items-center gap-2'>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        className='h-7 text-[12px]'
                        disabled={runningId === selected.id}
                        onClick={() => runPolicy(selected.id, true)}
                      >
                        {runningId === selected.id ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        ) : (
                          <>
                            <AlertTriangle className='mr-1 h-3.5 w-3.5 text-amber-500' />
                            Dry run
                          </>
                        )}
                      </Button>
                      <Button
                        type='button'
                        size='sm'
                        disabled={runningId === selected.id || selected.dry_run_mode}
                        onClick={() => runPolicy(selected.id, false)}
                        className='h-7 text-[12px]'
                      >
                        {runningId === selected.id ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        ) : (
                          <>
                            <Play className='mr-1 h-3.5 w-3.5' />
                            Run now
                          </>
                        )}
                      </Button>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        className='h-7 text-[12px]'
                        onClick={() => setEditingId(selected.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        type='button'
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 text-slate-400 hover:text-red-500'
                        onClick={() => {
                          if (confirm('Delete this policy?')) deleteMut.mutate(selected.id)
                        }}
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </Button>
                    </div>
                  </div>

                  <div className='grid grid-cols-2 gap-px overflow-hidden rounded-b-lg border-t border-slate-100 bg-slate-100 dark:border-border dark:bg-border'>
                    {[
                      ['Threshold', `${selected.inactivity_threshold_months} months`],
                      ['Action', ACTION_LABELS[selected.action]],
                      ['Status', selected.is_active ? 'Active' : 'Inactive'],
                      ['Mode', selected.dry_run_mode ? 'Dry run (no writes)' : 'Live'],
                      ['Cron', selected.cron_schedule ?? 'Manual only'],
                      [
                        'Last run',
                        selected.last_run_at
                          ? `${formatRelative(selected.last_run_at)} (${selected.last_run_affected_count ?? 0} affected)`
                          : 'Never'
                      ]
                    ].map(([label, value]) => (
                      <div key={label} className='bg-white px-4 py-2.5 dark:bg-card'>
                        <p className='text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                          {label}
                        </p>
                        <p className='mt-0.5 text-[12px] text-slate-700 dark:text-slate-200'>
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Protected emails */}
                {selected.exclusion_emails.length > 0 && (
                  <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
                    <p className='mb-2 text-[11px] font-medium text-slate-500'>
                      Protected addresses
                    </p>
                    <div className='flex flex-wrap gap-1.5'>
                      {selected.exclusion_emails.map((e) => (
                        <code
                          key={e}
                          className='rounded bg-slate-100 px-1.5 py-0.5 text-[11px] dark:bg-muted'
                        >
                          {e}
                        </code>
                      ))}
                    </div>
                  </div>
                )}

                {/* Run history */}
                <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <div className='border-b border-slate-100 px-4 py-2.5 dark:border-border'>
                    <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
                      Run history
                    </p>
                  </div>
                  {runs.length === 0 ? (
                    <p className='px-4 py-4 text-[12px] text-slate-400'>No runs yet.</p>
                  ) : (
                    <table className='w-full text-[12px]'>
                      <thead>
                        <tr className='border-b border-slate-100 dark:border-border'>
                          <th className='px-4 py-2 text-left font-medium text-slate-500'>Date</th>
                          <th className='px-4 py-2 text-left font-medium text-slate-500'>
                            Affected
                          </th>
                          <th className='px-4 py-2 text-left font-medium text-slate-500'>Type</th>
                          <th className='px-4 py-2 text-left font-medium text-slate-500'>Errors</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr
                            key={r.id}
                            className='border-b border-slate-50 last:border-0 dark:border-white/[0.03]'
                          >
                            <td className='px-4 py-2 text-slate-600 dark:text-slate-300'>
                              {formatRelative(r.started_at)}
                            </td>
                            <td className='px-4 py-2 font-semibold text-slate-800 dark:text-slate-100'>
                              {r.affected_count}
                            </td>
                            <td className='px-4 py-2'>
                              {r.dry_run ? (
                                <Badge variant='outline' className='text-[10px]'>
                                  dry run
                                </Badge>
                              ) : (
                                <Badge className='bg-green-100 text-green-700 text-[10px]'>
                                  live
                                </Badge>
                              )}
                            </td>
                            <td className='px-4 py-2 text-red-500'>
                              {r.errors?.length > 0 ? r.errors.length : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            ))}

          {!creating && !selected && (
            <div className='flex flex-col items-center py-24 text-center'>
              <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>
                Select a policy or create one
              </p>
              <p className='mt-1 text-[12px] text-slate-400'>
                Retention policies identify inactive users and redact or remove their data.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
