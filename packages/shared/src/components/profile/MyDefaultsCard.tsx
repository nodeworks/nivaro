import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookmarkCheck, Check, Pencil, Plus, UserRoundX, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ParentDraftContext, useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, put } from '../../lib/commands'
import { cascadeParents, isEmptyValue } from '../../lib/personal-defaults'
import { userErrorMessage } from '../../lib/safe-error'
import { cn, formatDate, titleCase } from '../../lib/utils'
import { FieldRenderer } from '../item-edit/FieldRenderer'
import { buildCascadeFilter, getCascadeFilters } from '../item-edit/helpers'
import { M2MStagingContext, type M2MStagingCtx } from '../item-edit/M2MStagingContext'
import { PERSONAL_DEFAULT_GHOST_BUTTON } from '../item-edit/PersonalDefaultPill'
import { pickedCollection } from '../item-edit/personal-default-checks'
import type { CMSField, CMSRelation } from '../item-edit/types'
import { personalDefaultsKey } from '../item-edit/usePersonalDefaults'
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
    isError,
    refetch,
    isRefetching
  } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      client.request<{ data: DefaultRow[] }>(get(base, { on_layout: 1 })).then((r) => r.data ?? []),
    enabled: allowedHere,
    staleTime: 30_000
  })
  // Every field a form lets this person keep a default for (judged as them): listed whether
  // or not one is saved, so a default can be set and cleared right here.
  const { data: allowed, isPending: allowedPending } = useQuery({
    queryKey: ['field-defaults-allowed', who],
    queryFn: () =>
      client
        .request<{ data: AllowedCollection[] }>(get(`${base}/allowed`))
        .then((r) => r.data ?? []),
    enabled: allowedHere,
    staleTime: 60_000
  })

  const collections = useMemo(() => {
    const set = new Set((rows ?? []).map((r) => r.collection))
    for (const a of allowed ?? []) set.add(a.collection)
    return [...set]
  }, [rows, allowed])
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
  // Own page: the card appears only once known to have something — saved defaults, or a form
  // that offers one (today most people have neither; a skeleton that then vanished shifted the
  // whole profile on every open). An admin's tools tab keeps its skeleton.
  if (!forOther) {
    if (isPending || (allowedPending && !isError)) return null
    if (!isError && (rows ?? []).length === 0 && (allowed?.length ?? 0) === 0) return null
  }

  // Allowed fields with no saved default yet: a "Not set" row each, after the saved ones.
  const unsetBy = new Map<string, string[]>()
  for (const a of allowed ?? []) {
    const saved = new Set(
      (rows ?? []).filter((r) => r.collection === a.collection).map((r) => r.field)
    )
    const meta = metas.get(a.collection)
    const unset = a.fields
      .filter((f) => !saved.has(f))
      .sort((x, y) =>
        meta ? fieldLabel(meta, x).localeCompare(fieldLabel(meta, y)) : x.localeCompare(y)
      )
    if (unset.length) unsetBy.set(a.collection, unset)
  }
  const groups = collections
    .filter((c) => (rows ?? []).some((r) => r.collection === c) || unsetBy.has(c))
    .map((c) => ({
      collection: c,
      label:
        metas.get(c)?.label ||
        (allowed ?? []).find((a) => a.collection === c)?.label ||
        titleCase(c)
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const firstName = name?.trim() || 'This person'
  return (
    <SectionCard
      icon={<BookmarkCheck className='h-4 w-4' />}
      title={forOther ? 'Personal defaults' : 'My defaults'}
      hint={
        forOther
          ? `New records ${name?.trim() ? firstName : 'they'} start are filled in with these`
          : 'New records you start are filled in with these'
      }
      testId='my-defaults'
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
        <div className='flex flex-wrap items-center gap-2'>
          <EmptyLine>Could not load the saved defaults.</EmptyLine>
          <button
            type='button'
            data-default-retry
            disabled={isRefetching}
            onClick={() => void refetch()}
            className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-700 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 disabled:opacity-50 dark:border-border dark:text-slate-200'
          >
            {isRefetching ? 'Trying…' : 'Retry'}
          </button>
        </div>
      ) : groups.length === 0 ? (
        <p
          data-default-empty
          className='max-w-[65ch] text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300'
        >
          {forOther ? `${firstName} hasn’t saved any defaults yet.` : 'You have no defaults yet.'}
        </p>
      ) : (
        <div className='space-y-5'>
          {(rows ?? []).length === 0 && (
            <p
              data-default-empty
              className='max-w-[65ch] text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300'
            >
              {forOther
                ? `${firstName} hasn’t saved any defaults yet. Set one below, or they can choose `
                : 'Nothing set yet. Set a field below, or choose '}
              <span className='font-medium text-slate-800 dark:text-slate-100'>Make default</span>{' '}
              beside its label on a new record.
            </p>
          )}
          {groups.map((g) => {
            const count = (rows ?? []).filter((r) => r.collection === g.collection).length
            const unset = unsetBy.get(g.collection) ?? []
            const meta = metas.get(g.collection) ?? EMPTY_META
            return (
              <section key={g.collection} data-default-group={g.collection}>
                <h4 className='flex items-baseline gap-1.5 border-b border-slate-200 pb-1.5 text-[12.5px] font-semibold text-slate-800 dark:border-border dark:text-slate-100'>
                  <span data-default-group-label>{g.label}</span>
                  <span className='text-[11.5px] font-normal tabular-nums text-slate-500 dark:text-slate-400'>
                    {count} of {count + unset.length} set
                  </span>
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
                  {unset.map((f) => (
                    <UnsetRowItem
                      key={`unset:${f}`}
                      collection={g.collection}
                      field={f}
                      meta={meta}
                      base={base}
                      forOther={forOther}
                      onSaved={() => refresh(g.collection)}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
      {forOther && allowed?.length === 0 && (
        <p className='mt-3 text-[11.5px] text-slate-500 dark:text-slate-400'>
          No form gives {name?.trim() ? firstName : 'this person'} a personal default yet. Turn on
          Personal default for a field in the layout editor.
        </p>
      )}
    </SectionCard>
  )
}

// ─── One saved default ───────────────────────────────────────────────────────

const FOCUSABLE =
  'input:not([type=hidden]), textarea, [role=combobox], button, [tabindex]:not([tabindex="-1"])'

const STALE_EXPLAINED =
  'No form you can be given offers a personal default for this field now, so it is not used. Clear it, or ask an admin to turn it back on.'

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
  const changeRef = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef(false)
  // Closing the editor (Cancel, Escape, Save) hands focus back to Change.
  useEffect(() => {
    if (editing || !returnFocus.current) return
    returnFocus.current = false
    changeRef.current?.focus()
  }, [editing])
  const close = () => {
    returnFocus.current = true
    setEditing(false)
  }
  const stale = row.on_layout === false
  const fc = meta.fields.find((f) => f.field === row.field)
  const value = parts ? partText(parts.value, labels) : { text: '', state: 'loading' as const }
  const context = (parts?.context ?? []).map(([k, p]) => {
    // A parent that is no longer a field of the collection: name it, there is no value to show.
    if (p.kind === 'unknown') return fieldLabel(meta, k)
    const t = partText(p, labels)
    if (t.state === 'loading') return null
    return t.state === 'gone' || t.state === 'failed'
      ? `${fieldLabel(meta, k)} (unavailable)`
      : t.text
  })
  const contextLoading = (parts?.context ?? []).length > 0 && context.some((c) => c === null)

  return (
    <li
      data-default-row={row.id}
      data-editing={editing ? '' : undefined}
      className={cn(
        '-mx-2 flex flex-col gap-2 rounded-md px-2 py-2.5 sm:flex-row sm:items-start sm:gap-3',
        editing && 'bg-slate-50 dark:bg-muted/40'
      )}
    >
      <div className='min-w-0 flex-1 gap-x-4 gap-y-1 sm:grid sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]'>
        <p
          data-default-field
          className={cn(
            'truncate text-[12.5px] text-slate-600 dark:text-slate-300',
            editing ? 'sm:pt-2' : 'sm:pt-px'
          )}
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
              onCancel={close}
              onSaved={() => {
                close()
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
                'truncate text-[13px]',
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
          <p className='mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
            {contextLoading ? (
              <Skeleton className='h-3 w-28' />
            ) : context.length > 0 ? (
              <span data-default-context>For {context.join(' · ')}</span>
            ) : null}
            {!editing && (contextLoading || context.length > 0) && <span aria-hidden>·</span>}
            {!editing && (
              <span>
                {row.updated_by ? 'Set by an admin' : 'Saved'} {formatDate(row.updated_at)}
              </span>
            )}
            {stale && (
              <span data-tip={STALE_EXPLAINED}>
                <Pill tone='amber' testId='stale'>
                  <span data-default-stale>No longer on any form</span>
                </Pill>
                <span className='sr-only'>. {STALE_EXPLAINED}</span>
              </span>
            )}
          </p>
        </div>
      </div>
      {!editing && (
        // Always visible: hover-only actions hid the only way to change or clear a default.
        <div className='flex shrink-0 items-center gap-1 sm:pt-px'>
          {!stale && fc && (
            <button
              ref={changeRef}
              type='button'
              data-default-change
              aria-label={`Change the default for ${fieldLabel(meta, row.field)}`}
              onClick={() => setEditing(true)}
              className={PERSONAL_DEFAULT_GHOST_BUTTON}
            >
              <Pencil className='h-3 w-3' /> Change
            </button>
          )}
          <ConfirmButton
            onConfirm={onClear}
            disabled={clearing}
            title={`Clear the default for ${fieldLabel(meta, row.field)}`}
            confirmTitle={`Clear the default for ${fieldLabel(meta, row.field)}?`}
            confirmLabel={
              <span data-default-clear className='px-0.5 text-[11.5px] font-semibold'>
                Clear it?
              </span>
            }
            className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-500 transition-colors hover:bg-muted hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 disabled:opacity-50 dark:text-slate-400 dark:hover:text-red-400'
            armedClassName='bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/15'
          >
            <span data-default-clear className='inline-flex items-center gap-1'>
              <UserRoundX className='h-3 w-3' /> Clear
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
    <span className='flex h-9 shrink-0 items-center gap-1.5'>
      <button type='button' onClick={onCancel} className={PERSONAL_DEFAULT_GHOST_BUTTON}>
        <X className='h-3 w-3' /> Cancel
      </button>
      <button
        type='button'
        data-default-save
        disabled={!canSave || pending}
        onClick={onSave}
        className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 focus-visible:ring-offset-1 disabled:opacity-50'
      >
        {pending ? (
          'Saving…'
        ) : (
          <>
            <Check className='h-3 w-3' /> Save
          </>
        )}
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
  const boxRef = useRef<HTMLFieldSetElement | null>(null)
  // Opening the editor puts the cursor in the field's control (input, picker trigger, …).
  useEffect(() => {
    const focusFirst = () => {
      const el = boxRef.current
        ?.querySelector('[data-default-control]')
        ?.querySelector<HTMLElement>(FOCUSABLE)
      el?.focus()
      return !!el
    }
    if (focusFirst()) return
    const t = window.setTimeout(focusFirst, 50)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <fieldset
      ref={boxRef}
      className='m-0 min-w-0 space-y-1.5 border-0 p-0'
      data-default-editor
      onKeyDown={(e) => {
        // Escape cancels — unless it was closing a picker's list (portaled outside this box).
        if (e.key !== 'Escape' || e.defaultPrevented) return
        if (!boxRef.current?.contains(e.target as Node)) return
        e.stopPropagation()
        onCancel()
      }}
    >
      <legend className='sr-only'>Change the default for {field.label || field.field}</legend>
      <div className='flex flex-wrap items-start gap-2'>
        <div data-default-control className='min-w-[12rem] max-w-[28rem] flex-1'>
          <DefaultValueControl
            collection={row.collection}
            field={field}
            relations={relations}
            context={row.context ?? {}}
            value={draft}
            onChange={setDraft}
          />
        </div>
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
      {error && (
        <p role='alert' className='text-[11.5px] text-red-600 dark:text-red-400'>
          {error}
        </p>
      )}
    </fieldset>
  )
}

// ─── An allowed field with nothing saved ─────────────────────────────────────

/** A field a form lets this person keep a default for, with none saved yet: Set opens the
 *  field's own control (no parent context: it applies whatever the parents are). */
function UnsetRowItem({
  collection,
  field,
  meta,
  base,
  forOther,
  onSaved
}: {
  collection: string
  field: string
  meta: CollectionMeta
  base: string
  forOther: boolean
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState<unknown>(null)
  const { save, error } = useSaveDefault(base, () => {
    setEditing(false)
    setValue(null)
    onSaved()
  })
  const fc = meta.fields.find((f) => f.field === field)
  const label = fieldLabel(meta, field)
  const setRef = useRef<HTMLButtonElement | null>(null)
  const boxRef = useRef<HTMLFieldSetElement | null>(null)
  useEffect(() => {
    if (!editing) return
    const t = window.setTimeout(() => {
      boxRef.current
        ?.querySelector('[data-default-control]')
        ?.querySelector<HTMLElement>(FOCUSABLE)
        ?.focus()
    }, 30)
    return () => window.clearTimeout(t)
  }, [editing])
  const close = () => {
    setEditing(false)
    setValue(null)
    requestAnimationFrame(() => setRef.current?.focus())
  }
  return (
    <li
      data-default-unset={field}
      data-editing={editing ? '' : undefined}
      className={cn(
        '-mx-2 flex flex-col gap-2 rounded-md px-2 py-2.5 sm:flex-row sm:items-start sm:gap-3',
        editing && 'bg-slate-50 dark:bg-muted/40'
      )}
    >
      <div className='min-w-0 flex-1 gap-x-4 gap-y-1 sm:grid sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]'>
        <p
          data-default-field
          className={cn(
            'truncate text-[12.5px] text-slate-600 dark:text-slate-300',
            editing ? 'sm:pt-2' : 'sm:pt-px'
          )}
        >
          {label}
        </p>
        <div className='min-w-0'>
          {editing && fc ? (
            <fieldset
              ref={boxRef}
              className='m-0 min-w-0 space-y-1.5 border-0 p-0'
              data-default-editor
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || e.defaultPrevented) return
                if (!boxRef.current?.contains(e.target as Node)) return
                e.stopPropagation()
                close()
              }}
            >
              <legend className='sr-only'>Set the default for {label}</legend>
              <div className='flex flex-wrap items-start gap-2'>
                <div data-default-control className='min-w-[12rem] max-w-[28rem] flex-1'>
                  <DefaultValueControl
                    collection={collection}
                    field={fc}
                    relations={meta.relations}
                    context={{}}
                    value={value}
                    onChange={setValue}
                  />
                </div>
                <SaveCancel
                  canSave={!isEmptyValue(value)}
                  pending={save.isPending}
                  onCancel={close}
                  onSave={() => save.mutate({ collection, field, value, context: {} })}
                />
              </div>
              {error && (
                <p role='alert' className='text-[11.5px] text-red-600 dark:text-red-400'>
                  {error}
                </p>
              )}
              {forOther && (
                <p className='text-[11px] text-slate-500 dark:text-slate-400'>
                  Checked as them: they must be able to set the field and pick the value.
                </p>
              )}
            </fieldset>
          ) : (
            <p
              data-default-value
              className='pt-px text-[12.5px] italic text-slate-500 dark:text-slate-400'
            >
              Not set
            </p>
          )}
        </div>
      </div>
      {!editing && (
        <div className='flex shrink-0 items-center gap-1 sm:pt-px'>
          <button
            ref={setRef}
            type='button'
            data-default-set={field}
            aria-label={`Set a default for ${label}`}
            disabled={!fc}
            onClick={() => setEditing(true)}
            className={cn(PERSONAL_DEFAULT_GHOST_BUTTON, 'disabled:opacity-50')}
          >
            <Plus className='h-3 w-3' /> Set
          </button>
        </div>
      )}
    </li>
  )
}
