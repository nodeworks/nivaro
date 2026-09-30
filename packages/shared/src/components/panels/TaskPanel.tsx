import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  ClipboardList,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Users,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { invalidateRecordTasks, OPEN_TASK_STATUSES } from '../../lib/record-tasks'
import { cn, formatDate, formatRelative } from '../../lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Textarea } from '../ui/textarea'

type Priority = 'low' | 'normal' | 'urgent'

interface DoneWhenRule {
  field: string
  op: string
  value?: string | number | null
}

interface Task {
  id: number
  kind?: string | null
  title: string
  description: string | null
  assignee: string | null
  assignee_name?: string | null
  team_id?: number | null
  team_name?: string | null
  due_date: string | null
  status: string
  priority?: Priority
  created_by: string | null
  created_by_name?: string | null
  completed_at: string | null
  completed_by?: string | null
  completed_by_name?: string | null
  done_when?: string | null
}

interface Person {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  is_out_of_office?: boolean | number
  ooo_end?: string | null
  delegate_id?: string | null
  reasons?: string[]
}

interface Team {
  id: number
  name: string
  member_count?: number
}

export interface PendingTask {
  title: string
  description?: string
  assignee: string | null
  /** Display name for the queued row (the picker already knows it). */
  assignee_name?: string | null
  team_id?: number | null
  team_name?: string | null
  due_date: string
  priority?: string
}

const PEOPLE_FIELDS = 'id,first_name,last_name,email,is_out_of_office,ooo_end,delegate_id'

function personName(u: Partial<Person> | undefined | null): string {
  if (!u) return 'Unknown'
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown'
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

function parseRules(raw: string | null | undefined): DoneWhenRule[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as DoneWhenRule[]) : []
  } catch {
    return []
  }
}

/** "Requisition ID is filled in" — the same wording the server writes when
 *  the task closes itself. */
function describeRules(rules: DoneWhenRule[], labels: Map<string, string>): string {
  return rules
    .map((r) => {
      const name = labels.get(r.field) ?? r.field.replace(/_/g, ' ')
      if (r.op === 'nnull') return `${name} is filled in`
      if (r.op === 'eq') return `${name} is ${String(r.value ?? '')}`
      if (r.op === 'null') return `${name} is empty`
      return `${name} ${r.op} ${String(r.value ?? '')}`.trim()
    })
    .join(' and ')
}

function PriorityPill({ priority }: { priority?: string }) {
  if (!priority || priority === 'normal') return null
  return (
    <span
      className={
        priority === 'urgent'
          ? 'rounded bg-red-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'
          : 'rounded bg-slate-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'
      }
    >
      {priority}
    </span>
  )
}

// ─── Assignee picker (#1005) ────────────────────────────────────────────────

/** Searches the whole directory on the server and leads with the people on
 *  this record (current owners, creator, contacts). */
