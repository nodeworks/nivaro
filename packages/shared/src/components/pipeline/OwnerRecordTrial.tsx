import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  FlaskConical,
  HelpCircle,
  Loader2,
  Search,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { DraftGroupDelta } from './owner-matrix-draft'
import { extractTemplateFields, renderDisplayTemplate } from './relations'

/**
 * "Try a record" (Owner Matrix): pick a real record and see who would own each
 * of its steps — under the saved matrix and, while a draft is open, under the
 * draft — with why. POST /pipelines/:id/owner-preview runs the server's real
 * owner resolver; this only draws the answer.
 */

export interface PreviewOwner {
  id: string
  name: string
  email: string | null
  via: 'group' | 'manual' | 'stand_in'
  delegate_for: string | null
  inactive: boolean
}

export interface PreviewStepOwners {
  owners: PreviewOwner[]
  no_assigned_owner: boolean
  match: {
    kind: 'no_groups' | 'no_match' | 'default' | 'match'
    group: { id: string; name: string | null; is_default: boolean; is_draft: boolean } | null
    facts: Array<{ field: string; label: string; wants: string; record_value: string }>
    inherited: Array<{ label: string; value: string }>
    override: string[]
    outranked: number
  }
  delegations: Array<{ from_id: string; from_name: string; to_id: string; to_name: string }>
  why: string[]
}

export interface OwnerPreviewStep {
  state: {
    id: string
    key: string
    label: string
    color: string | null
    is_current: boolean
    is_terminal: boolean
    owners_not_required: boolean
  }
  saved: PreviewStepOwners
  draft: PreviewStepOwners | null
  changed: boolean
}

export interface OwnerPreviewResult {
  collection: string
  item: string
  label: string
  has_instance: boolean
  current_state: string | null
  has_draft: boolean
  steps: OwnerPreviewStep[]
  unowned: number
}

