import { CollectionFieldPicker } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2, X } from 'lucide-react'
import { useMemo } from 'react'
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
import { UserCombobox } from '@/components/user-combobox'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

/**
 * Builder for the "Activity pattern" alert kind (#23): who did it, which
 * action, which collection (any or one), an optional record filter (judged as
 * the rule's owner sees the record), optional changed fields, and an hourly
 * notification limit (the rest arrive as one digest). The config is stored in
 * the alert definition's `filters` JSON; see api services/activity-pattern-gate.ts.
 */

export interface ActivityPatternConfig {
  who: { kind: 'any' | 'users' | 'roles'; users: string[]; roles: string[] }
  actions: string[]
  record_filter: Record<string, unknown> | null
  changed_fields: string[]
  max_per_hour: number
}

export interface PatternFilterRow {
  field: string
  op: string
  value: string
}

export const EMPTY_PATTERN: ActivityPatternConfig = {
  who: { kind: 'any', users: [], roles: [] },
  actions: ['update'],
  record_filter: null,
  changed_fields: [],
  max_per_hour: 10
}

const ACTIONS = ['create', 'update', 'delete', 'restore', 'transition', 'undo', 'comment', 'export']

const OPS = [
  { value: '_eq', label: '=' },
  { value: '_neq', label: '≠' },
  { value: '_gt', label: '>' },
  { value: '_gte', label: '≥' },
  { value: '_lt', label: '<' },
  { value: '_lte', label: '≤' },
  { value: '_contains', label: 'contains' },
  { value: '_null', label: 'is empty' },
  { value: '_nnull', label: 'is not empty' }
]
const NO_VALUE = new Set(['_null', '_nnull'])
const NUMERIC = new Set(['_gt', '_gte', '_lt', '_lte'])

function leaf(path: string, op: string, value: string): Record<string, unknown> {
  const v: unknown = NO_VALUE.has(op)
    ? true
    : NUMERIC.has(op) && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : value
  const segs = path.split('.').filter(Boolean)
  let node: Record<string, unknown> = { [op]: v }
  for (let i = segs.length - 1; i >= 0; i--) node = { [segs[i]]: node }
  return node
}

/** Rows → the stored filter (one row = a plain condition; several = _and). */
export function rowsToFilter(rows: PatternFilterRow[]): Record<string, unknown> | null {
  const valid = rows.filter((r) => r.field.trim() && r.op)
  if (valid.length === 0) return null
  const leaves = valid.map((r) => leaf(r.field.trim(), r.op, r.value))
  return leaves.length === 1 ? leaves[0] : { _and: leaves }
}

function leafToRow(node: Record<string, unknown>, prefix: string[] = []): PatternFilterRow | null {
  const keys = Object.keys(node)
  if (keys.length !== 1) return null
  const k = keys[0]
  const v = node[k]
  if (k.startsWith('_')) {
    if (prefix.length === 0) return null
    return { field: prefix.join('.'), op: k, value: NO_VALUE.has(k) ? '' : String(v ?? '') }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return leafToRow(v as Record<string, unknown>, [...prefix, k])
}

/** The stored filter → rows; null when its shape is beyond the builder. */
export function filterToRows(filter: Record<string, unknown> | null): PatternFilterRow[] | null {
  if (!filter) return []
  const list = Array.isArray(filter._and) ? (filter._and as Record<string, unknown>[]) : [filter]
  const rows: PatternFilterRow[] = []
  for (const n of list) {
    const r = n && typeof n === 'object' ? leafToRow(n) : null
    if (!r) return null
    rows.push(r)
  }
  return rows
}

function Chip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
        active
          ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
          : 'border-slate-200 text-muted-foreground hover:bg-muted dark:border-border'
      )}
    >
      {children}
    </button>
  )
}

interface RoleRow {
  id: string
  name: string
}

