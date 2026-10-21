import { FileUp, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { useDebounced } from '../../../hooks/useDebounced'
import { useRelationOptions } from '../../../hooks/useRelationOptions'
import { get, post } from '../../../lib/commands'
import { cn, titleCase } from '../../../lib/utils'
import { useCollectionMeta } from '../inspector/field-context'
import { apiFailure, useDisplayTemplate, useOverviewFields } from '../overview/overview-api'
import { FieldMapStep, useFieldMapping } from './FieldMapStep'
import { matchNames, parseFieldList } from './field-match'
import type { FieldMap } from './reuse-api'
import { useTemplates } from './reuse-api'
import { reuseInput, reuseLabel } from './SectionReuseActions'
import { recordSeedFields } from './seed'

// What a new form starts with (overview New form): blank, a saved form
// template (#2594), a pasted / uploaded list of fields (#2616) or the fields a
// record has filled in (#2585). The choice resolves to the body POST
// /collection-layouts takes: seed_fields (in order) or template_id + field_map.

export type StartKind = 'blank' | 'template' | 'list' | 'record'

export interface StartSeed {
  /** Can Create go ahead (a template picked, a list with matches, a record read)? */
  ready: boolean
  seed_fields?: string[]
  template_id?: number
  field_map?: FieldMap
  /** A template decides what kind of layout it is. */
  layout_type?: string
}

export const BLANK_SEED: StartSeed = { ready: true }

const STARTS: Array<{ kind: StartKind; label: string }> = [
  { kind: 'blank', label: 'Blank' },
  { kind: 'template', label: 'Template' },
  { kind: 'list', label: 'Field list' },
  { kind: 'record', label: 'A record' }
]

const chip = (on: boolean) =>
  cn(
    'rounded-md px-2 py-0.5 text-[12px] font-medium transition-colors',
    on
      ? 'bg-accent text-slate-900 dark:text-foreground'
      : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
  )
const optionRow = (on: boolean) =>
  cn(
    'flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors',
    on ? 'bg-accent' : 'hover:bg-muted'
  )
const hint = 'text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'

// ── From a template ─────────────────────────────────────────────────────────

function FromTemplate({
  collection,
  onChange
}: {
  collection: string
  onChange: (s: StartSeed) => void
}) {
  const { data: templates = [], isLoading } = useTemplates('form')
  const [id, setId] = useState<number | null>(null)
  const t = templates.find((x) => x.id === id) ?? null
  const mapping = useFieldMapping(t?.fields ?? [], t?.source_collection ?? null, collection)
  const other = !!t?.source_collection && t.source_collection !== collection

  useEffect(() => {
    onChange(
      t
        ? {
            ready: !mapping.loading,
            template_id: t.id,
            field_map: other ? mapping.map : undefined,
            layout_type: t.layout_type ?? undefined
          }
        : { ready: false }
    )
  }, [t, other, mapping.map, mapping.loading, onChange])

  if (!isLoading && !templates.length)
    return (
      <p className={hint}>
        No form templates yet. Open a form and use ⋯ → Save as template to make one.
      </p>
    )
  return (
    <div className='space-y-2'>
      <div
        role='radiogroup'
        aria-label='Form template'
        className='max-h-[180px] overflow-y-auto overscroll-contain'
      >
        {templates.map((x) => (
          // biome-ignore lint/a11y/useSemanticElements: two-line option cards; a native radio cannot hold the description
          <button
            key={x.id}
            type='button'
            role='radio'
            aria-checked={x.id === id}
            data-start-template={x.id}
            onClick={() => setId(x.id)}
            className={optionRow(x.id === id)}
          >
            <span className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
              {x.name}
            </span>
            <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {[
                `${x.sections} ${x.sections === 1 ? 'section' : 'sections'}`,
                `${x.fields.length} fields`,
                x.source_collection && x.source_collection !== collection
                  ? `from ${x.source_collection}`
                  : null,
                x.description
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </button>
        ))}
      </div>
      {t && other && (
        <FieldMapStep
          needed={mapping.needed}
          map={mapping.map}
          onChange={mapping.setMap}
          targetCollection={collection}
        />
      )}
    </div>
  )
}

// ── From a list of fields ───────────────────────────────────────────────────

function FromList({
  collection,
  onChange
}: {
  collection: string
  onChange: (s: StartSeed) => void
}) {
  const { data: fieldData } = useOverviewFields(collection)
  const fields = useMemo(() => fieldData ?? [], [fieldData])
  const [text, setText] = useState('')
  const debounced = useDebounced(text, 200)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const matches = useMemo(
    () =>
      matchNames(
        parseFieldList(debounced),
        fields.filter((f) => !f.field.startsWith('__'))
      ),
    [debounced, fields]
  )
  // Memoized: the effect below publishes them, and a fresh array every render would loop.
  const found = useMemo(() => matches.filter((m) => m.field), [matches])
  const missing = matches.length - found.length
  const labelOf = (f: string) => {
    const row = fields.find((x) => x.field === f)
    return row?.label || titleCase(f)
  }

  useEffect(() => {
    onChange({
      ready: found.length > 0,
      seed_fields: found.map((m) => m.field as string)
    })
  }, [found, onChange])

  const upload = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 512 * 1024) {
      toast.error('That file is too big for a list of fields')
      return
    }
    // A CSV's header row is the list; one name per line otherwise.
    const raw = await file.text()
    const firstLine = raw.split(/\r?\n/).find((l) => l.trim()) ?? ''
    setText(/\.csv$/i.test(file.name) && firstLine.includes(',') ? firstLine : raw)
  }

  return (
    <div className='space-y-2'>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        aria-label='Field names'
        placeholder={'One per line, or separated by commas:\nTitle\nVendor\nAmount'}
        className={cn(reuseInput, 'h-auto py-1.5 font-mono text-[12px]')}
      />
      <div className='flex items-center justify-between gap-2'>
        <button
          type='button'
          onClick={() => fileRef.current?.click()}
          className='inline-flex items-center gap-1 text-[12px] font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
        >
          <FileUp className='h-3.5 w-3.5' />
          Upload a CSV or text file
        </button>
        <input
          ref={fileRef}
          type='file'
          accept='.csv,.txt,text/csv,text/plain'
          className='hidden'
          onChange={(e) => {
            void upload(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {matches.length > 0 && (
          <span className={hint} data-start-list-count=''>
            {found.length} of {matches.length} matched
          </span>
        )}
      </div>
      {matches.length > 0 && (
        <ol
          data-start-list=''
          className='max-h-[160px] space-y-px overflow-y-auto overscroll-contain text-[12px]'
        >
          {matches.map((m) => (
            <li key={m.input} className='flex items-center gap-1.5'>
              <span className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                {m.input}
              </span>
              {m.field ? (
                <span
                  className='min-w-0 truncate text-slate-800 dark:text-foreground'
                  data-tip={m.how === 'close' ? 'Closest spelling — check it' : undefined}
                >
                  {labelOf(m.field)}
                  {m.how === 'close' && (
                    <span className='ml-1 text-amber-700 dark:text-amber-300'>?</span>
                  )}
                </span>
              ) : (
                <span className='text-amber-700 dark:text-amber-300'>no match, left out</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {missing > 0 && (
        <p className={hint}>Names with no match are left out; add them later from Add.</p>
      )}
    </div>
  )
}

// ── From a record ───────────────────────────────────────────────────────────

/** The fields `recordId` has filled in, in field order (null while reading). */
export function useRecordSeed(collection: string, recordId: string | number | null) {
  const client = useNivaroClient()
  const { data: meta } = useCollectionMeta(collection)
  const [record, setRecord] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setRecord(null)
    setError(null)
    if (recordId == null) return
    let live = true
    client
      .request<{ data: Record<string, unknown> | null }>(
        get(`/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(recordId))}`)
      )
      .then((r) => {
        if (!live) return
        if (r?.data) setRecord(r.data)
        else setError('That record could not be read')
      })
      .catch((err) => live && setError(apiFailure(err, 'That record could not be read').message))
    return () => {
      live = false
    }
  }, [client, collection, recordId])
  const fields = useMemo(
    () => (record && meta ? recordSeedFields(record, meta.fields) : null),
    [record, meta]
  )
  return { fields, error }
}

function FromRecord({
  collection,
  onChange
}: {
  collection: string
  onChange: (s: StartSeed) => void
}) {
  const client = useNivaroClient()
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search, 250)
  const [picked, setPicked] = useState<{ id: string | number; label: string } | null>(null)
  const { data: template } = useDisplayTemplate(collection, true)
  const { options, loading } = useRelationOptions(client, collection, {
    search: debounced,
    limit: 8,
    displayTemplate: template ?? null,
    enabled: !picked && template !== undefined
  })
  const seed = useRecordSeed(collection, picked?.id ?? null)

  useEffect(() => {
    onChange(
      seed.fields ? { ready: seed.fields.length > 0, seed_fields: seed.fields } : { ready: false }
    )
  }, [seed.fields, onChange])

  if (picked)
    return (
      <div className='space-y-1.5'>
        <span className='inline-flex max-w-full items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-slate-800 dark:text-foreground'>
          <span className='truncate'>{picked.label}</span>
          <button
            type='button'
            aria-label='Pick another record'
            onClick={() => {
              setPicked(null)
              setSearch('')
            }}
            className='text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
        <p className={hint} data-start-record-count=''>
          {seed.error
            ? seed.error
            : seed.fields == null
              ? 'Reading the record…'
              : seed.fields.length
                ? `One section with the ${seed.fields.length} fields it has filled in.`
                : 'This record has nothing filled in yet.'}
        </p>
      </div>
    )
  return (
    <div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder='Search records…'
        aria-label='Search records'
        className={reuseInput}
      />
      <div className='mt-1 max-h-[180px] overflow-y-auto overscroll-contain'>
        {options.map((o) => (
          <button
            key={String(o.id)}
            type='button'
            onClick={() => setPicked({ id: o.id, label: o.label })}
            className='block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
          >
            {o.label}
          </button>
        ))}
        {!loading && options.length === 0 && (
          <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No records match.
          </p>
        )}
      </div>
    </div>
  )
}

// ── The choice ──────────────────────────────────────────────────────────────

export function NewFormStart({
  collection,
  onChange
}: {
  collection: string
  onChange: (s: StartSeed) => void
}) {
  const [kind, setKind] = useState<StartKind>('blank')
  useEffect(() => {
    if (kind === 'blank') onChange(BLANK_SEED)
  }, [kind, onChange])
  return (
    <div data-new-form-start={kind}>
      <p className={cn(reuseLabel, 'mt-3')}>Start with</p>
      <div role='tablist' aria-label='Start with' className='mb-2 flex flex-wrap gap-1'>
        {STARTS.map((s) => (
          <button
            key={s.kind}
            type='button'
            role='tab'
            aria-selected={kind === s.kind}
            onClick={() => setKind(s.kind)}
            className={chip(kind === s.kind)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {kind === 'template' && <FromTemplate collection={collection} onChange={onChange} />}
      {kind === 'list' && <FromList collection={collection} onChange={onChange} />}
      {kind === 'record' && <FromRecord collection={collection} onChange={onChange} />}
    </div>
  )
}

/**
 * Create a form holding `fields` (one "Main" section, in that order). Returns
 * the new layout's id.
 */
export async function createFormFromFields(
  client: ReturnType<typeof useNivaroClient>,
  body: { collection: string; name: string; fields: string[] }
): Promise<number | null> {
  const res = await client.request<{ data?: { id?: number } | null }>(
    post('/collection-layouts', {
      collection: body.collection,
      name: body.name,
      layout_type: 'grouped',
      seed_fields: body.fields
    })
  )
  const id = res?.data?.id
  return id == null ? null : Number(id)
}
