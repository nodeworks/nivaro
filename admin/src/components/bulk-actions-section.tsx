import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  Lock,
  MessageSquareText,
  Pencil,
  Plus,
  Trash2,
  Users
} from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Bulk actions registry editor (Data Model → collection → Settings). One
 * card per collection: the actions the selection bars offer (On Hold, Cancel…),
 * each a field write or a pipeline transition, with a per-record guard,
 * access (everyone / admins / roles), optional required reason and confirm
 * text. Surfaces (collection browser, queues) pick which of these they show
 * via BulkActionsPicker.
 */

type Kind = 'update_fields' | 'transition'
type AccessMode = 'everyone' | 'admin' | 'roles'
type GuardRule = { field: string; op: string; value?: unknown }

export interface BulkActionDef {
  id: number
  collection: string
  key: string
  label: string
  variant: 'default' | 'danger'
  kind: Kind
  config: { set?: Record<string, unknown>; transition_label?: string }
  guard: GuardRule[] | null
  access: { mode: AccessMode; role_ids?: string[] }
  require_reason: boolean
  confirm_text: string | null
  is_active: boolean
  sort: number
}

type FieldMeta = {
  field: string
  label: string
  type: string
  hidden?: boolean
  special?: string | null
}
type RoleMeta = { id: string; name: string; admin_access?: boolean }

const GUARD_OPS: Array<{ value: string; label: string; needsValue: boolean }> = [
  { value: 'eq', label: 'is', needsValue: true },
  { value: 'neq', label: 'is not', needsValue: true },
  { value: 'null', label: 'is empty', needsValue: false },
  { value: 'nnull', label: 'is set', needsValue: false },
  { value: 'in', label: 'is one of', needsValue: true },
  { value: 'nin', label: 'is none of', needsValue: true }
]

/** Value editor kinds for a set-fields row. */
type ValueKind = 'text' | 'number' | 'yes' | 'no' | 'empty' | 'reason'
function kindOf(v: unknown): ValueKind {
  if (v === true) return 'yes'
  if (v === false) return 'no'
  if (v === null || v === undefined) return 'empty'
  if (typeof v === 'number') return 'number'
  if (v === '{{reason}}') return 'reason'
  return 'text'
}
function valueFor(kind: ValueKind, text: string): unknown {
  switch (kind) {
    case 'yes':
      return true
    case 'no':
      return false
    case 'empty':
      return null
    case 'reason':
      return '{{reason}}'
    case 'number':
      return Number(text)
    default:
      return text
  }
}
const VALUE_KINDS: Array<{ value: ValueKind; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'empty', label: 'Empty' },
  { value: 'reason', label: 'The reason' }
]

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function useFields(collection: string) {
  return useQuery<FieldMeta[]>({
    queryKey: ['bulk-actions-fields', collection],
    queryFn: () =>
      api
        .get(`/field-config/${collection}`)
        .then((r) =>
          ((r.data.data ?? []) as FieldMeta[]).filter(
            (f) =>
              !f.hidden &&
              f.field !== 'id' &&
              !f.field.includes('.') &&
              !/m2m|o2m|m2a|alias/.test(String(f.special ?? '')) &&
              f.type !== 'alias'
          )
        ),
    enabled: !!collection,
    staleTime: 60_000
  })
}

