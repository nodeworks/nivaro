import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookmarkCheck, Check, ChevronsUpDown, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ParentDraftContext, useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, put } from '../../lib/commands'
import { cascadeParents, isEmptyValue } from '../../lib/personal-defaults'
import { userErrorMessage } from '../../lib/safe-error'
import { cn, formatDate, titleCase } from '../../lib/utils'
import { FieldRenderer } from '../item-edit/FieldRenderer'
import { buildCascadeFilter, getCascadeFilters } from '../item-edit/helpers'
import { M2MStagingContext, type M2MStagingCtx } from '../item-edit/M2MStagingContext'
import { pickedCollection } from '../item-edit/personal-default-checks'
import type { CMSField, CMSRelation } from '../item-edit/types'
import { personalDefaultsKey } from '../item-edit/usePersonalDefaults'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { describeValue, labelKey, loadDefaultLabels, type ValuePart } from './my-defaults-labels'
import { ConfirmButton, EmptyLine, Pill, SectionCard } from './primitives'

/**
 * Profile → My defaults (spec 2026-10-28-personal-field-defaults): the starting values a
 * person keeps for new records, grouped by collection — the value and its context ("for
 * Zone 2 · Boston") as labels read as the viewer, Change through the field's own control
 * (same picker, option filter and cascade, narrowed by the saved context) and Clear. A row
 * whose field no form allows any more says so and offers only Clear. An administrator sees
 * the same card on anyone's people page (`userId`), and can add one; every save there is
 * judged as that person by the API.
 */

type DefaultRow = {
  id: number
  collection: string
  field: string
  value: unknown
  context: Record<string, unknown>
  updated_at: string
  updated_by: string | null
  on_layout?: boolean
}

type AllowedCollection = { collection: string; label: string | null; fields: string[] }

type CollectionMeta = {
  fields: CMSField[]
  relations: CMSRelation[]
  label: string
  ready: boolean
}

const EMPTY_META: CollectionMeta = { fields: [], relations: [], label: '', ready: false }

