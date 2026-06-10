import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertOctagon,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Plus,
  X
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Issue {
  id: number
  collection: string | null
  item: string | null
  title: string
  severity: string
  status: string
  assigned_to: string | null
  assigned_to_name?: string | null
  assigned_to_email?: string | null
  raised_by: string
  raised_by_name?: string | null
  raised_by_email?: string | null
  resolution_notes: string | null
  created_at: string
  updated_at: string
}

interface CmsUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

const SEVERITIES = ['low', 'medium', 'high', 'critical']
const STATUSES = ['open', 'in_progress', 'resolved', 'closed']

const SEVERITY_BADGE: Record<string, string> = {
  low: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  medium: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
  high: 'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20',
  critical: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20'
}

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan border-nvr-cyan/20',
  in_progress: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20',
  resolved: 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20',
  closed: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20'
}

function statusLabel(status: string): string {
  return status.replace('_', ' ')
}

function userLabel(u: CmsUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name || u.email
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize',
        SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.medium
      )}
    >
      {severity}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize',
        STATUS_BADGE[status] ?? STATUS_BADGE.open
      )}
    >
      {statusLabel(status)}
    </span>
  )
}

// ─── Combobox (shadcn Popover + Command) ─────────────────────────────────────

function MonCombobox({
  value,
  onChange,
  options,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn('h-8 justify-between px-2 text-[12px] font-normal', className)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[220px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Create panel ────────────────────────────────────────────────────────────

function CreateIssuePanel({
  users,
  collections,
  onCreated,
  onCancel
}: {
  users: CmsUser[]
  collections: { collection: string }[]
  onCreated: () => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [collection, setCollection] = useState('')
  const [item, setItem] = useState('')
  const [assignedTo, setAssignedTo] = useState('')

  const createMut = useMutation({
    mutationFn: () =>
      api.post('/issues', {
        title,
        severity,
        collection: collection || null,
        item: item || null,
        assigned_to: assignedTo || null
      }),
    onSuccess: () => {
      toast.success('Issue created')
      onCreated()
    },
    onError: () => toast.error('Failed to create issue')
  })

  return (
    <div className='border-b border-slate-200 bg-slate-50 px-6 py-4 dark:border-border dark:bg-muted/30'>
      <div className='grid gap-3 lg:grid-cols-2'>
        <div className='space-y-1 lg:col-span-2'>
          <Label className='text-[11px] text-slate-500'>Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='Describe the issue…'
            className='h-8 text-[12px]'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Severity</Label>
          <MonCombobox
            value={severity}
            onChange={(v) => v && setSeverity(v)}
            options={SEVERITIES.map((s) => ({ value: s, label: s }))}
            className='w-full capitalize'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Assignee (optional)</Label>
          <MonCombobox
            value={assignedTo}
            onChange={setAssignedTo}
            options={users.map((u) => ({ value: u.id, label: userLabel(u) }))}
            placeholder='Unassigned'
            className='w-full'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Collection (optional)</Label>
          <MonCombobox
            value={collection}
            onChange={setCollection}
            options={collections.map((c) => ({ value: c.collection, label: c.collection }))}
            placeholder='None'
            className='w-full font-mono'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Item ID (optional)</Label>
          <Input
            value={item}
            onChange={(e) => setItem(e.target.value)}
            placeholder='Record ID'
            className='h-8 font-mono text-[12px]'
          />
        </div>
      </div>
      <div className='mt-3 flex justify-end gap-2'>
        <Button variant='outline' size='sm' className='h-7 text-[11px]' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size='sm'
          className='h-7 text-[11px]'
          disabled={createMut.isPending || !title.trim()}
          onClick={() => createMut.mutate()}
        >
          {createMut.isPending ? 'Creating…' : 'Create issue'}
        </Button>
      </div>
    </div>
  )
}

// ─── Row detail ──────────────────────────────────────────────────────────────

function IssueDetail({ issue, users }: { issue: Issue; users: CmsUser[] }) {
  const qc = useQueryClient()
  const [notes, setNotes] = useState(issue.resolution_notes ?? '')
  const [assignee, setAssignee] = useState(issue.assigned_to ?? '')

  const patchMut = useMutation({
    mutationFn: (body: object) => api.patch(`/issues/${issue.id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issues'] })
      qc.invalidateQueries({ queryKey: ['issues-summary'] })
      toast.success('Issue updated')
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Failed to update issue')
  })

  return (
    <div className='space-y-4 bg-slate-50 px-6 py-4 dark:bg-muted/30'>
      <div className='flex flex-wrap items-center gap-4 text-[12px]'>
        <span className='text-muted-foreground'>
          Raised by{' '}
          <span className='font-medium text-foreground'>
            {issue.raised_by_name || issue.raised_by_email || issue.raised_by}
          </span>{' '}
          {formatRelative(issue.created_at)}
        </span>
        {issue.collection && (
          <span className='text-muted-foreground'>
            Record:{' '}
            {issue.item ? (
              <Link
                to={`/collections/${issue.collection}/${issue.item}`}
                className='font-mono text-nvr-navy hover:underline dark:text-nvr-cyan'
              >
                {issue.collection}/{issue.item}
              </Link>
            ) : (
              <span className='font-mono'>{issue.collection}</span>
            )}
          </span>
        )}
      </div>

      {/* Status transitions */}
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-[11px] uppercase tracking-wide text-muted-foreground'>
          Transition:
        </span>
        {STATUSES.filter((s) => s !== issue.status).map((s) => (
          <Button
            key={s}
            variant='outline'
            size='sm'
            className='h-7 text-[11px] capitalize'
            disabled={patchMut.isPending}
            onClick={() => patchMut.mutate({ status: s })}
          >
            {statusLabel(s)}
          </Button>
        ))}
      </div>

      {/* Assignee */}
      <div className='flex items-end gap-2'>
        <div className='w-64 space-y-1'>
          <Label className='text-[11px] text-slate-500'>Assignee</Label>
          <MonCombobox
            value={assignee}
            onChange={setAssignee}
            options={users.map((u) => ({ value: u.id, label: userLabel(u) }))}
            placeholder='Unassigned'
            className='w-full'
          />
        </div>
        <Button
          variant='outline'
          size='sm'
          className='h-8 text-[11px]'
          disabled={patchMut.isPending || (assignee || null) === issue.assigned_to}
          onClick={() => patchMut.mutate({ assigned_to: assignee || null })}
        >
          Save assignee
        </Button>
      </div>

      {/* Resolution notes */}
      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Resolution notes</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder='How was this resolved?'
          className='min-h-[72px] text-[12px]'
        />
        <div className='flex justify-end'>
          <Button
            variant='outline'
            size='sm'
            className='h-7 text-[11px]'
            disabled={patchMut.isPending || notes === (issue.resolution_notes ?? '')}
            onClick={() => patchMut.mutate({ resolution_notes: notes || null })}
          >
            Save notes
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Table rows ──────────────────────────────────────────────────────────────

function IssueRows({
  issue,
  users,
  isOpen,
  onToggle
}: {
  issue: Issue
  users: CmsUser[]
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className='cursor-pointer border-b border-slate-100 text-[12px] hover:bg-slate-50 dark:border-border/50 dark:hover:bg-muted/40'
        onClick={onToggle}
      >
        <td className='px-3 py-2.5 text-center'>
          {isOpen ? (
            <ChevronDown className='inline h-3.5 w-3.5 text-muted-foreground' />
          ) : (
            <ChevronRight className='inline h-3.5 w-3.5 text-muted-foreground' />
          )}
        </td>
        <td className='max-w-0 truncate px-2 py-2.5 font-medium'>{issue.title}</td>
        <td className='px-2 py-2.5'>
          <SeverityBadge severity={issue.severity} />
        </td>
        <td className='px-2 py-2.5'>
          <StatusBadge status={issue.status} />
        </td>
        <td className='truncate px-2 py-2.5 text-muted-foreground'>
          {issue.assigned_to_name || issue.assigned_to_email || '—'}
        </td>
        <td className='truncate px-2 py-2.5 font-mono text-[11px] text-muted-foreground'>
          {issue.collection ?? '—'}
        </td>
        <td className='px-4 py-2.5 text-right text-muted-foreground'>
          {formatRelative(issue.updated_at)}
        </td>
      </tr>
      {isOpen && (
        <tr className='border-b border-slate-100 dark:border-border/50'>
          <td colSpan={7} className='p-0'>
            <IssueDetail issue={issue} users={users} />
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function IssuesPage() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const params = new URLSearchParams()
  if (statusFilter) params.set('status', statusFilter)
  if (severityFilter) params.set('severity', severityFilter)
  if (collectionFilter) params.set('collection', collectionFilter)
  const qs = params.toString()

  const { data: issues = [], isLoading } = useQuery<Issue[]>({
    queryKey: ['issues', qs],
    queryFn: () =>
      api.get<{ data: Issue[] }>(`/issues${qs ? `?${qs}` : ''}`).then((r) => r.data.data)
  })

  const { data: summary } = useQuery<{
    by_status: Record<string, number>
    by_severity: Record<string, number>
  }>({
    queryKey: ['issues-summary'],
    queryFn: () =>
      api
        .get<{ data: { by_status: Record<string, number>; by_severity: Record<string, number> } }>(
          '/issues/summary'
        )
        .then((r) => r.data.data)
  })

  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['users-list-for-issues'],
    queryFn: () => api.get<{ data: CmsUser[] }>('/users').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: collections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <AlertOctagon className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Issue Log</h1>
          {summary && (
            <span className='ml-2 text-[11px] text-muted-foreground'>
              {summary.by_status.open ?? 0} open · {summary.by_status.in_progress ?? 0} in progress
              · {summary.by_status.resolved ?? 0} resolved
            </span>
          )}
        </div>
        <Button size='sm' onClick={() => setCreating((v) => !v)}>
          {creating ? <X className='mr-1.5 h-4 w-4' /> : <Plus className='mr-1.5 h-4 w-4' />}
          {creating ? 'Close' : 'New Issue'}
        </Button>
      </header>

      {creating && (
        <CreateIssuePanel
          users={users}
          collections={collections.filter((c) => !c.collection.startsWith('nivaro_'))}
          onCreated={() => {
            setCreating(false)
            qc.invalidateQueries({ queryKey: ['issues'] })
            qc.invalidateQueries({ queryKey: ['issues-summary'] })
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {/* Filter bar */}
      <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 px-6 py-2.5 dark:border-border'>
        <MonCombobox
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
          placeholder='All statuses'
          className='w-36 capitalize'
        />
        <MonCombobox
          value={severityFilter}
          onChange={setSeverityFilter}
          options={SEVERITIES.map((s) => ({ value: s, label: s }))}
          placeholder='All severities'
          className='w-36 capitalize'
        />
        <MonCombobox
          value={collectionFilter}
          onChange={setCollectionFilter}
          options={collections.map((c) => ({ value: c.collection, label: c.collection }))}
          placeholder='All collections'
          className='w-44 font-mono'
        />
        {(statusFilter || severityFilter || collectionFilter) && (
          <Button
            variant='ghost'
            size='sm'
            className='h-8 text-[11px]'
            onClick={() => {
              setStatusFilter('')
              setSeverityFilter('')
              setCollectionFilter('')
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className='flex-1 overflow-y-auto'>
        {isLoading ? (
          <div className='space-y-2 p-6'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-10 animate-pulse rounded-lg bg-muted' />
            ))}
          </div>
        ) : issues.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <AlertOctagon className='mb-3 h-10 w-10 text-muted-foreground/40' />
            <p className='mb-1 text-sm font-medium'>No issues found</p>
            <p className='text-xs text-muted-foreground'>
              Raise an issue to track data or process problems.
            </p>
          </div>
        ) : (
          <table className='w-full'>
            <thead className='sticky top-0 bg-white dark:bg-card'>
              <tr className='border-b border-slate-200 text-left text-[11px] text-muted-foreground dark:border-border'>
                <th className='w-10 px-3 py-2' />
                <th className='px-2 py-2 font-medium'>Title</th>
                <th className='w-24 px-2 py-2 font-medium'>Severity</th>
                <th className='w-28 px-2 py-2 font-medium'>Status</th>
                <th className='w-40 px-2 py-2 font-medium'>Assignee</th>
                <th className='w-36 px-2 py-2 font-medium'>Collection</th>
                <th className='w-28 px-4 py-2 text-right font-medium'>Updated</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => {
                const isOpen = expandedId === issue.id
                return (
                  <IssueRows
                    key={issue.id}
                    issue={issue}
                    users={users}
                    isOpen={isOpen}
                    onToggle={() => setExpandedId(isOpen ? null : issue.id)}
                  />
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