export function ActivityPatternBuilder({
  value,
  onChange,
  collection,
  filterRows,
  onFilterRowsChange
}: {
  value: ActivityPatternConfig
  onChange: (next: ActivityPatternConfig) => void
  /** The watched collection ('' or '*' = any business collection). */
  collection: string
  filterRows: PatternFilterRow[]
  onFilterRowsChange: (rows: PatternFilterRow[]) => void
}) {
  const one = !!collection && collection !== '*'
  const { data: roles = [] } = useQuery<RoleRow[]>({
    queryKey: ['alert-pattern-roles'],
    queryFn: () => api.get('/roles').then((r) => r.data.data ?? []),
    staleTime: 300_000
  })
  const userIds = value.who.users
  const { data: cards = [] } = useQuery<
    Array<{ id: string; first_name?: string | null; last_name?: string | null; email?: string }>
  >({
    queryKey: ['alert-pattern-users', [...userIds].sort().join(',')],
    queryFn: () => api.post('/users/cards', { ids: userIds }).then((r) => r.data.data ?? []),
    enabled: userIds.length > 0,
    staleTime: 300_000
  })
  const nameOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of cards) {
      const n = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
      m.set(String(c.id).toLowerCase(), n || c.email || c.id)
    }
    return (id: string) => m.get(id.toLowerCase()) ?? id.slice(0, 8)
  }, [cards])

  const set = (patch: Partial<ActivityPatternConfig>) => onChange({ ...value, ...patch })
  const setWho = (patch: Partial<ActivityPatternConfig['who']>) =>
    set({ who: { ...value.who, ...patch } })
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  const updateRow = (i: number, patch: Partial<PatternFilterRow>) =>
    onFilterRowsChange(filterRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  return (
    <div className='space-y-5 rounded-md border border-slate-200 p-4 dark:border-border'>
      {/* Who */}
      <div className='space-y-1.5'>
        <Label>Who</Label>
        <div className='inline-flex rounded-md border p-0.5'>
          {(['any', 'users', 'roles'] as const).map((k) => (
            <Button
              key={k}
              type='button'
              size='sm'
              variant={value.who.kind === k ? 'default' : 'ghost'}
              className='h-7 px-3 text-xs'
              onClick={() => setWho({ kind: k })}
            >
              {k === 'any' ? 'Anyone' : k === 'users' ? 'These people' : 'These roles'}
            </Button>
          ))}
        </div>
        {value.who.kind === 'users' && (
          <div className='space-y-2'>
            <div className='flex flex-wrap gap-1.5'>
              {userIds.map((u) => (
                <span
                  key={u}
                  className='inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[12px] dark:border-border'
                >
                  {nameOf(u)}
                  <button
                    type='button'
                    aria-label='Remove'
                    className='text-muted-foreground hover:text-foreground'
                    onClick={() => setWho({ users: userIds.filter((x) => x !== u) })}
                  >
                    <X className='h-3 w-3' />
                  </button>
                </span>
              ))}
            </div>
            <div className='w-72'>
              <UserCombobox
                value={null}
                hideNone
                searchServer
                placeholder='Add a person…'
                onChange={(id) => {
                  if (id && !userIds.includes(id)) setWho({ users: [...userIds, id] })
                }}
              />
            </div>
          </div>
        )}
        {value.who.kind === 'roles' && (
          <div className='flex flex-wrap gap-1.5'>
            {roles.map((r) => (
              <Chip
                key={r.id}
                active={value.who.roles.includes(r.id)}
                onClick={() => setWho({ roles: toggle(value.who.roles, r.id) })}
              >
                {r.name}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* What */}
      <div className='space-y-1.5'>
        <Label>Did what</Label>
        <div className='flex flex-wrap gap-1.5'>
          {ACTIONS.map((a) => (
            <Chip
              key={a}
              active={value.actions.includes(a)}
              onClick={() => set({ actions: toggle(value.actions, a) })}
            >
              {titleCase(a)}
            </Chip>
          ))}
        </div>
        <p className='text-xs text-muted-foreground'>
          {value.actions.length === 0 ? 'Any action in the log' : 'Only these actions'}
        </p>
      </div>

      {/* Changed fields */}
      <div className='space-y-1.5'>
        <Label>Changed fields (optional)</Label>
        {one ? (
          <>
            <div className='flex flex-wrap items-center gap-1.5'>
              {value.changed_fields.map((f) => (
                <span
                  key={f}
                  className='inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 font-mono text-[11px] dark:border-border'
                >
                  {f}
                  <button
                    type='button'
                    aria-label='Remove'
                    className='text-muted-foreground hover:text-foreground'
                    onClick={() =>
                      set({ changed_fields: value.changed_fields.filter((x) => x !== f) })
                    }
                  >
                    <X className='h-3 w-3' />
                  </button>
                </span>
              ))}
              <div className='w-56'>
                <CollectionFieldPicker
                  collection={collection}
                  value=''
                  onChange={(picked) => {
                    const f = picked.path[0]
                    if (f && !value.changed_fields.includes(f))
                      set({ changed_fields: [...value.changed_fields, f] })
                  }}
                  placeholder='Add a field…'
                />
              </div>
            </div>
            <p className='text-xs text-muted-foreground'>
              An update matches only when it changed one of these fields
            </p>
          </>
        ) : (
          <p className='text-xs text-muted-foreground'>Pick one collection to name fields</p>
        )}
      </div>

      {/* Record filter */}
      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <div>
            <Label>Only records where (optional)</Label>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              Judged as you see the record — e.g. amount &gt; 50000. Deletes never match a record
              filter.
            </p>
          </div>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!one}
            onClick={() => onFilterRowsChange([...filterRows, { field: '', op: '_eq', value: '' }])}
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' />
            Add condition
          </Button>
        </div>
        {one && filterRows.length > 0 && (
          <div className='divide-y rounded-md border'>
            {filterRows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: condition rows keyed by position
              <div key={i} className='flex items-center gap-2 px-3 py-2'>
                <div className='flex-1'>
                  <CollectionFieldPicker
                    collection={collection}
                    value={row.field}
                    onChange={(picked) => updateRow(i, { field: picked.path.join('.') })}
                    onClear={() => updateRow(i, { field: '' })}
                    placeholder='Select field…'
                  />
                </div>
                <div className='w-32'>
                  <Select value={row.op} onValueChange={(op) => updateRow(i, { op })}>
                    <SelectTrigger className='h-8'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {!NO_VALUE.has(row.op) && (
                  <Input
                    value={row.value}
                    onChange={(e) => updateRow(i, { value: e.target.value })}
                    placeholder='value'
                    className='h-8 w-32 text-sm'
                  />
                )}
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  className='h-7 w-7 flex-shrink-0 text-destructive hover:text-destructive'
                  onClick={() => onFilterRowsChange(filterRows.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rate limit */}
      <div className='space-y-1.5'>
        <Label htmlFor='pattern-max'>Notifications per hour</Label>
        <Input
          id='pattern-max'
          type='number'
          min={1}
          max={1000}
          value={value.max_per_hour}
          onChange={(e) => set({ max_per_hour: Math.max(1, Number(e.target.value) || 1) })}
          className='w-40'
        />
        <p className='text-xs text-muted-foreground'>
          Past this, matches are kept and sent as one digest after the hour
        </p>
      </div>
    </div>
  )
}