/** The value, settled for `ms` (the draft changes on every cell edit). */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function OwnerRecordTrial({
  templateId,
  collections,
  draft,
  displayTemplates = {}
}: {
  templateId: string
  /** The pipeline's bound collections. */
  collections: string[]
  /** The matrix draft's changed/new/removed groups; null = no draft open. */
  draft: DraftGroupDelta[] | null
  /** collection → its display template, for the picker's labels. */
  displayTemplates?: Record<string, string | null | undefined>
}) {
  const client = useNivaroClient()
  const [collection, setCollection] = useState(collections[0] ?? '')
  const [record, setRecord] = useState<{ id: string; label: string } | null>(null)
  useEffect(() => {
    if (!collections.includes(collection)) setCollection(collections[0] ?? '')
  }, [collections, collection])

  const draftJson = useMemo(() => (draft && draft.length > 0 ? JSON.stringify(draft) : ''), [draft])
  const settledDraft = useSettled(draftJson, 400)

  const preview = useQuery({
    queryKey: ['owner-preview', templateId, collection, record?.id ?? '', settledDraft],
    queryFn: () =>
      client
        .request<{ data: OwnerPreviewResult }>(
          post(`/pipelines/${templateId}/owner-preview`, {
            collection,
            item: record?.id,
            ...(settledDraft ? { draft: JSON.parse(settledDraft) } : {})
          })
        )
        .then((r) => r.data),
    enabled: !!record && !!collection,
    placeholderData: keepPreviousData,
    staleTime: 15_000
  })
  const data = preview.data && preview.data.item === record?.id ? preview.data : null
  const pending = draftJson !== settledDraft || preview.isFetching

  if (collections.length === 0) return null

  return (
    <section
      data-owner-trial
      className='space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-border dark:bg-muted/30'
    >
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <span className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          <FlaskConical className='h-3.5 w-3.5 text-nvr-cyan' />
          Try a record
        </span>
        {collections.length > 1 && (
          <div className='flex items-center rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'>
            {collections.map((c) => (
              <button
                key={c}
                type='button'
                onClick={() => {
                  setCollection(c)
                  setRecord(null)
                }}
                className={cn(
                  'h-6 rounded px-2 text-[11px] font-medium transition-colors',
                  c === collection
                    ? 'bg-nvr-cyan/10 text-nvr-cyan'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                )}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <RecordPicker
          collection={collection}
          displayTemplate={displayTemplates[collection] ?? null}
          value={record}
          onChange={setRecord}
        />
        {record && (
          <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
            {draft && draft.length > 0 ? (
              <>
                Comparing the saved matrix with{' '}
                <span className='font-medium text-violet-700 dark:text-violet-300'>your draft</span>
              </>
            ) : (
              'Under the saved matrix'
            )}
          </span>
        )}
        {record && pending && <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />}
        {data && data.unowned > 0 && (
          <span className='ml-auto inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>
            <AlertTriangle className='h-3 w-3' />
            {data.unowned} step{data.unowned === 1 ? '' : 's'} with no assigned owner
          </span>
        )}
      </div>

      {!record && (
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>
          Pick a real record to see who would own each of its steps — and which steps nobody would.
          Edit the matrix in Draft mode and the answer follows your changes before you save them.
        </p>
      )}

      {record && preview.isError && (
        <ErrorNotice
          error={preview.error}
          what='the owner preview'
          onRetry={() => void preview.refetch()}
        />
      )}

      {data && (
        <>
          {!data.has_instance && (
            <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              This record has not started the pipeline yet — every step is shown as it would resolve
              today.
            </p>
          )}
          <OwnerTrialStrip steps={data.steps} />
        </>
      )}
    </section>
  )
}

/** The per-step result strip. Exported for tests and other hosts. */
export function OwnerTrialStrip({ steps }: { steps: OwnerPreviewStep[] }) {
  return (
    <ol className='flex gap-2 overflow-x-auto pb-1' aria-label='Owners per step'>
      {steps.map((s) => (
        <StepCard key={s.state.id} step={s} />
      ))}
    </ol>
  )
}

function StepCard({ step }: { step: OwnerPreviewStep }) {
  const shown = step.draft ?? step.saved
  const terminal = step.state.is_terminal
  const noOwner = shown.no_assigned_owner && !terminal
  return (
    <li
      data-step={step.state.key}
      data-no-owner={noOwner ? 'true' : undefined}
      className={cn(
        'flex w-[208px] shrink-0 flex-col gap-2 rounded-lg border bg-white p-2.5 dark:bg-card',
        noOwner
          ? 'border-amber-300 dark:border-amber-500/40'
          : step.changed
            ? 'border-violet-300 dark:border-violet-500/40'
            : 'border-slate-200 dark:border-border',
        step.state.is_current && 'ring-2 ring-nvr-cyan/40'
      )}
    >
      <div className='flex items-start gap-1.5'>
        <span
          className='mt-1 h-2 w-2 shrink-0 rounded-full'
          style={{ backgroundColor: step.state.color ?? '#94a3b8' }}
        />
        <span className='line-clamp-2 min-w-0 flex-1 break-words text-[12px] font-semibold leading-tight text-slate-800 dark:text-slate-100'>
          {step.state.label}
        </span>
        {step.state.is_current && (
          <span className='shrink-0 rounded bg-nvr-cyan/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-nvr-cyan'>
            Now
          </span>
        )}
        {step.changed && (
          <span className='shrink-0 rounded bg-violet-100 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'>
            Draft
          </span>
        )}
      </div>

      {terminal ? (
        <p className='text-[11px] text-slate-400 dark:text-slate-500'>Final step — no owner</p>
      ) : (
        <OwnerChips owners={shown.owners} notRequired={step.state.owners_not_required} />
      )}

      {noOwner && (
        <p className='flex items-start gap-1 rounded-md bg-amber-50 px-1.5 py-1 text-[11px] font-medium leading-snug text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'>
          <AlertTriangle className='mt-px h-3 w-3 shrink-0' />
          {shown.owners.some((o) => o.via === 'stand_in')
            ? 'No assigned owner — only a stand-in'
            : 'No owner'}
        </p>
      )}

      {step.changed && (
        <p className='flex flex-wrap items-center gap-1 text-[10.5px] text-slate-500 dark:text-slate-400'>
          <span>Saved:</span>
          <span className='line-through decoration-slate-400'>
            {step.saved.owners.length > 0
              ? step.saved.owners.map((o) => o.name).join(', ')
              : 'nobody'}
          </span>
          <ArrowRight className='h-3 w-3' />
          <span className='font-medium text-violet-700 dark:text-violet-300'>draft</span>
        </p>
      )}

      {!terminal && <WhyPopover step={step} />}
    </li>
  )
}

function OwnerChips({ owners, notRequired }: { owners: PreviewOwner[]; notRequired: boolean }) {
  if (owners.length === 0)
    return (
      <p className='text-[11px] text-slate-400 dark:text-slate-500'>
        {notRequired ? 'Nobody — this step needs no owner' : 'Nobody'}
      </p>
    )
  const shown = owners.slice(0, 5)
  return (
    <div className='flex flex-wrap gap-1'>
      {shown.map((o) => (
        <span
          key={o.id}
          data-tip={
            o.via === 'stand_in'
              ? 'Stands in from the record: it waits in their queue, but only an assigned owner can approve'
              : o.delegate_for
                ? `Covering for ${o.delegate_for} (out of office)`
                : o.via === 'manual'
                  ? 'Added to this record by hand'
                  : (o.email ?? undefined)
          }
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium',
            o.via === 'stand_in'
              ? 'border border-dashed border-amber-400 text-amber-800 dark:border-amber-500/50 dark:text-amber-300'
              : 'bg-nvr-cyan/10 text-slate-700 dark:bg-nvr-cyan/15 dark:text-slate-200',
            o.inactive && 'line-through opacity-60'
          )}
        >
          <span className='truncate'>{o.name}</span>
          {o.via === 'stand_in' && (
            <span className='shrink-0 text-[9.5px] uppercase'>stand-in</span>
          )}
          {o.delegate_for && (
            <span className='shrink-0 text-[9.5px] text-slate-500 dark:text-slate-400'>
              for {o.delegate_for}
            </span>
          )}
        </span>
      ))}
      {owners.length > shown.length && (
        <span className='px-1 text-[11px] text-slate-400'>+{owners.length - shown.length}</span>
      )}
    </div>
  )
}

function WhyBlock({ title, owners }: { title?: string; owners: PreviewStepOwners }) {
  const g = owners.match.group
  return (
    <div className='space-y-1.5'>
      {title && (
        <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>{title}</p>
      )}
      {g && (
        <p className='flex flex-wrap items-center gap-1 text-[12px] font-medium text-slate-800 dark:text-slate-100'>
          {g.is_default ? 'Default group' : 'Owner group'}
          {g.name ? <span>“{g.name}”</span> : null}
          {g.is_draft && (
            <span className='rounded bg-violet-100 px-1 text-[9.5px] font-semibold uppercase text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'>
              draft
            </span>
          )}
        </p>
      )}
      {owners.match.facts.length > 0 && (
        <table className='w-full text-[11px]'>
          <thead>
            <tr className='text-left text-slate-400'>
              <th className='pb-0.5 font-medium'>Dimension</th>
              <th className='pb-0.5 font-medium'>Group wants</th>
              <th className='pb-0.5 font-medium'>Record has</th>
            </tr>
          </thead>
          <tbody>
            {owners.match.facts.map((f) => (
              <tr key={f.field} className='text-slate-700 dark:text-slate-200'>
                <td className='py-0.5 pr-2'>{f.label}</td>
                <td className='py-0.5 pr-2'>{f.wants || '—'}</td>
                <td className='py-0.5'>{f.record_value || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ul className='space-y-1'>
        {owners.why.map((w) => (
          <li key={w} className='text-[11.5px] leading-snug text-slate-600 dark:text-slate-300'>
            {w}
          </li>
        ))}
      </ul>
    </div>
  )
}

function WhyPopover({ step }: { step: OwnerPreviewStep }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='mt-auto inline-flex items-center gap-1 self-start text-[11px] font-medium text-slate-500 hover:text-nvr-cyan dark:text-slate-400'
        >
          <HelpCircle className='h-3 w-3' />
          Why?
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-80 space-y-3 p-3' sideOffset={4}>
        <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          {step.state.label}
        </p>
        {step.draft ? (
          <>
            <WhyBlock title='With your draft' owners={step.draft} />
            {step.changed && (
              <div className='border-t border-slate-100 pt-2 dark:border-border'>
                <WhyBlock title='Saved matrix' owners={step.saved} />
              </div>
            )}
          </>
        ) : (
          <WhyBlock owners={step.saved} />
        )}
      </PopoverContent>
    </Popover>
  )
}

const ID_LIKE = /^[0-9]+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function RecordPicker({
  collection,
  displayTemplate,
  value,
  onChange
}: {
  collection: string
  displayTemplate: string | null
  value: { id: string; label: string } | null
  onChange: (v: { id: string; label: string } | null) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const term = useSettled(query.trim(), 300)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])

  const fields = useMemo(() => {
    const t = extractTemplateFields(displayTemplate).filter((f) => !f.includes('.'))
    return t.length > 0 ? ['id', ...t].join(',') : undefined
  }, [displayTemplate])

  const { data: rows = [], isFetching } = useQuery<Record<string, unknown>[]>({
    queryKey: ['owner-trial-records', collection, term, fields ?? ''],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${collection}`, {
            limit: 20,
            sort: '-id',
            ...(term ? { search: term } : {}),
            ...(fields ? { fields } : {})
          })
        )
        .then((r) => r.data ?? []),
    enabled: open && !!collection,
    staleTime: 30_000
  })
  const labelOf = (row: Record<string, unknown>) => {
    const l = displayTemplate ? renderDisplayTemplate(displayTemplate, row) : ''
    return l?.trim() ? `${l} · #${String(row.id)}` : `#${String(row.id)}`
  }
  const exact = ID_LIKE.test(query.trim()) && !rows.some((r) => String(r.id) === query.trim())

  return (
    <div className='flex items-center gap-1'>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className={cn(
              'flex h-7 max-w-[320px] items-center gap-1 rounded-md border px-2.5 text-[12px] transition-colors',
              value
                ? 'border-nvr-cyan/50 bg-nvr-cyan/5 font-medium text-nvr-cyan'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-300'
            )}
          >
            <Search className='h-3 w-3 shrink-0 opacity-60' />
            <span className='truncate'>{value ? value.label : 'Pick a record…'}</span>
            <ChevronDown className='h-3 w-3 shrink-0 opacity-50' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-80 p-0' sideOffset={4}>
          <div className='border-b border-slate-100 px-2 py-1.5 dark:border-border'>
            <div className='relative'>
              <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${collection} or type an id…`}
                className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40 dark:bg-muted'
              />
            </div>
          </div>
          <div className='max-h-64 overflow-y-auto py-1'>
            {exact && (
              <button
                type='button'
                onClick={() => {
                  onChange({ id: query.trim(), label: `#${query.trim()}` })
                  setOpen(false)
                }}
                className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
              >
                <ArrowRight className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
                Use record #{query.trim()}
              </button>
            )}
            {rows.map((r) => {
              const id = String(r.id)
              const label = labelOf(r)
              return (
                <button
                  key={id}
                  type='button'
                  onClick={() => {
                    onChange({ id, label })
                    setOpen(false)
                  }}
                  className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      value?.id === id ? 'text-nvr-cyan' : 'opacity-0'
                    )}
                  />
                  <span className='truncate'>{label}</span>
                </button>
              )
            })}
            {isFetching && rows.length === 0 && (
              <p className='flex items-center gap-1.5 px-3 py-2 text-[12px] text-slate-400'>
                <Loader2 className='h-3 w-3 animate-spin' /> Searching…
              </p>
            )}
            {!isFetching && rows.length === 0 && !exact && (
              <p className='px-3 py-2 text-[12px] text-slate-400'>No records match</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value && (
        <button
          type='button'
          aria-label='Clear the record'
          data-tip='Clear the record'
          onClick={() => onChange(null)}
          className='flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  )
}