function AssigneePicker({
  collection,
  item,
  value,
  valueLabel,
  onChange
}: {
  collection: string
  item: string
  value: string | null
  valueLabel?: string | null
  onChange: (id: string | null, person: Person | null) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  const onRecord = useQuery<Person[]>({
    queryKey: ['task-people', collection, item],
    queryFn: () =>
      client
        .request<{ data: Person[] }>(get('/tasks/people', { collection, item }))
        .then((r) => r.data)
        .catch(() => []),
    enabled: open && !!item && item !== 'new',
    staleTime: 60_000
  })
  const found = useQuery<Person[]>({
    queryKey: ['task-people-search', debounced],
    queryFn: () =>
      client
        .request<{ data: Person[] }>(
          get('/users', {
            limit: 25,
            people: 1,
            fields: PEOPLE_FIELDS,
            ...(debounced ? { search: debounced } : {})
          })
        )
        .then((r) => r.data)
        .catch(() => []),
    enabled: open,
    staleTime: 60_000
  })
  const recordPeople = onRecord.data ?? []
  const recordIds = new Set(recordPeople.map((p) => String(p.id).toUpperCase()))
  const q = debounced.toLowerCase()
  const shownRecord = recordPeople.filter(
    (p) => !q || `${personName(p)} ${p.email ?? ''}`.toLowerCase().includes(q)
  )
  const others = (found.data ?? []).filter((p) => !recordIds.has(String(p.id).toUpperCase()))
  const allIds = [...shownRecord, ...others].map((p) => p.id)
  // Picker load hints (#410): open-task counts per person.
  const { data: openCounts } = useQuery<Record<string, number>>({
    queryKey: ['task-open-counts', allIds.join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, number> }>(
          get('/tasks/open-counts', { ids: allIds.join(',') })
        )
        .then((r) => r.data)
        .catch(() => ({})),
    enabled: open && allIds.length > 0,
    staleTime: 60_000
  })

  const row = (p: Person, reasons?: string[]) => {
    const n = openCounts?.[String(p.id).toUpperCase()] ?? 0
    return (
      <CommandItem
        key={p.id}
        value={p.id}
        onSelect={() => {
          onChange(same(p.id, value) ? null : p.id, same(p.id, value) ? null : p)
          setOpen(false)
        }}
        className='text-[12px]'
        data-task-person={p.id}
      >
        <Check
          className={cn('mr-2 h-3.5 w-3.5', same(value, p.id) ? 'opacity-100' : 'opacity-0')}
        />
        <span className='min-w-0 flex-1 truncate'>
          {personName(p)}
          {reasons?.length ? (
            <span className='ml-1.5 text-[10.5px] text-muted-foreground'>{reasons.join(', ')}</span>
          ) : null}
        </span>
        {p.is_out_of_office ? (
          <span className='ml-2 shrink-0 text-[10px] text-amber-600 dark:text-amber-400'>out</span>
        ) : null}
        {n > 0 && (
          <span
            className='ml-2 shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'
            title={`${n} open task${n === 1 ? '' : 's'} already assigned`}
          >
            {n}
          </span>
        )}
      </CommandItem>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          data-task-assignee-picker
          className='h-8 w-full justify-between px-2.5 text-[12px] font-normal'
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value ? (valueLabel ?? 'Selected') : 'Assign to…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[300px] p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder='Search people…'
            className='h-8 text-[12px]'
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              {found.isFetching ? 'Searching…' : 'No one matches'}
            </CommandEmpty>
            {shownRecord.length > 0 && (
              <CommandGroup heading='On this record'>
                {shownRecord.map((p) => row(p, p.reasons))}
              </CommandGroup>
            )}
            {others.length > 0 && (
              <CommandGroup heading={debounced ? 'Everyone' : 'Everyone (type to search)'}>
                {others.map((p) => row(p))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TeamPicker({
  value,
  onChange
}: {
  value: number | null
  onChange: (id: number | null, team: Team | null) => void
}) {
  const client = useNivaroClient()
  const { data: teams = [] } = useQuery<Team[]>({
    queryKey: ['user-groups', 'task-picker'],
    queryFn: () =>
      client
        .request<{ data: Team[] }>(get('/user-groups'))
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 5 * 60_000
  })
  return (
    <SimpleSelect
      value={value == null ? '' : String(value)}
      onChange={(v) => {
        const t = teams.find((x) => String(x.id) === v) ?? null
        onChange(t ? t.id : null, t)
      }}
      ariaLabel='Team'
      options={[
        { value: '', label: teams.length ? 'Choose a team…' : 'No teams yet' },
        ...teams.map((t) => ({
          value: String(t.id),
          label: `${t.name}${t.member_count ? ` · ${t.member_count}` : ''}`
        }))
      ]}
    />
  )
}

// ─── "Done when" (#1016) ────────────────────────────────────────────────────

interface FieldMeta {
  field: string
  label?: string | null
  hidden?: boolean
  type?: string
}

function useFieldLabels(collection: string) {
  const client = useNivaroClient()
  const { data } = useQuery<FieldMeta[]>({
    queryKey: ['task-field-labels', collection],
    queryFn: () =>
      client
        .request<{ data: { fields?: FieldMeta[] } }>(get(`/collections/${collection}`))
        .then((r) => r.data.fields ?? [])
        .catch(() => []),
    staleTime: 10 * 60_000
  })
  const fields = (data ?? []).filter(
    (f) => !f.hidden && f.field !== 'id' && f.type !== 'alias' && !f.field.startsWith('__')
  )
  const labels = useMemo(
    () => new Map(fields.map((f) => [f.field, f.label || f.field.replace(/_/g, ' ')])),
    [fields]
  )
  return { fields, labels }
}

function DoneWhenEditor({
  collection,
  value,
  onChange
}: {
  collection: string
  value: DoneWhenRule[]
  onChange: (rules: DoneWhenRule[]) => void
}) {
  const { fields, labels } = useFieldLabels(collection)
  const [open, setOpen] = useState(false)
  const rule = value[0] ?? null
  return (
    <div className='space-y-1.5' data-task-done-when>
      <Label className='block text-[11px]'>Close automatically when (optional)</Label>
      <div className='flex flex-wrap items-center gap-1.5'>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant='outline'
              className='h-8 max-w-[220px] justify-between px-2.5 text-[12px] font-normal'
            >
              <span className={cn('truncate', !rule && 'text-muted-foreground')}>
                {rule ? (labels.get(rule.field) ?? rule.field) : 'A field on this record…'}
              </span>
              <ChevronsUpDown className='ml-1 h-3.5 w-3.5 shrink-0 opacity-50' />
            </Button>
          </PopoverTrigger>
          <PopoverContent className='w-[260px] p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  No field
                </CommandEmpty>
                <CommandGroup>
                  {fields.map((f) => (
                    <CommandItem
                      key={f.field}
                      value={`${labels.get(f.field)} ${f.field}`}
                      onSelect={() => {
                        onChange([
                          { field: f.field, op: rule?.op ?? 'nnull', value: rule?.value ?? null }
                        ])
                        setOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {labels.get(f.field)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {rule && (
          <>
            <div className='w-[130px]'>
              <SimpleSelect
                value={rule.op}
                onChange={(op) =>
                  onChange([{ ...rule, op, value: op === 'eq' ? (rule.value ?? '') : null }])
                }
                options={[
                  { value: 'nnull', label: 'is filled in' },
                  { value: 'eq', label: 'equals' }
                ]}
              />
            </div>
            {rule.op === 'eq' && (
              <Input
                value={String(rule.value ?? '')}
                onChange={(e) => onChange([{ ...rule, value: e.target.value }])}
                className='h-8 w-[140px] text-[12px]'
                placeholder='Value'
              />
            )}
            <button
              type='button'
              onClick={() => onChange([])}
              className='rounded p-1 text-slate-400 hover:text-slate-600'
              aria-label='Remove condition'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Create / edit form ─────────────────────────────────────────────────────

interface Draft {
  title: string
  description: string
  mode: 'person' | 'team'
  assignee: string | null
  assigneeName: string | null
  assigneePerson: Person | null
  teamId: number | null
  teamName: string | null
  due: string
  priority: Priority
  doneWhen: DoneWhenRule[]
}

const emptyDraft = (): Draft => ({
  title: '',
  description: '',
  mode: 'person',
  assignee: null,
  assigneeName: null,
  assigneePerson: null,
  teamId: null,
  teamName: null,
  due: '',
  priority: 'normal',
  doneWhen: []
})

function draftFrom(t: Task): Draft {
  return {
    title: t.title,
    description: t.description ?? '',
    mode: t.assignee || t.team_id == null ? 'person' : 'team',
    assignee: t.assignee,
    assigneeName: t.assignee_name ?? null,
    assigneePerson: null,
    teamId: t.team_id ?? null,
    teamName: t.team_name ?? null,
    due: t.due_date ? String(t.due_date).slice(0, 10) : '',
    priority: (t.priority ?? 'normal') as Priority,
    doneWhen: parseRules(t.done_when)
  }
}

function TaskForm({
  collection,
  item,
  initial,
  submitLabel,
  busy,
  allowTeam,
  onSubmit,
  onCancel
}: {
  collection: string
  item: string
  initial: Draft
  submitLabel: string
  busy?: boolean
  allowTeam: boolean
  onSubmit: (d: Draft) => void
  onCancel: () => void
}) {
  const [d, setD] = useState<Draft>(initial)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }))
  const who = d.mode === 'team' ? d.teamId != null : !!d.assignee
  const ooo = d.mode === 'person' && d.assigneePerson?.is_out_of_office ? d.assigneePerson : null
  return (
    <div
      className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-slate-900/30'
      data-task-form
    >
      <div>
        <Label className='mb-1 block text-[11px]'>Title</Label>
        <Input
          value={d.title}
          onChange={(e) => set('title', e.target.value)}
          className='h-8 bg-white text-[12px] dark:bg-background'
          placeholder='What needs to be done?'
          autoFocus
          data-task-title
        />
      </div>
      <div>
        <Label className='mb-1 block text-[11px]'>Details (optional)</Label>
        <Textarea
          value={d.description}
          onChange={(e) => set('description', e.target.value)}
          className='min-h-[56px] bg-white text-[12px] dark:bg-background'
          placeholder='Anything the person needs to know'
          rows={2}
          data-task-description
        />
      </div>
      <div className='grid grid-cols-2 gap-3'>
        <div className='col-span-2 sm:col-span-1'>
          <div className='mb-1 flex items-center justify-between'>
            <Label className='text-[11px]'>{d.mode === 'team' ? 'Team' : 'Assignee'}</Label>
            {allowTeam && (
              <button
                type='button'
                data-task-mode={d.mode === 'team' ? 'person' : 'team'}
                onClick={() => set('mode', d.mode === 'team' ? 'person' : 'team')}
                className='text-[10.5px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              >
                {d.mode === 'team' ? 'Assign to a person' : 'Assign to a team'}
              </button>
            )}
          </div>
          {d.mode === 'team' ? (
            <TeamPicker
              value={d.teamId}
              onChange={(id, t) => setD((p) => ({ ...p, teamId: id, teamName: t?.name ?? null }))}
            />
          ) : (
            <AssigneePicker
              collection={collection}
              item={item}
              value={d.assignee}
              valueLabel={d.assigneeName}
              onChange={(id, p) =>
                setD((x) => ({
                  ...x,
                  assignee: id,
                  assigneeName: p ? personName(p) : null,
                  assigneePerson: p
                }))
              }
            />
          )}
          {ooo && (
            <p className='mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700 dark:bg-amber-400/10 dark:text-amber-400'>
              {personName(ooo)} is out of office
              {ooo.ooo_end ? ` until ${String(ooo.ooo_end).slice(0, 10)}` : ''} — the task goes to
              their delegate if one is set.
            </p>
          )}
          {d.mode === 'team' && (
            <p className='mt-1 text-[11px] text-muted-foreground'>
              Waits with the team until one of them picks it up.
            </p>
          )}
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Due date</Label>
          <Input
            type='date'
            value={d.due}
            onChange={(e) => set('due', e.target.value)}
            className='h-8 bg-white text-[12px] dark:bg-background'
            data-task-due
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Priority</Label>
          <SimpleSelect
            value={d.priority}
            onChange={(v) => set('priority', v as Priority)}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'normal', label: 'Normal' },
              { value: 'urgent', label: 'Urgent' }
            ]}
          />
        </div>
      </div>
      <DoneWhenEditor
        collection={collection}
        value={d.doneWhen}
        onChange={(r) => set('doneWhen', r)}
      />
      <div className='flex justify-end gap-2'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='h-7 text-[12px]'
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          className='h-7 text-[12px]'
          disabled={!d.title.trim() || !who || busy}
          onClick={() => onSubmit(d)}
          data-task-submit
        >
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  )
}

// ─── History (#1002) ────────────────────────────────────────────────────────

function TaskHistory({ taskId }: { taskId: number }) {
  const client = useNivaroClient()
  const { data = [], isLoading } = useQuery<
    Array<{ id: number; text: string; at: string; user_name: string | null }>
  >({
    queryKey: ['task-history', taskId],
    queryFn: () =>
      client
        .request<{
          data: Array<{ id: number; text: string; at: string; user_name: string | null }>
        }>(get(`/tasks/${taskId}/history`))
        .then((r) => r.data),
    staleTime: 30_000
  })
  if (isLoading) return <p className='mt-1 text-[11px] text-muted-foreground'>Loading history…</p>
  if (!data.length) return <p className='mt-1 text-[11px] text-muted-foreground'>No history yet.</p>
  return (
    <ol
      className='mt-1.5 space-y-1 border-l border-slate-200 pl-3 dark:border-border'
      data-task-history
    >
      {data.map((h) => (
        <li key={h.id} className='text-[11px] text-slate-600 dark:text-slate-400'>
          <span className='text-slate-800 dark:text-slate-200'>{h.text}</span>
          <span className='text-slate-400'>
            {' '}
            · {h.user_name ? `${h.user_name}, ` : ''}
            <span title={new Date(h.at).toLocaleString()}>{formatRelative(h.at)}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export function TaskPanel({
  collection,
  item,
  title,
  defaultExpanded,
  queuedTasks,
  onQueueTask,
  onRemoveQueuedTask
}: {
  collection: string
  item: string
  title?: string
  defaultExpanded?: boolean
  queuedTasks?: PendingTask[]
  onQueueTask?: (task: PendingTask) => void
  onRemoveQueuedTask?: (index: number) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { isAdmin, userId } = useItemEditAuth()
  const [expanded, setExpanded] = useState(false)
  const syncedFromProp = useRef(false)
  useEffect(() => {
    if (!syncedFromProp.current && defaultExpanded !== undefined) {
      syncedFromProp.current = true
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [historyOf, setHistoryOf] = useState<number | null>(null)
  const [showCompleted, setShowCompleted] = useState(false)

  const isNew = !item || item === 'new'
  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks', collection, item],
    queryFn: () =>
      client.request<{ data: Task[] }>(get('/tasks', { collection, item })).then((r) => r.data),
    enabled: !!collection && !isNew
  })
  const { labels } = useFieldLabels(collection)

  const invalidate = () => {
    invalidateRecordTasks(qc, collection, item)
    qc.invalidateQueries({ queryKey: ['task-history'] })
  }
  const errText = (e: unknown, fallback: string) =>
    (e as { response?: { error?: string } })?.response?.error ??
    (e instanceof Error && e.message ? e.message : fallback)

  const bodyOf = (d: Draft) => ({
    title: d.title.trim(),
    description: d.description.trim() || null,
    assignee: d.mode === 'person' ? d.assignee : null,
    team_id: d.mode === 'team' ? d.teamId : null,
    due_date: d.due || null,
    priority: d.priority,
    done_when: d.doneWhen.length ? d.doneWhen : null
  })

  const createMut = useMutation({
    mutationFn: (d: Draft) =>
      client.request<{ data: { delegated_from?: string | null } }>(
        post('/tasks', { collection, item, ...bodyOf(d) })
      ),
    onSuccess: (r) => {
      invalidate()
      setAdding(false)
      toast.success(
        r?.data?.delegated_from ? 'Task created — it went to their delegate' : 'Task created'
      )
    },
    onError: (e) => toast.error(errText(e, 'Could not create the task'))
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      client.request(patch(`/tasks/${id}`, body)),
    onSuccess: (_r, v) => {
      invalidate()
      setEditing(null)
      if ((v.body as { status?: string }).status === 'open') toast.success('Task reopened')
      else toast.success('Task updated')
    },
    onError: (e) => toast.error(errText(e, 'Could not update the task'))
  })

  const completeMut = useMutation({
    mutationFn: (taskId: number) => client.request(post(`/tasks/${taskId}/complete`, {})),
    onSuccess: () => {
      invalidate()
      toast.success('Task completed')
    },
    onError: (e) => toast.error(errText(e, 'Could not complete the task'))
  })

  const claimMut = useMutation({
    mutationFn: (taskId: number) => client.request(post(`/tasks/${taskId}/claim`, {})),
    onSuccess: () => {
      invalidate()
      toast.success('It’s yours')
    },
    onError: (e) => toast.error(errText(e, 'Could not pick it up'))
  })

  const deleteMut = useMutation({
    mutationFn: (taskId: number) => client.request(del(`/tasks/${taskId}`)),
    onSuccess: () => {
      invalidate()
      toast.success('Task deleted')
    },
    onError: (e) => toast.error(errText(e, 'Could not delete the task'))
  })

  if (!collection) return null

  const openTasks = tasks.filter((t) => OPEN_TASK_STATUSES.has(t.status))
  const completedTasks = tasks.filter((t) => !OPEN_TASK_STATUSES.has(t.status))
  const today = new Date().toISOString().slice(0, 10)
  const canWork = (t: Task) => isAdmin || same(t.assignee, userId) || same(t.created_by, userId)
  const canDelete = (t: Task) => isAdmin || same(t.created_by, userId)

  function handleQueue(d: Draft) {
    onQueueTask?.({
      title: d.title.trim(),
      description: d.description.trim() || undefined,
      assignee: d.mode === 'person' ? d.assignee : null,
      assignee_name: d.mode === 'person' ? d.assigneeName : null,
      team_id: d.mode === 'team' ? d.teamId : null,
      team_name: d.mode === 'team' ? d.teamName : null,
      due_date: d.due,
      priority: d.priority
    })
    setAdding(false)
  }

  const meta = (t: Task, done: boolean) => {
    const overdue = !done && !!t.due_date && String(t.due_date).slice(0, 10) < today
    return (
      <div className='mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400'>
        <PriorityPill priority={t.priority} />
        {t.assignee ? (
          <span>{t.assignee_name ?? 'Someone'}</span>
        ) : t.team_id != null ? (
          <span className='inline-flex items-center gap-1'>
            <Users className='h-3 w-3' />
            Waiting for {t.team_name ?? 'the team'}
          </span>
        ) : null}
        {!done && t.due_date && (
          <span className={cn(overdue && 'font-medium text-red-500')}>
            Due {formatDate(t.due_date)}
            {overdue && ' (overdue)'}
          </span>
        )}
        {done && t.completed_at && (
          <span data-task-completed-by>
            {t.status === 'cancelled'
              ? 'Cancelled'
              : `Done${t.completed_by_name ? ` by ${t.completed_by_name}` : ''}`}{' '}
            <span title={new Date(t.completed_at).toLocaleString()}>
              {formatRelative(t.completed_at)}
            </span>
          </span>
        )}
        {t.created_by_name && !same(t.created_by, t.assignee) && (
          <span>Asked by {t.created_by_name}</span>
        )}
      </div>
    )
  }

  const rowActions = (t: Task, done: boolean) => (
    <div className='flex shrink-0 items-center gap-0.5'>
      <button
        type='button'
        onClick={() => setHistoryOf(historyOf === t.id ? null : t.id)}
        className='rounded p-1 text-slate-300 transition-colors hover:bg-muted hover:text-slate-600'
        aria-label={`History of ${t.title}`}
        title='History'
        data-task-history-toggle={t.id}
      >
        <History className='h-3.5 w-3.5' />
      </button>
      {!done && canWork(t) && (
        <button
          type='button'
          onClick={() => setEditing(editing === t.id ? null : t.id)}
          className='rounded p-1 text-slate-300 transition-colors hover:bg-muted hover:text-slate-600'
          aria-label={`Edit ${t.title}`}
          title='Edit'
          data-task-edit={t.id}
        >
          <Pencil className='h-3.5 w-3.5' />
        </button>
      )}
      {done && canWork(t) && (
        <button
          type='button'
          onClick={() => updateMut.mutate({ id: t.id, body: { status: 'open' } })}
          disabled={updateMut.isPending}
          className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 dark:hover:text-slate-200'
          data-task-reopen={t.id}
        >
          <RotateCcw className='h-3 w-3' />
          Reopen
        </button>
      )}
      {canDelete(t) && (
        <button
          type='button'
          onClick={() => deleteMut.mutate(t.id)}
          disabled={deleteMut.isPending}
          className='rounded p-1 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-400 disabled:opacity-40 dark:hover:bg-red-500/10'
          aria-label={`Delete ${t.title}`}
          title='Delete'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  )

  return (
    <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-task-panel-toggle={expanded ? 'open' : 'closed'}
        className='flex w-full flex-col px-5 py-3.5 text-left transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
      >
        <span className='flex w-full items-center gap-2.5'>
          <ClipboardList className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
            {title || 'Tasks'}
          </span>
          {(isNew ? (queuedTasks ?? []).length : openTasks.length) > 0 && (
            <span className='rounded-full bg-slate-100 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'>
              {isNew ? `${(queuedTasks ?? []).length} queued` : `${openTasks.length} open`}
            </span>
          )}
          <ChevronDown
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}`}
          />
        </span>
        {!expanded && openTasks.length > 0 && (
          <span className='mt-1 w-full truncate pl-6 text-[11.5px] text-slate-400'>
            {openTasks[openTasks.length - 1].title}
            {openTasks[openTasks.length - 1].due_date && (
              <span className='text-slate-400/80'>
                {' '}
                · due {formatDate(openTasks[openTasks.length - 1].due_date as string)}
              </span>
            )}
          </span>
        )}
      </button>

      {expanded && (
        <div className='border-t border-slate-100 dark:border-border/60'>
          <div className='space-y-3 px-5 py-3'>
            {isNew && (queuedTasks ?? []).length > 0 && (
              <div className='divide-y divide-slate-100 dark:divide-border/60'>
                {(queuedTasks ?? []).map((t, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: queued rows have no id yet
                  <div key={i} className='flex items-start gap-2.5 py-2'>
                    <span className='mt-0.5 inline-flex shrink-0 items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'>
                      Pending
                    </span>
                    <div className='min-w-0 flex-1'>
                      <p className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
                        {t.title}
                      </p>
                      <div className='mt-0.5 flex items-center gap-3 text-[11px] text-slate-400'>
                        <PriorityPill priority={t.priority} />
                        {t.assignee_name && <span>{t.assignee_name}</span>}
                        {t.team_name && <span>Team: {t.team_name}</span>}
                        {t.due_date && <span>Due {formatDate(t.due_date)}</span>}
                      </div>
                    </div>
                    {onRemoveQueuedTask && (
                      <button
                        type='button'
                        onClick={() => onRemoveQueuedTask(i)}
                        className='shrink-0 rounded p-1 text-slate-300 hover:text-red-400'
                        aria-label={`Remove ${t.title}`}
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isNew && (queuedTasks ?? []).length === 0 && !adding && (
              <p className='py-1 text-[12px] text-slate-400'>
                Tasks are created once the record is saved.
              </p>
            )}

            {!isNew && openTasks.length === 0 && !adding && (
              <p className='py-1 text-[13px] text-slate-400'>No open tasks</p>
            )}
            {!isNew && openTasks.length > 0 && (
              <div className='divide-y divide-slate-100 dark:divide-border/60'>
                {openTasks.map((t) => {
                  const rules = parseRules(t.done_when)
                  const unclaimed = !t.assignee && t.team_id != null
                  return (
                    <div key={t.id} className='nvr-rise-in py-2' data-task-row={t.id}>
                      <div className='flex items-start gap-2.5'>
                        <Checkbox
                          className='mt-0.5'
                          checked={false}
                          onCheckedChange={() => completeMut.mutate(t.id)}
                          disabled={completeMut.isPending || !canWork(t)}
                          aria-label={`Complete task: ${t.title}`}
                        />
                        <div className='min-w-0 flex-1'>
                          <p className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
                            {t.title}
                          </p>
                          {t.description && (
                            <p className='mt-0.5 line-clamp-2 whitespace-pre-line text-[12px] text-slate-500'>
                              {t.description}
                            </p>
                          )}
                          {meta(t, false)}
                          {rules.length > 0 && (
                            <p className='mt-0.5 text-[11px] text-slate-500' data-task-rule>
                              Closes itself when {describeRules(rules, labels)}
                            </p>
                          )}
                          {unclaimed && (
                            <button
                              type='button'
                              onClick={() => claimMut.mutate(t.id)}
                              disabled={claimMut.isPending}
                              className='mt-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-slate-300'
                              data-task-claim={t.id}
                            >
                              Pick it up
                            </button>
                          )}
                        </div>
                        {rowActions(t, false)}
                      </div>
                      {editing === t.id && (
                        <div className='mt-2 pl-6'>
                          <TaskForm
                            collection={collection}
                            item={item}
                            initial={draftFrom(t)}
                            submitLabel='Save changes'
                            busy={updateMut.isPending}
                            allowTeam={false}
                            onCancel={() => setEditing(null)}
                            onSubmit={(d) => {
                              const b = bodyOf(d)
                              const body: Record<string, unknown> = {
                                title: b.title,
                                description: b.description,
                                due_date: b.due_date,
                                priority: b.priority,
                                done_when: b.done_when
                              }
                              if (d.mode === 'person' && !same(d.assignee, t.assignee))
                                body.assignee = d.assignee
                              updateMut.mutate({ id: t.id, body })
                            }}
                          />
                        </div>
                      )}
                      {historyOf === t.id && (
                        <div className='pl-6'>
                          <TaskHistory taskId={t.id} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {!adding && (
              <button
                type='button'
                onClick={() => setAdding(true)}
                className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-[#00ceff]'
                data-task-add
              >
                <Plus className='h-3.5 w-3.5' />
                Add task
              </button>
            )}
            {adding && (
              <TaskForm
                collection={collection}
                item={item}
                initial={emptyDraft()}
                submitLabel={isNew ? 'Queue task' : 'Create task'}
                busy={createMut.isPending}
                allowTeam
                onCancel={() => setAdding(false)}
                onSubmit={(d) => (isNew ? handleQueue(d) : createMut.mutate(d))}
              />
            )}

            {!isNew && completedTasks.length > 0 && (
              <div>
                <button
                  type='button'
                  onClick={() => setShowCompleted((v) => !v)}
                  className='flex items-center gap-1 text-[12px] text-slate-400 transition-colors hover:text-slate-600'
                >
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 transition-transform',
                      showCompleted && 'rotate-180'
                    )}
                  />
                  Completed ({completedTasks.length})
                </button>
                {showCompleted && (
                  <div className='mt-1 divide-y divide-slate-100 dark:divide-border/60'>
                    {completedTasks.map((t) => (
                      <div key={t.id} className='nvr-rise-in py-2' data-task-row={t.id}>
                        <div className='flex items-start gap-2.5'>
                          <Checkbox
                            className='mt-0.5 opacity-60'
                            checked
                            disabled
                            aria-label='Completed'
                          />
                          <div className='min-w-0 flex-1 opacity-70'>
                            <p className='text-[13px] text-slate-600 line-through dark:text-slate-400'>
                              {t.title}
                            </p>
                            {meta(t, true)}
                          </div>
                          {rowActions(t, true)}
                        </div>
                        {historyOf === t.id && (
                          <div className='pl-6'>
                            <TaskHistory taskId={t.id} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
