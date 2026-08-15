import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Copy, GripVertical, Plus, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api, type CMSField, type CMSRelation } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/**
 * Build the collection browser's quick-filter bar without writing JSON.
 *
 * The stored shape is unchanged (QuickFilterDef[]) — this only replaces the
 * textarea, so anything already configured keeps working and the raw editor
 * stays available for a shape this UI does not yet know about.
 *
 * The one piece worth explaining is the PATH. It is how the server reaches the
 * filtered value from this collection, and it walks relations: ['funding_years']
 * is an alias hop onto the junction, ['project', 'project_type'] follows two
 * M2O columns. Getting that wrong silently returns everything, so the picker
 * offers real fields and relations rather than a free-text box, and each hop
 * knows what collection it landed in — which is also where the options list and
 * its label column come from.
 */

export interface QuickFilterDef {
  key: string
  label: string
  path: string[]
  or_paths?: string[][]
  collection: string
  value_field?: string
  label_field: string
  sort?: string
}

interface CollectionMeta {
  fields: CMSField[]
  relations: CMSRelation[]
}

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** One hop the path can take from `collection`, and where it lands. */
interface Hop {
  field: string
  label: string
  target: string | null
  kind: 'm2o' | 'alias' | 'column'
}

function useCollectionMeta(collection: string | null) {
  return useQuery<CollectionMeta | null>({
    queryKey: ['qf-collection-meta', collection],
    queryFn: () =>
      api
        .get<{ data: CollectionMeta }>(`/collections/${collection}`)
        .then((r) => r.data.data)
        .catch(() => null),
    enabled: !!collection,
    staleTime: 5 * 60 * 1000
  })
}

/**
 * Hops out of a collection: M2O columns (follow the FK), alias relations
 * (o2m/m2m — the junction hop a quick filter usually wants), and plain columns
 * as a terminal choice.
 */
function hopsFor(meta: CollectionMeta | null | undefined, collection: string): Hop[] {
  if (!meta) return []
  const out: Hop[] = []
  const seen = new Set<string>()

  for (const r of meta.relations ?? []) {
    if (r.many_collection === collection && r.one_collection && !r.junction_field) {
      if (seen.has(r.many_field)) continue
      seen.add(r.many_field)
      out.push({ field: r.many_field, label: r.many_field, target: r.one_collection, kind: 'm2o' })
    }
    if (r.one_collection === collection && r.one_field) {
      if (seen.has(r.one_field)) continue
      seen.add(r.one_field)
      // For a junction the useful target is the junction table itself: that is
      // what the server's alias hop compares against.
      out.push({
        field: r.one_field,
        label: r.one_field,
        target: r.many_collection,
        kind: 'alias'
      })
    }
  }

  for (const f of meta.fields ?? []) {
    if (seen.has(f.field)) continue
    if (f.field.startsWith('__')) continue
    seen.add(f.field)
    out.push({ field: f.field, label: f.field, target: null, kind: 'column' })
  }

  return out.sort((a, b) => {
    const rank = (h: Hop) => (h.kind === 'alias' ? 0 : h.kind === 'm2o' ? 1 : 2)
    return rank(a) - rank(b) || a.field.localeCompare(b.field)
  })
}

