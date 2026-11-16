import { queryKeys, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

/**
 * Data Model → Settings: "Move lines to a new record" (idea 4). Stored in
 * `browser_config.line_split` (api services/record-split.ts); the rest of
 * browser_config is kept as it is. Off by default; admins only.
 */

interface MetaField {
  field: string
  label?: string | null
  hidden?: boolean
  readonly?: boolean
  special?: string[] | null
  options?: Record<string, unknown> | string | null
  computed_type?: string | null
}
interface MetaRelation {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}
interface Meta {
  collection: string
  singular?: string | null
  fields?: MetaField[]
  relations?: MetaRelation[]
  browser_config?: Record<string, unknown> | null
}

export interface LineSplitDraft {
  enabled: boolean
  relations: string[]
  skip_fields: string[]
  link_field: string | null
  copy_links: boolean
}

const AUDIT = new Set([
  'id',
  'user_created',
  'date_created',
  'user_updated',
  'date_updated',
  'created_at',
  'updated_at',
  'created',
  'changed',
  'creator',
  'last_state_change'
])
const LIST_SPECIALS = ['o2m', 'm2m', 'm2a', 'files', 'file', 'alias', 'translations']

function opts(f: MetaField): Record<string, unknown> {
  if (f.options && typeof f.options === 'object') return f.options
  if (typeof f.options === 'string') {
    try {
      return JSON.parse(f.options) ?? {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Header fields a split would copy before any are switched off (the Duplicate rules). */
export function copyableFields(fields: MetaField[]): MetaField[] {
  return fields.filter((f) => {
    const special = (f.special ?? []).map(String)
    if (AUDIT.has(f.field) || special.some((s) => s.endsWith('-created') || s.endsWith('-updated')))
      return false
    if (special.some((s) => LIST_SPECIALS.includes(s))) return false
    if (f.hidden || f.readonly || f.computed_type) return false
    const o = opts(f)
    return !o.auto_id && !o.no_duplicate
  })
}

/** Lists that keep a log of the record rather than lines of it (notes, partner logs, queues). */
const LOG_LIST_RE =
  /(^|_)(notes?|logs?|queues?|history|histories|activity|comments?|events?|audits?)(_|$)/i

/** True for a one-to-many list that is a log, not order lines. Exported for tests. */
export function isLogList(collection: string, field: string | null): boolean {
  return LOG_LIST_RE.test(collection) || (!!field && LOG_LIST_RE.test(field))
}

/** "Notes · Notes" → "Notes": the collection is named only when it says something new. */
export function listChipLabel(
  fieldLabel: string,
  collection: string
): {
  label: string
  of: string | null
} {
  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  const of = titleCase(collection.replace(/_/g, ' '))
  return { label: fieldLabel, of: squash(fieldLabel) === squash(of) ? null : of }
}

export function readLineSplit(bc: Record<string, unknown> | null | undefined): LineSplitDraft {
  const raw = (bc?.line_split ?? null) as Record<string, unknown> | null
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  return {
    enabled: raw?.enabled === true,
    relations: list(raw?.relations),
    skip_fields: list(raw?.skip_fields),
    link_field: typeof raw?.link_field === 'string' && raw.link_field ? raw.link_field : null,
    copy_links: raw?.copy_links !== false
  }
}

/** The browser_config to store: other keys kept, the split key minimal (absent when off and empty). */
export function withLineSplit(
  bc: Record<string, unknown> | null | undefined,
  d: LineSplitDraft
): Record<string, unknown> | null {
  const { line_split: _old, ...rest } = bc ?? {}
  const empty = !d.enabled && d.relations.length === 0 && d.skip_fields.length === 0
  const next: Record<string, unknown> = { ...rest }
  if (!empty)
    next.line_split = {
      enabled: d.enabled,
      relations: d.relations,
      ...(d.skip_fields.length ? { skip_fields: d.skip_fields } : {}),
      ...(d.link_field ? { link_field: d.link_field } : {}),
      ...(d.copy_links ? {} : { copy_links: false })
    }
  return Object.keys(next).length > 0 ? next : null
}

export function LineSplitCard({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: meta } = useQuery({
    queryKey: queryKeys.collectionMeta(tableName),
    queryFn: () => api.get<{ data: Meta }>(`/collections/${tableName}`).then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })
  const save = useMutation({
    mutationFn: (d: LineSplitDraft) =>
      api.patch(`/collections/${tableName}`, {
        browser_config: withLineSplit(meta?.browser_config, d)
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.collectionMeta(tableName) })
      toast.success('Split setting saved')
    },
    onError: (err) => toastError(err, 'The split setting could not be saved')
  })
  if (!meta) return null

  const cfg = readLineSplit(meta.browser_config)
  const fields = meta.fields ?? []
  const labelOf = (name: string) => fields.find((f) => f.field === name)?.label || titleCase(name)
  const lineLists = (meta.relations ?? []).filter(
    (r) => r.one_collection === tableName && !!r.one_field && r.junction_field == null
  )
  const copyable = copyableFields(fields)
  const selfLinks = (meta.relations ?? []).filter(
    (r) =>
      r.many_collection === tableName &&
      r.one_collection === tableName &&
      r.junction_field == null &&
      r.many_field !== 'id'
  )
  const noun = (meta.singular || 'record').toLowerCase()
  const busy = save.isPending
  const set = (patch: Partial<LineSplitDraft>) => save.mutate({ ...cfg, ...patch })
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  // Order lines first; logs (notes, partner logs, queues) fold into a quieter row below —
  // unless one is already switched on, which keeps its place with the lines.
  const isOn = (r: MetaRelation) => cfg.relations.includes(`${r.many_collection}.${r.many_field}`)
  const lines = lineLists.filter((r) => isOn(r) || !isLogList(r.many_collection, r.one_field))
  const logs = lineLists.filter((r) => !lines.includes(r))
  const relationChip = (r: MetaRelation) => {
    const key = `${r.many_collection}.${r.many_field}`
    const on = cfg.relations.includes(key)
    const chip = listChipLabel(labelOf(r.one_field ?? ''), r.many_collection)
    return (
      <button
        key={key}
        type='button'
        disabled={busy}
        aria-pressed={on}
        onClick={() => set({ relations: toggle(cfg.relations, key) })}
        data-line-split-relation={key}
        data-tip={chip.of ? `${chip.label} · ${chip.of}` : undefined}
        className={cn(
          'inline-flex max-w-[260px] items-center whitespace-nowrap rounded-md border px-2.5 py-1 text-[12px] transition-colors',
          on
            ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
            : 'border-slate-200 text-slate-600 hover:border-slate-400 dark:border-border dark:text-slate-300'
        )}
      >
        <span className='truncate'>{chip.label}</span>
        {chip.of && (
          <span className='ml-1 truncate text-slate-500 dark:text-slate-400'>· {chip.of}</span>
        )}
      </button>
    )
  }

  return (
    <div
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-line-split-card
    >
      <div className='flex items-start justify-between gap-4 border-b border-slate-100 px-4 py-3 dark:border-border'>
        <div className='min-w-0'>
          <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
            Move lines to a new {noun}
          </p>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            People tick some lines on a {noun} and move them to a new one: the details are copied,
            the lines move with their history, and both get a note naming the other. Useful when
            part ships now and the rest later. Off by default.
          </p>
        </div>
        <Switch
          checked={cfg.enabled}
          disabled={busy || lineLists.length === 0}
          onCheckedChange={(v) =>
            set({
              enabled: v,
              relations:
                v && cfg.relations.length === 0 && lineLists.length === 1
                  ? [`${lineLists[0].many_collection}.${lineLists[0].many_field}`]
                  : cfg.relations
            })
          }
          aria-label='Allow moving lines to a new record'
          data-line-split-switch
        />
      </div>
      {lineLists.length === 0 ? (
        <p className='px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          This collection has no line lists (one-to-many fields), so there is nothing to split.
        </p>
      ) : (
        <div
          className={cn(
            'divide-y divide-slate-100 dark:divide-border',
            !cfg.enabled && 'opacity-60'
          )}
        >
          <div className='px-4 py-3'>
            <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
              Lines that can move
            </p>
            <div className='mt-2 flex flex-wrap gap-1.5'>{lines.map((r) => relationChip(r))}</div>
            {logs.length > 0 && (
              <div className='mt-2.5'>
                <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  Also offered — these keep a log of the {noun} rather than its lines:
                </p>
                <div className='mt-1.5 flex flex-wrap gap-1.5'>
                  {logs.map((r) => relationChip(r))}
                </div>
              </div>
            )}
            {cfg.enabled && cfg.relations.length === 0 && (
              <p className='mt-2 text-[11.5px] text-amber-700 dark:text-amber-300'>
                Pick at least one list — until then nobody can move lines.
              </p>
            )}
          </div>
          <div className='px-4 py-3'>
            <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
              Details copied to the new {noun}
            </p>
            <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              The same fields More → Duplicate copies. Click one to leave it behind (a partner’s
              status, an order number) — it shows struck through. Generated ids, hidden, read-only
              and “do not duplicate” fields never copy, and the new {noun} starts at the first step.
            </p>
            <div className='mt-2 flex flex-wrap gap-1.5'>
              {copyable.map((f) => {
                const left = cfg.skip_fields.includes(f.field)
                return (
                  <button
                    key={f.field}
                    type='button'
                    disabled={busy}
                    aria-pressed={!left}
                    onClick={() => set({ skip_fields: toggle(cfg.skip_fields, f.field) })}
                    data-line-split-field={f.field}
                    data-tip={left ? 'Not copied — click to copy it' : 'Copied — click to leave it'}
                    className={cn(
                      'max-w-[240px] truncate whitespace-nowrap rounded-md border px-2 py-0.5 text-[11.5px] transition-colors',
                      left
                        ? 'border-dashed border-slate-300 bg-transparent text-slate-500 line-through decoration-slate-400 hover:border-slate-400 dark:border-slate-600 dark:text-slate-400 dark:decoration-slate-500'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-400 dark:border-border dark:bg-muted/40 dark:text-slate-200'
                    )}
                  >
                    {f.label || titleCase(f.field)}
                  </button>
                )
              })}
            </div>
          </div>
          <div className='flex items-center justify-between gap-4 px-4 py-3'>
            <div>
              <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                Copy linked lists
              </p>
              <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                Many-to-many values (zones, years, people) come along too. Files never do.
              </p>
            </div>
            <Switch
              checked={cfg.copy_links}
              disabled={busy}
              onCheckedChange={(v) => set({ copy_links: v })}
              aria-label='Copy linked lists'
            />
          </div>
          {selfLinks.length > 0 && (
            <div className='flex flex-wrap items-center justify-between gap-3 px-4 py-3'>
              <div>
                <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                  “Split from” field
                </p>
                <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  Optional: a link on the new {noun} that points back to the one it came from.
                </p>
              </div>
              <SimpleSelect
                value={cfg.link_field ?? ''}
                onChange={(v) => set({ link_field: v || null })}
                ariaLabel='Split from field'
                className='h-8 w-[200px] text-[12px]'
                options={[
                  { value: '', label: 'None' },
                  ...selfLinks.map((r) => ({ value: r.many_field, label: labelOf(r.many_field) }))
                ]}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