/** Small searchable picker (Popover + Command) — the admin's combobox idiom. */
function Combo({
  value,
  options,
  placeholder,
  onChange,
  className,
  disabled
}: {
  value: string
  options: Array<{ value: string; label: string; hint?: string }>
  placeholder: string
  onChange: (v: string) => void
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className={cn(
            'flex h-8 items-center justify-between gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[12.5px] hover:bg-slate-50 disabled:opacity-50',
            !current && 'text-slate-400',
            className
          )}
        >
          <span className='truncate'>{current?.label ?? placeholder}</span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12.5px]' />
          <CommandList className='max-h-56'>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3.5 w-3.5',
                      o.value === value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='truncate'>{o.label}</span>
                  {o.hint && (
                    <span className='ml-auto pl-2 font-mono text-[10.5px] text-slate-400'>
                      {o.hint}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className='inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5'>
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'h-7 rounded px-2.5 text-[12px] font-medium transition-colors',
            value === o.value
              ? 'bg-white text-slate-800 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ─── Form ─────────────────────────────────────────────────────────────────────

type SetRow = { uid: number; field: string; kind: ValueKind; text: string }
type GuardRow = GuardRule & { uid: number }
let uidSeq = 1
const uid = () => uidSeq++

interface FormState {
  label: string
  key: string
  keyTouched: boolean
  kind: Kind
  sets: SetRow[]
  transitionLabel: string
  guard: GuardRow[]
  accessMode: AccessMode
  roleIds: string[]
  requireReason: boolean
  confirmText: string
  danger: boolean
}

function emptyForm(): FormState {
  return {
    label: '',
    key: '',
    keyTouched: false,
    kind: 'update_fields',
    sets: [{ uid: uid(), field: '', kind: 'yes', text: '' }],
    transitionLabel: '',
    guard: [],
    accessMode: 'everyone',
    roleIds: [],
    requireReason: false,
    confirmText: '',
    danger: false
  }
}

function formFrom(a: BulkActionDef): FormState {
  const sets = Object.entries(a.config.set ?? {}).map(([field, v]) => ({
    uid: uid(),
    field,
    kind: kindOf(v),
    text: kindOf(v) === 'text' || kindOf(v) === 'number' ? String(v) : ''
  }))
  return {
    label: a.label,
    key: a.key,
    keyTouched: true,
    kind: a.kind,
    sets: sets.length ? sets : [{ uid: uid(), field: '', kind: 'yes', text: '' }],
    transitionLabel: a.config.transition_label ?? '',
    guard: (a.guard ?? []).map((g) => ({ ...g, uid: uid() })),
    accessMode: a.access.mode,
    roleIds: a.access.role_ids ?? [],
    requireReason: a.require_reason,
    confirmText: a.confirm_text ?? '',
    danger: a.variant === 'danger'
  }
}

function BulkActionForm({
  collection,
  initial,
  onSaved,
  onCancel
}: {
  collection: string
  initial: BulkActionDef | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [f, setF] = useState<FormState>(() => (initial ? formFrom(initial) : emptyForm()))
  const patch = (p: Partial<FormState>) => setF((s) => ({ ...s, ...p }))
  const { data: fields = [] } = useFields(collection)
  const { data: transitionLabels = [] } = useQuery<string[]>({
    queryKey: ['bulk-actions-transition-labels', collection],
    queryFn: () =>
      api
        .get('/bulk-actions/transition-labels', { params: { collection } })
        .then((r) => r.data.data ?? []),
    staleTime: 60_000
  })
  const { data: roles = [] } = useQuery<RoleMeta[]>({
    queryKey: ['bulk-actions-roles'],
    queryFn: () => api.get('/roles').then((r) => r.data.data ?? []),
    staleTime: 300_000
  })
  const fieldOptions = useMemo(
    () => fields.map((x) => ({ value: x.field, label: x.label || x.field, hint: x.type })),
    [fields]
  )

  const body = () => {
    const config =
      f.kind === 'transition'
        ? { transition_label: f.transitionLabel.trim() }
        : {
            set: Object.fromEntries(
              f.sets.filter((r) => r.field).map((r) => [r.field, valueFor(r.kind, r.text)])
            )
          }
    return {
      collection,
      label: f.label.trim(),
      key: f.key.trim() || slugify(f.label),
      kind: f.kind,
      config,
      guard: f.guard.filter((g) => g.field && g.op).map(({ uid: _u, ...g }) => g),
      access:
        f.accessMode === 'roles' ? { mode: 'roles', role_ids: f.roleIds } : { mode: f.accessMode },
      require_reason: f.requireReason,
      confirm_text: f.confirmText.trim() || null,
      variant: f.danger ? 'danger' : 'default'
    }
  }
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api.patch(`/bulk-actions/defs/${initial.id}`, body())
        : api.post('/bulk-actions/defs', body()),
    onSuccess: () => {
      toast.success(initial ? 'Bulk action saved' : 'Bulk action created')
      onSaved()
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message ?? 'Save failed')
  })

  const valid =
    f.label.trim() !== '' &&
    (f.kind === 'transition' ? f.transitionLabel.trim() !== '' : f.sets.some((r) => r.field)) &&
    (f.accessMode !== 'roles' || f.roleIds.length > 0)

  const row = (label: string, hint: string | null, control: React.ReactNode) => (
    <div className='grid grid-cols-[150px_1fr] items-start gap-3'>
      <div className='pt-1.5'>
        <p className='text-[12.5px] font-medium text-slate-700'>{label}</p>
        {hint && <p className='text-[11px] leading-snug text-slate-500'>{hint}</p>}
      </div>
      <div className='min-w-0'>{control}</div>
    </div>
  )

  return (
    <div
      className='space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-4'
      data-bulk-action-form
    >
      {row(
        'Label',
        'What the button says',
        <div className='flex gap-2'>
          <Input
            value={f.label}
            autoFocus
            onChange={(e) =>
              patch({
                label: e.target.value,
                ...(f.keyTouched ? {} : { key: slugify(e.target.value) })
              })
            }
            placeholder='On Hold'
            className='h-8 text-[12.5px]'
          />
          <Input
            value={f.key}
            onChange={(e) => patch({ key: slugify(e.target.value), keyTouched: true })}
            placeholder='on-hold'
            title='Key — how surfaces and the API refer to this action'
            className='h-8 w-[160px] font-mono text-[11.5px]'
          />
        </div>
      )}
      {row(
        'Does',
        null,
        <div className='space-y-2'>
          <Segmented
            value={f.kind}
            options={[
              { value: 'update_fields', label: 'Set fields' },
              { value: 'transition', label: 'Run a transition' }
            ]}
            onChange={(kind) => patch({ kind })}
          />
          {f.kind === 'update_fields' ? (
            <div className='space-y-1.5'>
              {f.sets.map((r, i) => (
                <div key={r.uid} className='flex items-center gap-1.5'>
                  <Combo
                    value={r.field}
                    options={fieldOptions}
                    placeholder='Field…'
                    className='w-[200px]'
                    onChange={(field) =>
                      patch({ sets: f.sets.map((x, xi) => (xi === i ? { ...x, field } : x)) })
                    }
                  />
                  <span className='text-[12px] text-slate-400'>=</span>
                  <Combo
                    value={r.kind}
                    options={VALUE_KINDS}
                    placeholder='Value'
                    className='w-[120px]'
                    onChange={(k) =>
                      patch({
                        sets: f.sets.map((x, xi) => (xi === i ? { ...x, kind: k as ValueKind } : x))
                      })
                    }
                  />
                  {(r.kind === 'text' || r.kind === 'number') && (
                    <Input
                      value={r.text}
                      type={r.kind === 'number' ? 'number' : 'text'}
                      onChange={(e) =>
                        patch({
                          sets: f.sets.map((x, xi) =>
                            xi === i ? { ...x, text: e.target.value } : x
                          )
                        })
                      }
                      placeholder={r.kind === 'number' ? '0' : 'value or {{field}}'}
                      className='h-8 w-[180px] text-[12.5px]'
                    />
                  )}
                  {f.sets.length > 1 && (
                    <button
                      type='button'
                      onClick={() => patch({ sets: f.sets.filter((_, xi) => xi !== i) })}
                      className='rounded p-1 text-slate-400 hover:text-red-600'
                      aria-label='Remove field'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  )}
                </div>
              ))}
              <button
                type='button'
                onClick={() =>
                  patch({ sets: [...f.sets, { uid: uid(), field: '', kind: 'text', text: '' }] })
                }
                className='text-[12px] text-nvr-navy hover:underline'
              >
                + Another field
              </button>
              <p className='text-[11px] text-slate-500'>
                Writes go through the normal save path — rules, validation and history apply. “The
                reason” inserts what the person typed.
              </p>
            </div>
          ) : (
            <div className='space-y-1'>
              <Combo
                value={f.transitionLabel}
                options={transitionLabels.map((l) => ({ value: l, label: l }))}
                placeholder={transitionLabels.length ? 'Transition…' : 'No pipeline bound'}
                className='w-[260px]'
                disabled={transitionLabels.length === 0}
                onChange={(transitionLabel) => patch({ transitionLabel })}
              />
              <p className='text-[11px] text-slate-500'>
                Matched by label per record — the transition valid from each record's current state
                runs, with its own conditions, roles and requirements. Records with no matching
                transition are skipped.
              </p>
            </div>
          )}
        </div>
      )}
      {row(
        'Only when',
        'Records that don’t match are skipped, not failed',
        <div className='space-y-1.5'>
          {f.guard.map((g, i) => {
            const op = GUARD_OPS.find((o) => o.value === g.op)
            return (
              <div key={g.uid} className='flex items-center gap-1.5'>
                <Combo
                  value={g.field}
                  options={fieldOptions}
                  placeholder='Field…'
                  className='w-[200px]'
                  onChange={(field) =>
                    patch({ guard: f.guard.map((x, xi) => (xi === i ? { ...x, field } : x)) })
                  }
                />
                <Combo
                  value={g.op}
                  options={GUARD_OPS}
                  placeholder='is…'
                  className='w-[120px]'
                  onChange={(opv) =>
                    patch({ guard: f.guard.map((x, xi) => (xi === i ? { ...x, op: opv } : x)) })
                  }
                />
                {op?.needsValue !== false && (
                  <Input
                    value={g.value == null ? '' : String(g.value)}
                    onChange={(e) =>
                      patch({
                        guard: f.guard.map((x, xi) =>
                          xi === i ? { ...x, value: e.target.value } : x
                        )
                      })
                    }
                    placeholder={g.op === 'in' || g.op === 'nin' ? 'a, b, c' : 'true'}
                    className='h-8 w-[160px] text-[12.5px]'
                  />
                )}
                <button
                  type='button'
                  onClick={() => patch({ guard: f.guard.filter((_, xi) => xi !== i) })}
                  className='rounded p-1 text-slate-400 hover:text-red-600'
                  aria-label='Remove condition'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </div>
            )
          })}
          <button
            type='button'
            onClick={() =>
              patch({ guard: [...f.guard, { uid: uid(), field: '', op: 'eq', value: '' }] })
            }
            className='text-[12px] text-nvr-navy hover:underline'
          >
            + Add condition
          </button>
        </div>
      )}
      {row(
        'Who can run it',
        'On top of update permission for the collection',
        <div className='space-y-2'>
          <Segmented
            value={f.accessMode}
            options={[
              { value: 'everyone', label: 'Everyone' },
              { value: 'admin', label: 'Admins only' },
              { value: 'roles', label: 'Specific roles' }
            ]}
            onChange={(accessMode) => patch({ accessMode })}
          />
          {f.accessMode === 'roles' && (
            <div className='flex flex-wrap gap-x-4 gap-y-1.5'>
              {roles
                .filter((r) => !r.admin_access)
                .map((r) => (
                  <label
                    key={r.id}
                    htmlFor={`ba-role-${r.id}`}
                    className='flex cursor-pointer items-center gap-1.5 text-[12.5px]'
                  >
                    <Checkbox
                      id={`ba-role-${r.id}`}
                      checked={f.roleIds.includes(r.id)}
                      onCheckedChange={(on) =>
                        patch({
                          roleIds: on ? [...f.roleIds, r.id] : f.roleIds.filter((x) => x !== r.id)
                        })
                      }
                    />
                    {r.name}
                  </label>
                ))}
              <span className='text-[11px] text-slate-500'>Admins always can.</span>
            </div>
          )}
        </div>
      )}
      {row(
        'Before running',
        null,
        <div className='space-y-2'>
          <label
            htmlFor='ba-require-reason'
            className='flex items-center gap-2 text-[12.5px] text-slate-700'
          >
            <Switch
              id='ba-require-reason'
              checked={f.requireReason}
              onCheckedChange={(v) => patch({ requireReason: v })}
            />
            Ask for a reason — recorded on every record’s history
          </label>
          <Textarea
            value={f.confirmText}
            onChange={(e) => patch({ confirmText: e.target.value })}
            rows={2}
            placeholder='Confirmation text shown above the Run button (optional)'
            className='text-[12.5px]'
          />
          <label
            htmlFor='ba-danger'
            className='flex items-center gap-2 text-[12.5px] text-slate-700'
          >
            <Switch
              id='ba-danger'
              checked={f.danger}
              onCheckedChange={(v) => patch({ danger: v })}
            />
            Destructive — show the button in red
          </label>
        </div>
      )}
      <div className='flex items-center justify-end gap-2 pt-1'>
        <Button variant='ghost' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        <Button size='sm' disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {initial ? 'Save' : 'Create action'}
        </Button>
      </div>
    </div>
  )
}

// ─── Section (list) ───────────────────────────────────────────────────────────

function accessLabel(a: BulkActionDef['access'], roles: RoleMeta[]): string {
  if (a.mode === 'admin') return 'Admins'
  if (a.mode === 'roles') {
    const names = (a.role_ids ?? []).map((id) => roles.find((r) => r.id === id)?.name ?? '?')
    return names.length ? names.join(', ') : 'No roles'
  }
  return 'Everyone'
}

function guardText(g: GuardRule[] | null, fields: FieldMeta[]): string | null {
  if (!g?.length) return null
  return g
    .map((r) => {
      const label = fields.find((f) => f.field === r.field)?.label ?? r.field
      const op = GUARD_OPS.find((o) => o.value === r.op)
      return `${label} ${op?.label ?? r.op}${op?.needsValue === false ? '' : ` ${String(r.value ?? '')}`}`
    })
    .join(' and ')
}

export function BulkActionsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<'new' | number | null>(null)
  const { data: defs = [], isLoading } = useQuery<BulkActionDef[]>({
    queryKey: ['bulk-actions-defs', tableName],
    queryFn: () =>
      api
        .get('/bulk-actions/defs', { params: { collection: tableName } })
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })
  const { data: fields = [] } = useFields(tableName)
  const { data: roles = [] } = useQuery<RoleMeta[]>({
    queryKey: ['bulk-actions-roles'],
    queryFn: () => api.get('/roles').then((r) => r.data.data ?? []),
    staleTime: 300_000
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['bulk-actions-defs', tableName] })
    void qc.invalidateQueries({ queryKey: ['bulk-actions-catalog'] })
  }
  const patchMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/bulk-actions/defs/${id}`, body),
    onSuccess: invalidate,
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Save failed')
  })
  const delMut = useMutation({
    mutationFn: (id: number) => api.delete(`/bulk-actions/defs/${id}`),
    onSuccess: () => {
      toast.success('Bulk action deleted')
      invalidate()
    }
  })
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= defs.length) return
    const a = defs[i]
    const b = defs[j]
    void Promise.all([
      api.patch(`/bulk-actions/defs/${a.id}`, { sort: b.sort === a.sort ? a.sort + dir : b.sort }),
      api.patch(`/bulk-actions/defs/${b.id}`, { sort: a.sort })
    ]).then(invalidate)
  }
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  return (
    <div
      className='overflow-hidden rounded-lg border border-slate-200 bg-white'
      data-bulk-actions-section
    >
      <div className='flex items-start justify-between gap-4 px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Bulk actions</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Buttons offered over a selection in the collection browser and in queues — set fields or
            run a pipeline transition on every selected record. Each surface chooses which of these
            it shows.
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          onClick={() => setEditing(editing === 'new' ? null : 'new')}
          className='shrink-0'
        >
          <Plus className='mr-1 h-3.5 w-3.5' /> Add action
        </Button>
      </div>
      {editing === 'new' && (
        <BulkActionForm
          collection={tableName}
          initial={null}
          onSaved={() => {
            setEditing(null)
            invalidate()
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {isLoading ? (
        <div className='border-t border-slate-100 px-4 py-3 text-[12px] text-slate-400'>
          Loading…
        </div>
      ) : defs.length === 0 && editing !== 'new' ? (
        <div className='border-t border-slate-100 px-4 py-4 text-[12.5px] text-slate-500'>
          No bulk actions yet. Add one to offer it in this collection's browser and in any queue
          that lists these records — for example <em>On Hold</em> (set a flag) or <em>Cancel</em>{' '}
          (run the Cancel transition).
        </div>
      ) : (
        <ul className='divide-y divide-slate-100 border-t border-slate-100'>
          {defs.map((a, i) => {
            const guard = guardText(a.guard, fields)
            const summary =
              a.kind === 'transition'
                ? `Runs “${a.config.transition_label ?? ''}”`
                : `Sets ${Object.entries(a.config.set ?? {})
                    .map(([k, v]) => {
                      const label = fields.find((f) => f.field === k)?.label ?? k
                      const vk = kindOf(v)
                      const vt =
                        vk === 'yes'
                          ? 'Yes'
                          : vk === 'no'
                            ? 'No'
                            : vk === 'empty'
                              ? 'empty'
                              : vk === 'reason'
                                ? 'the reason'
                                : String(v)
                      return `${label} = ${vt}`
                    })
                    .join(', ')}`
            return (
              <li key={a.id} data-bulk-action-row={a.key}>
                <div
                  className={cn(
                    'flex items-center gap-3 px-4 py-2.5',
                    !a.is_active && 'opacity-60'
                  )}
                >
                  <div className='min-w-0 flex-1'>
                    <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                      <span
                        className={cn(
                          'text-[13px] font-medium',
                          a.variant === 'danger' ? 'text-red-700' : 'text-slate-800'
                        )}
                      >
                        {a.label}
                      </span>
                      <code className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[10.5px] text-slate-500'>
                        {a.key}
                      </code>
                      <span className='inline-flex items-center gap-1 rounded-full border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-600'>
                        {a.access.mode === 'everyone' ? (
                          <Users className='h-3 w-3' />
                        ) : (
                          <Lock className='h-3 w-3' />
                        )}
                        {accessLabel(a.access, roles)}
                      </span>
                      {a.require_reason && (
                        <span className='inline-flex items-center gap-1 rounded-full border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-600'>
                          <MessageSquareText className='h-3 w-3' /> Reason
                        </span>
                      )}
                    </div>
                    <p className='mt-0.5 truncate text-[12px] text-slate-500'>
                      {summary}
                      {guard && <span className='text-slate-400'> · only when {guard}</span>}
                    </p>
                  </div>
                  <div className='flex shrink-0 items-center gap-0.5'>
                    <button
                      type='button'
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className='rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30'
                      aria-label='Move up'
                    >
                      <ArrowUp className='h-3.5 w-3.5' />
                    </button>
                    <button
                      type='button'
                      onClick={() => move(i, 1)}
                      disabled={i === defs.length - 1}
                      className='rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30'
                      aria-label='Move down'
                    >
                      <ArrowDown className='h-3.5 w-3.5' />
                    </button>
                    <button
                      type='button'
                      onClick={() => setEditing(editing === a.id ? null : a.id)}
                      className='rounded p-1 text-slate-400 hover:text-slate-700'
                      aria-label='Edit'
                    >
                      <Pencil className='h-3.5 w-3.5' />
                    </button>
                    {confirmDelete === a.id ? (
                      <span className='ml-1 flex items-center gap-1 text-[11.5px]'>
                        <button
                          type='button'
                          onClick={() => {
                            delMut.mutate(a.id)
                            setConfirmDelete(null)
                          }}
                          className='rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700'
                        >
                          Delete
                        </button>
                        <button
                          type='button'
                          onClick={() => setConfirmDelete(null)}
                          className='rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100'
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type='button'
                        onClick={() => setConfirmDelete(a.id)}
                        className='rounded p-1 text-slate-400 hover:text-red-600'
                        aria-label='Delete'
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </button>
                    )}
                    <Switch
                      checked={a.is_active}
                      onCheckedChange={(v) => patchMut.mutate({ id: a.id, body: { is_active: v } })}
                      className='ml-2'
                      aria-label='Active'
                    />
                  </div>
                </div>
                {editing === a.id && (
                  <BulkActionForm
                    collection={tableName}
                    initial={a}
                    onSaved={() => {
                      setEditing(null)
                      invalidate()
                    }}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ─── Picker (which actions a surface shows) ───────────────────────────────────

export interface CatalogAction {
  key: string
  source: 'db' | 'extension'
  collection: string | null
  label: string
  variant: 'default' | 'danger'
  summary: string
  access: { mode: AccessMode; role_ids?: string[] }
}

export function useBulkActionCatalog(collections: string[]) {
  const key = [...new Set(collections.filter(Boolean))].sort().join(',')
  return useQuery<Record<string, CatalogAction[]>>({
    queryKey: ['bulk-actions-catalog', key],
    queryFn: async () => {
      const out: Record<string, CatalogAction[]> = {}
      await Promise.all(
        key.split(',').map(async (c) => {
          out[c] = await api
            .get('/bulk-actions/catalog', { params: { collection: c } })
            .then((r) => r.data.data ?? [])
            .catch(() => [])
        })
      )
      return out
    },
    enabled: key.length > 0,
    staleTime: 60_000
  })
}

/**
 * "Which bulk actions does this surface show?" — null = all (default), else an
 * explicit allow-list. `keyed` stores `collection:key` (queues span
 * collections); otherwise bare keys (one collection).
 */
export function BulkActionsPicker({
  collections,
  value,
  onChange,
  keyed = false,
  disabled
}: {
  collections: string[]
  value: string[] | null | undefined
  onChange: (next: string[] | null) => void
  keyed?: boolean
  disabled?: boolean
}) {
  const { data, isLoading } = useBulkActionCatalog(collections)
  const pickerId = useId()
  const entries = useMemo(() => {
    const out: Array<{ id: string; collection: string; action: CatalogAction }> = []
    for (const c of collections) {
      for (const a of data?.[c] ?? [])
        out.push({ id: keyed ? `${c}:${a.key}` : a.key, collection: c, action: a })
    }
    return out
  }, [data, collections, keyed])
  const explicit = Array.isArray(value)
  // Keep an explicit list honest when the catalog changes under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the catalog lands or the mode flips; onChange is a fresh closure every render
  useEffect(() => {
    if (!explicit || !data) return
    const known = new Set(entries.map((e) => e.id))
    const kept = value!.filter((k) => known.has(k))
    if (kept.length !== value!.length) onChange(kept)
  }, [entries.length, explicit])

  if (collections.length === 0) return null
  if (!isLoading && entries.length === 0)
    return (
      <p className='text-[11.5px] text-slate-500'>
        No bulk actions are defined for {collections.join(', ')}. Define them under Data Model → the
        collection → Settings → Bulk actions.
      </p>
    )
  const multi = new Set(collections).size > 1
  return (
    <div className='space-y-1.5' data-bulk-actions-picker>
      <label
        htmlFor={`ba-all-${pickerId}`}
        className='flex items-center gap-2 text-[12px] text-slate-600'
      >
        <Switch
          id={`ba-all-${pickerId}`}
          checked={!explicit}
          disabled={disabled}
          onCheckedChange={(all) => onChange(all ? null : entries.map((e) => e.id))}
        />
        Show every action the viewer may run
      </label>
      {explicit && (
        <div className='flex flex-wrap gap-x-4 gap-y-1 pl-1'>
          {entries.map((e) => (
            <label
              key={e.id}
              htmlFor={`ba-pick-${pickerId}-${e.id}`}
              className='flex cursor-pointer items-center gap-1.5 text-[12.5px] text-slate-700'
              title={e.action.summary}
            >
              <Checkbox
                id={`ba-pick-${pickerId}-${e.id}`}
                checked={value!.includes(e.id)}
                disabled={disabled}
                onCheckedChange={(on) =>
                  onChange(on ? [...value!, e.id] : value!.filter((k) => k !== e.id))
                }
              />
              <span className={cn(e.action.variant === 'danger' && 'text-red-700')}>
                {e.action.label}
              </span>
              {multi && <span className='text-[11px] text-slate-400'>{e.collection}</span>}
              {e.action.access.mode !== 'everyone' && <Lock className='h-3 w-3 text-slate-400' />}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