/** A path is a chain of hops; each select is populated by where the last one landed. */
function PathBuilder({
  rootCollection,
  path,
  onChange,
  onTargetChange
}: {
  rootCollection: string
  path: string[]
  onChange: (next: string[]) => void
  onTargetChange?: (target: string | null) => void
}) {
  // Meta for the root plus every collection the path passes through. Hooks
  // cannot be called in a loop, so this supports paths up to three hops —
  // deeper than any real quick filter, and the raw editor covers the rest.
  const rootMeta = useCollectionMeta(rootCollection)
  const hops0 = hopsFor(rootMeta.data, rootCollection)
  const hop0 = hops0.find((h) => h.field === path[0])
  const c1 = hop0?.target ?? null

  const meta1 = useCollectionMeta(c1)
  const hops1 = c1 ? hopsFor(meta1.data, c1) : []
  const hop1 = hops1.find((h) => h.field === path[1])
  const c2 = hop1?.target ?? null

  const meta2 = useCollectionMeta(c2)
  const hops2 = c2 ? hopsFor(meta2.data, c2) : []
  const hop2 = hops2.find((h) => h.field === path[2])

  // Where the path ends up — the natural source for the options list.
  const landed = path.length >= 3 ? (hop2?.target ?? c2) : path.length === 2 ? c2 : c1
  const emit = (next: string[]) => {
    onChange(next)
    const h0 = hops0.find((h) => h.field === next[0])
    const t1 = h0?.target ?? null
    if (next.length <= 1) return onTargetChange?.(t1)
    // Deeper targets resolve on the next render, once their meta loads.
    onTargetChange?.(landed ?? t1)
  }

  const select = (
    value: string | undefined,
    options: Hop[],
    onPick: (v: string) => void,
    placeholder: string
  ) => (
    <select
      value={value ?? ''}
      onChange={(e) => onPick(e.target.value)}
      className='h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700'
    >
      <option value=''>{placeholder}</option>
      {options.map((h) => (
        <option key={h.field} value={h.field}>
          {h.field}
          {h.kind === 'alias' ? '  (related)' : h.kind === 'm2o' ? '  →' : ''}
        </option>
      ))}
    </select>
  )

  return (
    <div className='flex flex-wrap items-center gap-1'>
      {select(path[0], hops0, (v) => emit(v ? [v] : []), rootCollection)}
      {c1 && (
        <>
          <span className='text-[11px] text-slate-400'>›</span>
          {select(
            path[1],
            hops1,
            (v) => emit(v ? [path[0], v] : [path[0]]),
            `${c1} (leave blank to stop here)`
          )}
        </>
      )}
      {c2 && (
        <>
          <span className='text-[11px] text-slate-400'>›</span>
          {select(
            path[2],
            hops2,
            (v) => emit(v ? [path[0], path[1], v] : [path[0], path[1]]),
            `${c2} (optional)`
          )}
        </>
      )}
    </div>
  )
}

function FieldSelect({
  collection,
  value,
  onChange,
  placeholder,
  allowBlank = true
}: {
  collection: string
  value: string | undefined
  onChange: (v: string) => void
  placeholder: string
  allowBlank?: boolean
}) {
  const meta = useCollectionMeta(collection || null)
  const fields = (meta.data?.fields ?? []).filter((f) => !f.field.startsWith('__'))
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className='h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700'
    >
      {allowBlank && <option value=''>{placeholder}</option>}
      {fields.map((f) => (
        <option key={f.field} value={f.field}>
          {f.field}
        </option>
      ))}
      {/* A configured value the collection no longer has must stay visible
          rather than silently resetting to blank. */}
      {value && !fields.some((f) => f.field === value) && (
        <option value={value}>{value} (missing)</option>
      )}
    </select>
  )
}