/** The form's own metadata reads (same keys and shapes), one set per collection. */
function useCollectionMetas(collections: string[]): Map<string, CollectionMeta> {
  const client = useNivaroClient()
  const fieldQs = useQueries({
    queries: collections.map((c) => ({
      queryKey: ['field-config', c, null],
      queryFn: () =>
        client.request<{ data: CMSField[] }>(get(`/field-config/${c}`)).then((r) => r.data ?? []),
      staleTime: 60_000
    }))
  })
  const relQs = useQueries({
    queries: collections.map((c) => ({
      queryKey: ['relations', c],
      queryFn: () =>
        client
          .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${c}`))
          .then((r) => r.data ?? []),
      staleTime: 60_000
    }))
  })
  const colQs = useQueries({
    queries: collections.map((c) => ({
      queryKey: ['col-meta', c],
      queryFn: () =>
        client
          .request<{ data: { display_name?: string | null } | null }>(get(`/collections/${c}`))
          .then((r) => r.data ?? null),
      staleTime: 60_000
    }))
  })
  const out = new Map<string, CollectionMeta>()
  collections.forEach((c, i) => {
    const name = (colQs[i]?.data as { display_name?: string | null } | null)?.display_name
    out.set(c, {
      fields: (fieldQs[i]?.data as CMSField[] | undefined) ?? [],
      relations: (relQs[i]?.data as CMSRelation[] | undefined) ?? [],
      label: name?.trim() ? name : titleCase(c),
      ready: !fieldQs[i]?.isPending && !relQs[i]?.isPending
    })
  })
  return out
}

function fieldLabel(meta: CollectionMeta, field: string): string {
  const fc = meta.fields.find((f) => f.field === field)
  return fc?.label?.trim() ? fc.label : titleCase(field)
}

/** Context parents farthest first (Zone · Region), unknown keys after, in stored order. */
function orderedContext(meta: CollectionMeta, row: DefaultRow): string[] {
  const keys = Object.keys(row.context ?? {}).filter((k) => !isEmptyValue(row.context[k]))
  const byName = new Map(meta.fields.map((f) => [f.field, f]))
  const chain = cascadeParents(row.field, (f) =>
    getCascadeFilters(byName.get(f)?.dependency_config ?? null)
  ).reverse()
  const known = chain.filter((k) => keys.includes(k))
  return [...known, ...keys.filter((k) => !known.includes(k))]
}

type Labels = { map: Map<string, string | null>; loading: boolean; failed: boolean }

/** What a stored value reads as: a label, a loading state, or a plain statement — never a key. */
function partText(
  part: ValuePart,
  labels: Labels
): { text: string; state: 'ok' | 'gone' | 'failed' | 'loading' } {
  if (part.kind === 'text') return { text: part.text, state: 'ok' }
  if (part.kind === 'unknown') return { text: 'Saved value', state: 'ok' }
  if (labels.loading) return { text: '', state: 'loading' }
  if (labels.failed) return { text: 'Could not load this value', state: 'failed' }
  const shown: string[] = []
  let missing = 0
  for (const id of part.ids) {
    const k = labelKey(part.target, id)
    if (!labels.map.has(k)) missing++
    else shown.push(labels.map.get(k) ?? 'Untitled record')
  }
  if (shown.length === 0) return { text: 'No longer available', state: 'gone' }
  if (missing) shown.push(`${missing} no longer available`)
  return { text: shown.join(', '), state: 'ok' }
}

function refusalText(err: unknown): string {
  const e = err as { response?: { data?: { error?: unknown } }; error?: unknown } | null
  const raw = e?.response?.data?.error ?? e?.error
  return typeof raw === 'string' && raw.trim() ? raw : userErrorMessage(err, 'Could not save')
}

export function MyDefaultsCard({ userId, name }: { userId?: string; name?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const auth = useItemEditAuth()
  const forOther = !!userId && String(userId).toUpperCase() !== String(auth.userId).toUpperCase()
  // Non-admins never see another person's defaults (the API refuses too).
  const allowedHere = !forOther || auth.isAdmin
  const base = forOther
    ? `/field-defaults/users/${encodeURIComponent(String(userId))}`
    : '/field-defaults/mine'
  const who = forOther ? String(userId) : 'me'

  const listKey = ['field-defaults-card', who] as const
  const {
    data: rows,
    isPending,
    isError
  } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      client.request<{ data: DefaultRow[] }>(get(base, { on_layout: 1 })).then((r) => r.data ?? []),
    enabled: allowedHere,
    staleTime: 30_000
  })
  const { data: allowed } = useQuery({
    queryKey: ['field-defaults-allowed', who],
    queryFn: () =>
      client
        .request<{ data: AllowedCollection[] }>(get(`${base}/allowed`))
        .then((r) => r.data ?? []),
    enabled: allowedHere,
    staleTime: 60_000
  })

  const [adding, setAdding] = useState(false)
  const [addCollection, setAddCollection] = useState('')
  const collections = useMemo(() => {
    const set = new Set((rows ?? []).map((r) => r.collection))
    if (addCollection) set.add(addCollection)
    return [...set]
  }, [rows, addCollection])
  const metas = useCollectionMetas(collections)
  const metasReady = collections.every((c) => metas.get(c)?.ready)

  // Every value and context part, then one label read per related collection.
  const parts = useMemo(() => {
    const out = new Map<string, { value: ValuePart; context: Array<[string, ValuePart]> }>()
    if (!metasReady) return out
    for (const r of rows ?? []) {
      const meta = metas.get(r.collection) ?? EMPTY_META
      const fc = (f: string) => meta.fields.find((x) => x.field === f)
      out.set(String(r.id), {
        value: describeValue(fc(r.field), meta.relations, r.collection, r.value),
        context: orderedContext(meta, r).map((k) => [
          k,
          describeValue(fc(k), meta.relations, r.collection, r.context[k])
        ])
      })
    }
    return out
  }, [rows, metas, metasReady])
  const byTarget = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of parts.values()) {
      for (const part of [p.value, ...p.context.map(([, v]) => v)]) {
        if (part.kind !== 'records') continue
        m.set(part.target, [...new Set([...(m.get(part.target) ?? []), ...part.ids])].sort())
      }
    }
    return m
  }, [parts])
  const labelSig = [...byTarget]
    .map(([t, ids]) => `${t}:${ids.join(',')}`)
    .sort()
    .join('|')
  const {
    data: labelMap,
    isPending: labelsPending,
    isError: labelsFailed
  } = useQuery({
    queryKey: ['field-defaults-card-labels', labelSig],
    queryFn: () =>
      loadDefaultLabels(client, byTarget, (t) =>
        qc
          .fetchQuery({
            queryKey: ['col-meta', t],
            queryFn: () =>
              client
                .request<{ data: { display_template?: string | null } | null }>(
                  get(`/collections/${t}`)
                )
                .then((r) => r.data ?? null),
            staleTime: 60_000
          })
          .then((d) => (d as { display_template?: string | null } | null)?.display_template ?? null)
      ),
    enabled: metasReady && byTarget.size > 0,
    staleTime: 60_000
  })
  const labels: Labels = {
    map: labelMap ?? new Map(),
    loading: byTarget.size > 0 && !labelsFailed && (!metasReady || labelsPending),
    failed: labelsFailed
  }

  const refresh = (collection?: string) => {
    void qc.invalidateQueries({ queryKey: listKey })
    // The form's own cache of the viewer's defaults (another person's never sits there).
    if (!forOther && collection)
      void qc.invalidateQueries({ queryKey: personalDefaultsKey(collection) })
  }

  const clear = useMutation({
    mutationFn: (row: DefaultRow) => client.request(del(`${base}/${row.id}`)),
    onSuccess: (_d, row) => {
      refresh(row.collection)
      toast.success('Default cleared')
    },
    onError: (err) => toast.error(refusalText(err))
  })

  if (!allowedHere) return null
  // Own page: nothing saved and no form offers a default → the card has nothing to teach.
  if (!forOther && rows?.length === 0 && allowed?.length === 0) return null

  const groups = [...new Set((rows ?? []).map((r) => r.collection))]
    .map((c) => ({ collection: c, label: metas.get(c)?.label || titleCase(c) }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const firstName = name?.trim() || 'This person'
  return (
    <SectionCard
      icon={<BookmarkCheck className='h-4 w-4' />}
      title={forOther ? 'Personal defaults' : 'My defaults'}
      hint={
        forOther
          ? 'Starting values their new records are filled in with'
          : 'Starting values your new records are filled in with'
      }
      testId='my-defaults'
      actions={
        forOther && !adding && (allowed?.length ?? 0) > 0 ? (
          <button
            type='button'
            data-default-add
            onClick={() => setAdding(true)}
            className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-300 dark:hover:text-white'
          >
            <Plus className='h-3.5 w-3.5' /> Add default
          </button>
        ) : null
      }
    >
      {isPending ? (
        <div className='space-y-3' aria-busy='true'>
          {[0, 1, 2].map((i) => (
            <div key={i} className='flex items-center gap-3'>
              <Skeleton className='h-3.5 w-24' />
              <Skeleton className='h-3.5 w-40' />
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyLine>Could not load the saved defaults. Reload the page to try again.</EmptyLine>
      ) : (rows ?? []).length === 0 ? (
        <p data-default-empty className='text-[12px] text-slate-500 dark:text-slate-400'>
          {forOther ? `${firstName} has no saved defaults yet.` : 'No defaults yet.'} On a record
          form, open a field’s ⋯ menu and choose{' '}
          <span className='font-medium text-slate-700 dark:text-slate-200'>Save as my default</span>
          {forOther ? ' — or add one here.' : ' — new records then start with that value.'}
        </p>
      ) : (
        <div className='space-y-4'>
          {groups.map((g) => (
            <section key={g.collection} data-default-group={g.collection}>
              <h4 className='mb-1 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
                {g.label}
              </h4>
              <ul className='divide-y divide-slate-100 dark:divide-border/60'>
                {(rows ?? [])
                  .filter((r) => r.collection === g.collection)
                  .map((r) => (
                    <DefaultRowItem
                      key={r.id}
                      row={r}
                      meta={metas.get(r.collection) ?? EMPTY_META}
                      parts={parts.get(String(r.id))}
                      labels={labels}
                      base={base}
                      onSaved={() => refresh(r.collection)}
                      onClear={() => clear.mutate(r)}
                      clearing={clear.isPending && clear.variables?.id === r.id}
                    />
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {forOther && allowed?.length === 0 && (
        <p className='mt-3 text-[11.5px] text-slate-500 dark:text-slate-400'>
          No form gives {name?.trim() ? firstName : 'this person'} a personal default yet. Turn on
          Personal default for a field in the layout editor.
        </p>
      )}
      {forOther && adding && (
        <AddDefault
          allowed={allowed ?? []}
          metas={metas}
          collection={addCollection}
          onCollection={setAddCollection}
          base={base}
          onDone={() => {
            setAdding(false)
            setAddCollection('')
          }}
          onSaved={(c) => refresh(c)}
        />
      )}
    </SectionCard>
  )
}

// ─── One saved default ───────────────────────────────────────────────────────

function DefaultRowItem({
  row,
  meta,
  parts,
  labels,
  base,
  onSaved,
  onClear,
  clearing
}: {
  row: DefaultRow
  meta: CollectionMeta
  parts: { value: ValuePart; context: Array<[string, ValuePart]> } | undefined
  labels: Labels
  base: string
  onSaved: () => void
  onClear: () => void
  clearing: boolean
}) {
  const [editing, setEditing] = useState(false)
  const stale = row.on_layout === false
  const fc = meta.fields.find((f) => f.field === row.field)
  const value = parts ? partText(parts.value, labels) : { text: '', state: 'loading' as const }
  const context = (parts?.context ?? []).map(([k, p]) => {
    const t = partText(p, labels)
    if (t.state === 'loading') return null
    return t.state === 'gone' || t.state === 'failed'
      ? `${fieldLabel(meta, k)} (unavailable)`
      : t.text
  })
  const contextLoading = (parts?.context ?? []).length > 0 && context.some((c) => c === null)

  return (
    <li data-default-row={row.id} className='group flex items-start gap-3 py-2'>
      <div className='min-w-0 flex-1 gap-3 sm:grid sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]'>
        <p
          data-default-field
          className='truncate pt-px text-[12px] text-slate-500 dark:text-slate-400'
        >
          {fieldLabel(meta, row.field)}
        </p>
        <div className='min-w-0'>
          {editing && fc ? (
            <DefaultEditor
              row={row}
              field={fc}
              relations={meta.relations}
              base={base}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false)
                onSaved()
              }}
            />
          ) : value.state === 'loading' ? (
            <Skeleton className='mt-0.5 h-3.5 w-32' />
          ) : (
            <p
              data-default-value
              data-tip={
                value.state === 'gone'
                  ? 'The saved record was removed, or is no longer visible to you'
                  : undefined
              }
              className={cn(
                'truncate text-[12.5px]',
                value.state === 'gone' || value.state === 'failed'
                  ? 'italic text-slate-500 dark:text-slate-400'
                  : stale
                    ? 'text-slate-500 dark:text-slate-400'
                    : 'font-medium text-slate-800 dark:text-slate-100'
              )}
            >
              {value.text}
            </p>
          )}
          <p className='mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
            {contextLoading ? (
              <Skeleton className='h-3 w-28' />
            ) : context.length > 0 ? (
              <span data-default-context>for {context.join(' · ')}</span>
            ) : null}
            {(contextLoading || context.length > 0) && <span aria-hidden>·</span>}
            <span>
              Saved {formatDate(row.updated_at)}
              {row.updated_by ? ' by an admin' : ''}
            </span>
            {stale && (
              <span data-tip='No form you can be given offers a personal default for this field now, so it is not used. Clear it, or ask an admin to turn it back on.'>
                <Pill tone='amber' testId='stale'>
                  <span data-default-stale>No longer on any form</span>
                </Pill>
              </span>
            )}
          </p>
        </div>
      </div>
      {!editing && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5 transition-opacity duration-150',
            // Reserve the slot; show on hover / keyboard focus, always on touch and when stale.
            !stale &&
              'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
          )}
        >
          {!stale && fc && (
            <button
              type='button'
              data-default-change
              aria-label={`Change the default for ${fieldLabel(meta, row.field)}`}
              data-tip='Change'
              onClick={() => setEditing(true)}
              className='rounded p-1.5 text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-400 dark:hover:text-slate-100'
            >
              <Pencil className='h-3.5 w-3.5' />
            </button>
          )}
          <ConfirmButton
            onConfirm={onClear}
            disabled={clearing}
            title={`Clear the default for ${fieldLabel(meta, row.field)}`}
            confirmLabel={
              <span data-default-clear className='px-1 text-[11.5px] font-semibold'>
                Clear?
              </span>
            }
            className='inline-flex h-7 items-center rounded px-1.5 text-slate-500 transition-colors hover:bg-muted hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 disabled:opacity-50 dark:text-slate-400 dark:hover:text-red-400'
            armedClassName='bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/15'
          >
            <span data-default-clear className='inline-flex items-center'>
              <Trash2 className='h-3.5 w-3.5' />
            </span>
          </ConfirmButton>
        </div>
      )}
    </li>
  )
}

// ─── The field's own control, outside the form ──────────────────────────────

/**
 * The control the record form draws for this field (FieldRenderer: the same picker, its
 * option filter and the cascade), narrowed by the saved context the way the form narrows it
 * by the parents' current values. A many-to-many field stages its ids here instead of in a
 * form.
 */
function DefaultValueControl({
  collection,
  field,
  relations,
  context,
  value,
  onChange
}: {
  collection: string
  field: CMSField
  relations: CMSRelation[]
  context: Record<string, unknown>
  value: unknown
  onChange: (v: unknown) => void
}) {
  const editable = useMemo(() => ({ ...field, readonly: false, hidden: false }), [field])
  const isM2M = pickedCollection(relations, collection, field.field)?.kind === 'm2m'
  const ids = useMemo(
    () => (Array.isArray(value) ? value : isEmptyValue(value) ? [] : [value]),
    [value]
  )
  const staging = useMemo<M2MStagingCtx | null>(
    () =>
      isM2M
        ? {
            getStagedLinks: () => ids,
            getStagedUnlinks: () => new Set(),
            stageLink: (_k, id) =>
              onChange(ids.some((x) => String(x) === String(id)) ? ids : [...ids, id]),
            unstageLink: (_k, id) => onChange(ids.filter((x) => String(x) !== String(id))),
            stageUnlink: () => {},
            unstageUnlink: () => {}
          }
        : null,
    [isM2M, ids, onChange]
  )
  const cascadeFilter = useMemo(
    () =>
      buildCascadeFilter({
        rules: getCascadeFilters(field.dependency_config),
        parentValue: (p) => (isEmptyValue(context[p]) ? null : context[p])
      }).filter,
    [field.dependency_config, context]
  )
  const draft = useMemo(() => ({ collection, draft: { ...context } }), [collection, context])
  const control = (
    <FieldRenderer
      field={editable}
      value={isM2M ? undefined : value}
      onChange={onChange}
      relations={relations}
      collection={collection}
      itemId='new'
      cascadeFilter={cascadeFilter}
    />
  )
  return (
    <ParentDraftContext.Provider value={draft}>
      {staging ? (
        <M2MStagingContext.Provider value={staging}>{control}</M2MStagingContext.Provider>
      ) : (
        control
      )}
    </ParentDraftContext.Provider>
  )
}

function SaveCancel({
  canSave,
  pending,
  onSave,
  onCancel
}: {
  canSave: boolean
  pending: boolean
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <span className='flex items-center gap-1.5'>
      <button
        type='button'
        onClick={onCancel}
        className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-400 dark:hover:text-slate-100'
      >
        <X className='h-3 w-3' /> Cancel
      </button>
      <button
        type='button'
        data-default-save
        disabled={!canSave || pending}
        onClick={onSave}
        className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 focus-visible:ring-offset-1 disabled:opacity-50'
      >
        <Check className='h-3 w-3' /> Save
      </button>
    </span>
  )
}

function useSaveDefault(base: string, onSaved: () => void) {
  const client = useNivaroClient()
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (body: {
      collection: string
      field: string
      value: unknown
      context: Record<string, unknown>
    }) => client.request(put(base, body)),
    onSuccess: () => {
      setError(null)
      toast.success('Default saved')
      onSaved()
    },
    onError: (err) => setError(refusalText(err))
  })
  return { save, error }
}

function DefaultEditor({
  row,
  field,
  relations,
  base,
  onCancel,
  onSaved
}: {
  row: DefaultRow
  field: CMSField
  relations: CMSRelation[]
  base: string
  onCancel: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<unknown>(row.value)
  const { save, error } = useSaveDefault(base, onSaved)
  return (
    <div className='space-y-1.5' data-default-editor>
      <DefaultValueControl
        collection={row.collection}
        field={field}
        relations={relations}
        context={row.context ?? {}}
        value={draft}
        onChange={setDraft}
      />
      {error && (
        <p role='alert' className='text-[11.5px] text-red-600 dark:text-red-400'>
          {error}
        </p>
      )}
      <SaveCancel
        canSave={!isEmptyValue(draft)}
        pending={save.isPending}
        onCancel={onCancel}
        onSave={() =>
          save.mutate({
            collection: row.collection,
            field: row.field,
            value: draft,
            context: row.context ?? {}
          })
        }
      />
    </div>
  )
}

// ─── Admin: add a default for someone ────────────────────────────────────────

function Pick({
  value,
  options,
  placeholder,
  label,
  onChange,
  testId
}: {
  value: string
  options: Array<{ value: string; label: string }>
  placeholder: string
  label: string
  onChange: (v: string) => void
  testId: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          role='combobox'
          aria-expanded={open}
          aria-label={label}
          data-default-pick={testId}
          className='flex h-8 w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[12.5px] text-slate-700 transition-colors hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:border-border dark:bg-background dark:text-slate-200 dark:hover:border-slate-600'
        >
          <span className={cn('truncate', !selected && 'text-slate-500 dark:text-slate-400')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-slate-500 dark:text-slate-400'>
              No matches
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', o.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function AddDefault({
  allowed,
  metas,
  collection,
  onCollection,
  base,
  onDone,
  onSaved
}: {
  allowed: AllowedCollection[]
  metas: Map<string, CollectionMeta>
  collection: string
  onCollection: (c: string) => void
  base: string
  onDone: () => void
  onSaved: (collection: string) => void
}) {
  const [field, setField] = useState('')
  const [value, setValue] = useState<unknown>(null)
  const { save, error } = useSaveDefault(base, () => {
    onSaved(collection)
    onDone()
  })
  const meta = collection ? metas.get(collection) : undefined
  const entry = allowed.find((a) => a.collection === collection)
  const fc = meta?.fields.find((f) => f.field === field)
  return (
    <div
      data-default-add-form
      className='mt-3 space-y-2 border-t border-slate-100 pt-3 dark:border-border/60'
    >
      <div className='grid gap-2 sm:grid-cols-2'>
        <Pick
          testId='collection'
          label='Collection'
          placeholder='Choose a collection'
          value={collection}
          options={allowed.map((a) => ({
            value: a.collection,
            label: a.label ?? metas.get(a.collection)?.label ?? titleCase(a.collection)
          }))}
          onChange={(c) => {
            onCollection(c)
            setField('')
            setValue(null)
          }}
        />
        <Pick
          testId='field'
          label='Field'
          placeholder={collection ? 'Choose a field' : 'Choose a collection first'}
          value={field}
          options={(entry?.fields ?? []).map((f) => ({
            value: f,
            label: meta ? fieldLabel(meta, f) : titleCase(f)
          }))}
          onChange={(f) => {
            setField(f)
            setValue(null)
          }}
        />
      </div>
      {fc && meta?.ready ? (
        <DefaultValueControl
          collection={collection}
          field={fc}
          relations={meta.relations}
          context={{}}
          value={value}
          onChange={setValue}
        />
      ) : field && !meta?.ready ? (
        <Skeleton className='h-8 w-full' />
      ) : null}
      {error && (
        <p role='alert' className='text-[11.5px] text-red-600 dark:text-red-400'>
          {error}
        </p>
      )}
      <div className='flex items-center justify-between gap-2'>
        <p className='text-[11px] text-slate-500 dark:text-slate-400'>
          Checked as them: they must be able to set the field and pick the value.
        </p>
        <SaveCancel
          canSave={!!fc && !isEmptyValue(value)}
          pending={save.isPending}
          onCancel={onDone}
          onSave={() => save.mutate({ collection, field, value, context: {} })}
        />
      </div>
    </div>
  )
}