export function QuickFiltersEditor({
  collection,
  value,
  onChange
}: {
  collection: string
  value: QuickFilterDef[]
  onChange: (next: QuickFilterDef[]) => void
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [rawDraft, setRawDraft] = useState('')
  const [rawError, setRawError] = useState('')

  const update = (i: number, partial: Partial<QuickFilterDef>) =>
    onChange(value.map((f, idx) => (idx === i ? { ...f, ...partial } : f)))

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return
    const next = [...value]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    onChange(next)
    setOpenIdx(openIdx === from ? to : openIdx)
  }

  // Duplicate keys silently merge two filters' selections into one, so they are
  // surfaced rather than left to be discovered as odd filtering behaviour.
  const duplicateKeys = useMemo(() => {
    const seen = new Map<string, number>()
    const dupes = new Set<string>()
    for (const f of value) {
      const k = (f.key ?? '').trim()
      if (!k) continue
      seen.set(k, (seen.get(k) ?? 0) + 1)
      if ((seen.get(k) ?? 0) > 1) dupes.add(k)
    }
    return dupes
  }, [value])

  const problems = (f: QuickFilterDef): string[] => {
    const out: string[] = []
    if (!f.key?.trim()) out.push('needs a key')
    else if (duplicateKeys.has(f.key.trim())) out.push('duplicate key')
    if (!f.label?.trim()) out.push('needs a label')
    if (!f.path?.length && !(f.or_paths?.length && f.or_paths.every((p) => p.length))) {
      out.push('needs a field path')
    }
    if (!f.collection?.trim()) out.push('needs an options collection')
    if (!f.label_field?.trim()) out.push('needs a label column')
    return out
  }

  const addFilter = () =>
    onChange([
      ...value,
      { key: '', label: '', path: [], collection: '', label_field: '', value_field: 'id' }
    ])

  return (
    <div className='space-y-2'>
      {value.length === 0 && (
        <p className='rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-[12px] text-slate-400'>
          No quick filters. The browser shows the search box and Add Filter only.
        </p>
      )}

      {value.map((f, i) => {
        const issues = problems(f)
        const open = openIdx === i
        return (
          <div
            key={i}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx !== null) move(dragIdx, i)
              setDragIdx(null)
            }}
            onDragEnd={() => setDragIdx(null)}
            className={cn(
              'rounded-lg border bg-white',
              issues.length > 0 ? 'border-amber-300' : 'border-slate-200',
              dragIdx === i && 'opacity-50'
            )}
          >
            <div className='flex items-center gap-2 px-2 py-1.5'>
              <GripVertical className='h-3.5 w-3.5 shrink-0 cursor-grab text-slate-300' />
              <button
                type='button'
                onClick={() => setOpenIdx(open ? null : i)}
                className='flex min-w-0 flex-1 items-center gap-1.5 text-left'
              >
                {open ? (
                  <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                ) : (
                  <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                )}
                <span className='truncate text-[12.5px] font-medium text-slate-700'>
                  {f.label?.trim() || <span className='text-slate-400'>Untitled filter</span>}
                </span>
                <span className='truncate font-mono text-[11px] text-slate-400'>
                  {(f.or_paths?.length ? f.or_paths.map((p) => p.join('.')).join('  or  ') : f.path?.join('.')) ||
                    '—'}
                </span>
              </button>
              {issues.length > 0 && (
                <span className='shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700'>
                  {issues[0]}
                </span>
              )}
              <button
                type='button'
                title='Move up'
                onClick={() => move(i, i - 1)}
                className='rounded px-1 text-[11px] text-slate-400 hover:text-slate-700'
              >
                ↑
              </button>
              <button
                type='button'
                title='Move down'
                onClick={() => move(i, i + 1)}
                className='rounded px-1 text-[11px] text-slate-400 hover:text-slate-700'
              >
                ↓
              </button>
              <button
                type='button'
                title='Duplicate'
                onClick={() =>
                  onChange([
                    ...value.slice(0, i + 1),
                    { ...f, key: f.key ? `${f.key}_copy` : '' },
                    ...value.slice(i + 1)
                  ])
                }
                className='rounded px-1 text-slate-400 hover:text-slate-700'
              >
                <Copy className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                title='Remove'
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                className='rounded px-1 text-slate-400 hover:text-red-600'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </div>

            {open && (
              <div className='space-y-2.5 border-t border-slate-100 px-3 py-2.5'>
                <div className='grid grid-cols-2 gap-2'>
                  <div>
                    <Label className='text-[11px] text-slate-500'>Label</Label>
                    <Input
                      value={f.label ?? ''}
                      placeholder='Funding Year'
                      onChange={(e) => {
                        const label = e.target.value
                        // Key follows the label until someone edits it, which
                        // is what makes this usable without explaining keys.
                        const autoKey = !f.key || f.key === slug(f.label ?? '')
                        update(i, autoKey ? { label, key: slug(label) } : { label })
                      }}
                      className='h-7 text-[12px]'
                    />
                  </div>
                  <div>
                    <Label className='text-[11px] text-slate-500'>Key</Label>
                    <Input
                      value={f.key ?? ''}
                      placeholder='fy'
                      onChange={(e) => update(i, { key: slug(e.target.value) })}
                      className='h-7 font-mono text-[12px]'
                    />
                  </div>
                </div>

                <div>
                  <Label className='text-[11px] text-slate-500'>Field path</Label>
                  <p className='mb-1 text-[10.5px] text-slate-400'>
                    How the server reaches the value from {collection}. Related fields hop through
                    the relation; follow an arrow to filter on a deeper field.
                  </p>
                  <PathBuilder
                    rootCollection={collection}
                    path={f.path ?? []}
                    onChange={(path) => update(i, { path })}
                    onTargetChange={(target) => {
                      // Fill the options source once, from where the path
                      // landed — the answer is right almost every time and is
                      // still editable below.
                      if (target && !f.collection) update(i, { collection: target })
                    }}
                  />
                </div>

                <div className='grid grid-cols-3 gap-2'>
                  <div>
                    <Label className='text-[11px] text-slate-500'>Options from</Label>
                    <Input
                      value={f.collection ?? ''}
                      placeholder='funding_years'
                      onChange={(e) => update(i, { collection: e.target.value.trim() })}
                      className='h-7 font-mono text-[12px]'
                    />
                  </div>
                  <div>
                    <Label className='text-[11px] text-slate-500'>Label column</Label>
                    <FieldSelect
                      collection={f.collection ?? ''}
                      value={f.label_field}
                      onChange={(v) => update(i, { label_field: v })}
                      placeholder='choose…'
                    />
                  </div>
                  <div>
                    <Label className='text-[11px] text-slate-500'>Value column</Label>
                    <FieldSelect
                      collection={f.collection ?? ''}
                      value={f.value_field ?? 'id'}
                      onChange={(v) => update(i, { value_field: v || undefined })}
                      placeholder='id (default)'
                    />
                  </div>
                </div>

                <div className='grid grid-cols-2 gap-2'>
                  <div>
                    <Label className='text-[11px] text-slate-500'>Option order</Label>
                    <div className='flex gap-1'>
                      <div className='flex-1'>
                        <FieldSelect
                          collection={f.collection ?? ''}
                          value={(f.sort ?? '').replace(/^-/, '')}
                          onChange={(v) =>
                            update(i, {
                              sort: v ? ((f.sort ?? '').startsWith('-') ? `-${v}` : v) : undefined
                            })
                          }
                          placeholder='default'
                        />
                      </div>
                      <button
                        type='button'
                        disabled={!f.sort}
                        onClick={() =>
                          update(i, {
                            sort: f.sort?.startsWith('-')
                              ? f.sort.slice(1)
                              : `-${f.sort ?? ''}`
                          })
                        }
                        className='h-7 rounded-md border border-slate-200 px-2 text-[11px] text-slate-600 disabled:opacity-40'
                      >
                        {f.sort?.startsWith('-') ? 'Desc' : 'Asc'}
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <div className='flex items-center justify-between'>
                    <Label className='text-[11px] text-slate-500'>
                      Match any of these paths (optional)
                    </Label>
                    <button
                      type='button'
                      onClick={() =>
                        update(i, { or_paths: [...(f.or_paths ?? []), f.path?.length ? [...f.path] : []] })
                      }
                      className='text-[11px] text-nvr-navy hover:underline'
                    >
                      + add path
                    </button>
                  </div>
                  <p className='mb-1 text-[10.5px] text-slate-400'>
                    For a value reachable two ways — project.project_type OR car_project_type. When
                    set, these replace the single path above.
                  </p>
                  {(f.or_paths ?? []).map((p, pi) => (
                    <div key={pi} className='mb-1 flex items-center gap-1'>
                      <PathBuilder
                        rootCollection={collection}
                        path={p}
                        onChange={(next) =>
                          update(i, {
                            or_paths: (f.or_paths ?? []).map((x, xi) => (xi === pi ? next : x))
                          })
                        }
                      />
                      <button
                        type='button'
                        onClick={() =>
                          update(i, {
                            or_paths: (f.or_paths ?? []).filter((_, xi) => xi !== pi)
                          })
                        }
                        className='rounded px-1 text-slate-400 hover:text-red-600'
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}

      <div className='flex items-center gap-2'>
        <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={addFilter}>
          <Plus className='mr-1 h-3.5 w-3.5' />
          Add filter
        </Button>
        <button
          type='button'
          onClick={() => {
            setRawDraft(JSON.stringify(value, null, 2))
            setRawError('')
            setShowRaw((v) => !v)
          }}
          className='text-[11px] text-slate-500 hover:text-slate-800 hover:underline'
        >
          {showRaw ? 'Hide JSON' : 'Edit as JSON'}
        </button>
      </div>

      {showRaw && (
        <div>
          {/* The escape hatch stays: this UI knows the shape as it is today, and
              a config it cannot express should still be editable. */}
          <Textarea
            value={rawDraft}
            onChange={(e) => setRawDraft(e.target.value)}
            rows={8}
            className='font-mono text-[11.5px]'
          />
          {rawError && <p className='text-[11px] text-red-500'>{rawError}</p>}
          <Button
            size='sm'
            variant='outline'
            className='mt-1 h-7 text-[12px]'
            onClick={() => {
              try {
                const parsed = JSON.parse(rawDraft || '[]')
                if (!Array.isArray(parsed)) throw new Error('not an array')
                setRawError('')
                onChange(parsed)
              } catch {
                setRawError('Invalid JSON — must be an array of quick-filter objects')
              }
            }}
          >
            Apply JSON
          </Button>
        </div>
      )}
    </div>
  )
}
