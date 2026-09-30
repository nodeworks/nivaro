import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, History, Inbox, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, type Collection } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Combobox,
  type ImportHeaderRule,
  RowFilterEditor,
  RuleEditor,
  useFieldOptions
} from './ImportTemplatesSection'

// ─── #88 — inbound mappings ─────────────────────────────────────────────────
// An integration POSTs its own payload shape to /api/inbound/<key>; the rules
// (the import-template header-rule format) turn it into a record. Master-
// detail: list left, editor + tester right.

type RowFilter = { column: string; op: 'nnull' | 'eq' | 'neq'; value?: string } | null

interface ChildConfig {
  target_field: string
  source: string
  row_filter: RowFilter
  columns: ImportHeaderRule[]
  on_update: 'append' | 'replace'
}

type Outcome = 'success' | 'partial' | 'rejected'

interface Fixture {
  id: string
  name: string
  payload: unknown
  expect: 'write' | 'reject'
  source_log_id: number | null
  saved_at: string
}

interface Mapping {
  id: number
  key: string
  label: string
  collection: string
  mode: 'create' | 'upsert'
  upsert_keys: string[]
  rules: ImportHeaderRule[]
  children: ChildConfig[]
  fixtures: Fixture[]
  response_template: string | null
  response_status: Partial<Record<Outcome, number>>
  is_active: boolean
  endpoint: string
  updated_at: string
}

interface Draft {
  key: string
  label: string
  collection: string
  mode: 'create' | 'upsert'
  upsert_keys: string
  rules: ImportHeaderRule[]
  children: ChildConfig[]
  response_template: string
  response_status: Record<Outcome, string>
  is_active: boolean
}

const EMPTY: Draft = {
  key: '',
  label: '',
  collection: '',
  mode: 'create',
  upsert_keys: '',
  rules: [],
  children: [],
  response_template: '',
  response_status: { success: '', partial: '', rejected: '' },
  is_active: true
}

const DEFAULT_STATUS: Record<Outcome, number> = { success: 200, partial: 207, rejected: 422 }

function toDraft(m: Mapping): Draft {
  const st = m.response_status ?? {}
  return {
    key: m.key,
    label: m.label,
    collection: m.collection,
    mode: m.mode,
    upsert_keys: m.upsert_keys.join(', '),
    rules: m.rules,
    children: m.children ?? [],
    response_template: m.response_template ?? '',
    response_status: {
      success: st.success != null ? String(st.success) : '',
      partial: st.partial != null ? String(st.partial) : '',
      rejected: st.rejected != null ? String(st.rejected) : ''
    },
    is_active: m.is_active
  }
}

function statusBody(s: Draft['response_status']): Partial<Record<Outcome, number>> {
  const out: Partial<Record<Outcome, number>> = {}
  for (const k of ['success', 'partial', 'rejected'] as const)
    if (s[k].trim()) out[k] = Number(s[k])
  return out
}

/** The parts of a draft the bench and the tester can run unsaved. */
function draftRunBody(d: Draft) {
  return {
    rules: d.rules,
    children: d.children,
    response_template: d.response_template,
    response_status: statusBody(d.response_status)
  }
}

function toBody(d: Draft) {
  return {
    key: d.key.trim(),
    label: d.label.trim(),
    collection: d.collection,
    mode: d.mode,
    upsert_keys: d.upsert_keys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    rules: d.rules,
    children: d.children,
    response_template: d.response_template,
    response_status: statusBody(d.response_status),
    is_active: d.is_active
  }
}

interface RunEntry {
  index: number
  action: string
  would?: 'create' | 'update' | null
  values: Record<string, unknown>
  issues: Array<{ severity: string; rule: string; message: string }>
  error?: string
  children?: Array<{ field: string; found: number; rows: number }>
  child_error?: { field: string; index: number | null; message: string }
}

interface ShapedResponse {
  status: number
  outcome: Outcome
  body: unknown
  content_type: string
  shaped: boolean
  template_error?: string
}

const PILL = {
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  bad: 'bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300',
  muted: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
}

function prettyBody(body: unknown): string {
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body, null, 2)
  } catch {
    return String(body)
  }
}

export function InboundMappingsPage() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const { data: rows, isLoading } = useQuery({
    queryKey: ['inbound-mappings'],
    queryFn: () => api.get<{ data: Mapping[] }>('/inbound-mappings').then((r) => r.data.data)
  })
  const { data: collections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get<{ data: Collection[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })
  const current =
    typeof selected === 'number' ? (rows?.find((r) => r.id === selected) ?? null) : null
  // Load the draft once per selection: a refetch of the list (a fixture was
  // added, the bench re-ran) must never throw away rules being edited.
  const loadedFor = useRef<number | 'new' | null>(null)
  useEffect(() => {
    if (selected === 'new') {
      if (loadedFor.current !== 'new') setDraft(EMPTY)
      loadedFor.current = 'new'
    } else if (current && loadedFor.current !== current.id) {
      setDraft(toDraft(current))
      loadedFor.current = current.id
    } else if (selected === null) loadedFor.current = null
  }, [selected, current])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['inbound-mappings'] })
  const onErr = (e: { response?: { data?: { error?: string } } }) =>
    toast.error(e.response?.data?.error ?? 'Request failed', { duration: 8000 })
  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: Mapping }>('/inbound-mappings', toBody(draft)).then((r) => r.data.data),
    onSuccess: (m) => {
      invalidate()
      setSelected(m.id)
      toast.success('Mapping created')
    },
    onError: onErr
  })
  const save = useMutation({
    mutationFn: () =>
      api
        .patch<{ data: Mapping }>(`/inbound-mappings/${selected}`, toBody(draft))
        .then((r) => r.data.data),
    onSuccess: () => {
      invalidate()
      toast.success('Mapping saved')
    },
    onError: onErr
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/inbound-mappings/${id}`),
    onSuccess: () => {
      invalidate()
      setSelected(null)
      toast.success('Mapping deleted')
    },
    onError: onErr
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <div>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Inbound Mappings
            </h1>
            <p className='mt-0.5 text-[12px] text-slate-400 dark:text-muted-foreground'>
              Let an integration post its own payload shape. Rules map it onto a collection; the
              write runs as the caller.
            </p>
          </div>
          <Button
            size='sm'
            className='ml-auto h-8'
            onClick={() => setSelected('new')}
            data-inbound-new
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' /> New mapping
          </Button>
        </div>
      </header>
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <div className='space-y-2 p-3'>
              <Skeleton className='h-10 rounded' />
              <Skeleton className='h-10 rounded' />
            </div>
          ) : (rows ?? []).length === 0 ? (
            <p className='p-4 text-[12px] text-slate-400'>No mappings yet.</p>
          ) : (
            (rows ?? []).map((m) => (
              <button
                type='button'
                key={m.id}
                data-inbound-row={m.key}
                onClick={() => setSelected(m.id)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 border-b border-slate-100 px-4 py-2.5 text-left hover:bg-slate-50 dark:border-border dark:hover:bg-muted/40',
                  selected === m.id && 'bg-nvr-cyan/10'
                )}
              >
                <span className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                  {m.label}
                </span>
                <span className='font-mono text-[11px] text-slate-500'>
                  {m.key} → {m.collection}
                  {!m.is_active && <span className='ml-1.5 text-amber-600'>· inactive</span>}
                </span>
              </button>
            ))
          )}
        </aside>
        <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          {selected === null ? (
            <div className='rounded-lg border border-dashed border-slate-200 bg-white px-6 py-12 text-center dark:border-border dark:bg-card'>
              <Inbox className='mx-auto h-6 w-6 text-slate-300' />
              <p className='mt-2 text-[13px] text-slate-500'>Pick a mapping or create one.</p>
            </div>
          ) : (
            <div className='max-w-4xl space-y-4'>
              <div
                className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'
                data-inbound-editor
              >
                <div className='grid gap-3 sm:grid-cols-2'>
                  <div>
                    <Label className='text-[11px]'>Label</Label>
                    <Input
                      value={draft.label}
                      onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                      className='h-8 text-[13px]'
                      placeholder='Orders from a partner system'
                    />
                  </div>
                  <div>
                    <Label className='text-[11px]'>Key</Label>
                    <Input
                      value={draft.key}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
                        }))
                      }
                      className='h-8 font-mono text-[13px]'
                      placeholder='vendor-orders'
                    />
                    <p className='mt-1 font-mono text-[11px] text-slate-400'>
                      POST /api/inbound/{draft.key || '<key>'}
                    </p>
                  </div>
                  <div>
                    <Label className='text-[11px]'>Collection</Label>
                    <Combobox
                      value={draft.collection}
                      onChange={(v) =>
                        setDraft((d) => ({ ...d, collection: v, rules: [], children: [] }))
                      }
                      options={collections
                        .filter((c) => !c.collection.startsWith('nivaro_'))
                        .map((c) => ({ value: c.collection, label: c.collection }))}
                      placeholder='collection…'
                    />
                  </div>
                  <div>
                    <Label className='text-[11px]'>Mode</Label>
                    <div className='flex h-8 items-center gap-1 rounded-md border border-slate-200 p-0.5 dark:border-border'>
                      {(['create', 'upsert'] as const).map((m) => (
                        <button
                          type='button'
                          key={m}
                          onClick={() => setDraft((d) => ({ ...d, mode: m }))}
                          className={cn(
                            'flex-1 rounded px-2 text-[12px]',
                            draft.mode === m
                              ? 'bg-slate-900 text-white dark:bg-foreground dark:text-background'
                              : 'text-slate-600'
                          )}
                        >
                          {m === 'create' ? 'Always create' : 'Upsert by key'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {draft.mode === 'upsert' && (
                    <div className='sm:col-span-2'>
                      <Label className='text-[11px]'>
                        Upsert keys (mapped field names, comma-separated)
                      </Label>
                      <Input
                        value={draft.upsert_keys}
                        onChange={(e) => setDraft((d) => ({ ...d, upsert_keys: e.target.value }))}
                        className='h-8 font-mono text-[13px]'
                        placeholder='external_ref'
                      />
                    </div>
                  )}
                  <div className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground sm:col-span-2'>
                    <Switch
                      checked={draft.is_active}
                      onCheckedChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
                      aria-label='Active'
                    />
                    Active — inactive mappings answer 404
                  </div>
                </div>
                <div className='mt-4'>
                  <Label className='text-[11px]'>
                    Rules — target field ← source key on the payload
                  </Label>
                  <p className='mb-2 text-[11px] text-slate-400'>
                    Same rule steps as import templates: trim, remap, expression, lookup, const.
                    Source is a key on the posted object; nested keys use dots.
                  </p>
                  <RulesForCollection
                    collection={draft.collection || null}
                    rules={draft.rules}
                    onChange={(rules) => setDraft((d) => ({ ...d, rules }))}
                  />
                </div>
                <ChildrenEditor
                  collection={draft.collection || null}
                  value={draft.children}
                  onChange={(children) => setDraft((d) => ({ ...d, children }))}
                />
                <ResponseEditor
                  template={draft.response_template}
                  status={draft.response_status}
                  onTemplate={(response_template) => setDraft((d) => ({ ...d, response_template }))}
                  onStatus={(response_status) => setDraft((d) => ({ ...d, response_status }))}
                />
                <div className='mt-4 flex items-center gap-2'>
                  {selected === 'new' ? (
                    <Button
                      size='sm'
                      className='h-8'
                      disabled={!draft.key || !draft.label || !draft.collection || create.isPending}
                      onClick={() => create.mutate()}
                      data-inbound-save
                    >
                      {create.isPending ? 'Creating…' : 'Create mapping'}
                    </Button>
                  ) : (
                    <Button
                      size='sm'
                      className='h-8'
                      disabled={save.isPending}
                      onClick={() => save.mutate()}
                      data-inbound-save
                    >
                      {save.isPending ? 'Saving…' : 'Save'}
                    </Button>
                  )}
                  {current && (
                    <>
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-8'
                        onClick={() => {
                          void navigator.clipboard?.writeText(
                            `${window.location.origin}${current.endpoint}`
                          )
                          toast.success('Endpoint copied')
                        }}
                      >
                        <Copy className='mr-1.5 h-3.5 w-3.5' /> Copy endpoint
                      </Button>
                      <span className='ml-auto' />
                      {confirmDelete ? (
                        <>
                          <span className='text-[11px] text-slate-500'>Delete this mapping?</span>
                          <Button
                            size='sm'
                            variant='destructive'
                            className='h-7'
                            onClick={() => remove.mutate(current.id)}
                          >
                            Yes, delete
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            className='h-7'
                            onClick={() => setConfirmDelete(false)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-8 text-red-600'
                          onClick={() => setConfirmDelete(true)}
                        >
                          <Trash2 className='mr-1.5 h-3.5 w-3.5' /> Delete
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {current && <FixtureBench mapping={current} draft={draft} />}
              {current && <TestPanel mapping={current} draft={draft} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RulesForCollection({
  collection,
  rules,
  onChange
}: {
  collection: string | null
  rules: ImportHeaderRule[]
  onChange: (r: ImportHeaderRule[]) => void
}) {
  const { data: fields } = useFieldOptions(collection)
  const options = fields
    ? fields
        .filter((f) => f.field !== 'id')
        .map((f) => ({ value: f.field, label: f.label ? `${f.label} (${f.field})` : f.field }))
    : null
  if (!collection) return <p className='text-[12px] text-slate-400'>Pick a collection first.</p>
  return (
    <RuleEditor
      rules={rules}
      onChange={onChange}
      fieldOptions={options}
      basePath='rules'
      errors={[]}
    />
  )
}

function useRelations(collection: string | null) {
  return useQuery({
    queryKey: ['inbound-relations', collection],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            one_collection: string | null
            one_field: string | null
            many_collection: string
            junction_field: string | null
          }>
        }>(`/data-model/relations/for/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
  })
}

/** #824 — nested one-to-many rules: payload arrays onto the record's child sets. */
function ChildrenEditor({
  collection,
  value,
  onChange
}: {
  collection: string | null
  value: ChildConfig[]
  onChange: (v: ChildConfig[]) => void
}) {
  const { data: rels = [] } = useRelations(collection)
  const aliases = rels
    .filter(
      (r) =>
        r.one_collection === collection &&
        r.one_field &&
        r.one_field !== 'id' &&
        !r.junction_field &&
        !r.many_collection.startsWith('nivaro_')
    )
    .map((r) => ({
      value: r.one_field as string,
      label: `${r.one_field} → ${r.many_collection}`,
      collection: r.many_collection
    }))
  const set = (i: number, patch: Partial<ChildConfig>) =>
    onChange(value.map((c, n) => (n === i ? { ...c, ...patch } : c)))
  return (
    <div className='mt-5 border-t border-slate-100 pt-4 dark:border-border' data-inbound-children>
      <div className='flex items-center justify-between'>
        <div>
          <Label className='text-[11px]'>Child rows</Label>
          <p className='text-[11px] text-slate-400'>
            Map an array in the payload onto a one-to-many field. The record and its rows are
            written in one call; if any row is refused, nothing is created.
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8'
          disabled={!collection || aliases.length === 0}
          onClick={() =>
            onChange([
              ...value,
              { target_field: '', source: '', row_filter: null, columns: [], on_update: 'append' }
            ])
          }
          data-inbound-child-add
        >
          <Plus className='mr-1.5 h-3.5 w-3.5' /> Add child rows
        </Button>
      </div>
      {collection && aliases.length === 0 && (
        <p className='mt-2 text-[11px] text-slate-400'>
          {collection} has no one-to-many fields to fill.
        </p>
      )}
      <div className='mt-3 space-y-3'>
        {value.map((c, i) => {
          const target = aliases.find((a) => a.value === c.target_field)
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: child sets have no id until saved
              key={i}
              className='rounded-md border border-slate-200 p-3 dark:border-border'
              data-inbound-child={c.target_field || i}
            >
              <div className='grid gap-3 sm:grid-cols-3'>
                <div>
                  <Label className='text-[11px]'>Field</Label>
                  <Combobox
                    value={c.target_field}
                    onChange={(v) => set(i, { target_field: v, columns: [] })}
                    options={aliases.map((a) => ({ value: a.value, label: a.label }))}
                    placeholder='one-to-many field…'
                  />
                </div>
                <div>
                  <Label className='text-[11px]'>Rows at (payload path)</Label>
                  <Input
                    value={c.source}
                    onChange={(e) => set(i, { source: e.target.value })}
                    className='h-8 font-mono text-[12px]'
                    placeholder='order.lines'
                    data-inbound-child-source
                  />
                </div>
                <div>
                  <Label className='text-[11px]'>When the record already exists</Label>
                  <SimpleSelect
                    value={c.on_update}
                    onChange={(v) => set(i, { on_update: v as ChildConfig['on_update'] })}
                    options={[
                      { value: 'append', label: 'Add these rows' },
                      { value: 'replace', label: 'Replace its rows with these' }
                    ]}
                    className='h-8 text-[12px]'
                    ariaLabel='When the record already exists'
                  />
                </div>
              </div>
              <div className='mt-3'>
                <RowFilterEditor
                  value={c.row_filter}
                  onChange={(row_filter) => set(i, { row_filter })}
                />
              </div>
              <div className='mt-3'>
                <Label className='text-[11px]'>Row rules — field ← key on each row</Label>
                <p className='mb-2 text-[11px] text-slate-400'>
                  {'{{$resolved.<field>}}'} reads a value the record rules above produced.
                </p>
                <RulesForCollection
                  collection={target?.collection ?? null}
                  rules={c.columns}
                  onChange={(columns) => set(i, { columns })}
                />
              </div>
              <div className='mt-2 flex justify-end'>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 text-red-600 dark:text-red-400'
                  onClick={() => onChange(value.filter((_, n) => n !== i))}
                >
                  <Trash2 className='mr-1.5 h-3.5 w-3.5' /> Remove
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** #825 — the envelope and status a partner gets back. */
function ResponseEditor({
  template,
  status,
  onTemplate,
  onStatus
}: {
  template: string
  status: Record<Outcome, string>
  onTemplate: (v: string) => void
  onStatus: (v: Record<Outcome, string>) => void
}) {
  const labels: Record<Outcome, string> = {
    success: 'All written',
    partial: 'Some refused',
    rejected: 'All refused'
  }
  return (
    <div className='mt-5 border-t border-slate-100 pt-4 dark:border-border' data-inbound-response>
      <Label className='text-[11px]'>Response to the caller</Label>
      <p className='text-[11px] text-slate-400'>
        Leave the template empty to answer with the standard body. Liquid, with{' '}
        <code className='font-mono'>record</code>, <code className='font-mono'>records</code>,{' '}
        <code className='font-mono'>created</code>, <code className='font-mono'>updated</code>,{' '}
        <code className='font-mono'>rejected</code>, <code className='font-mono'>created_ids</code>,{' '}
        <code className='font-mono'>errors</code> (index, message) and{' '}
        <code className='font-mono'>outcome</code>. Use{' '}
        <code className='font-mono'>{'{{ record.id | jsonify }}'}</code> inside JSON.
      </p>
      <textarea
        value={template}
        onChange={(e) => onTemplate(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={'{"accepted": true, "reference": {{ record.id | jsonify }}}'}
        className='mt-2 w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 font-mono text-[11.5px] text-slate-800 dark:border-border dark:bg-background dark:text-foreground'
        data-inbound-response-template
      />
      <div className='mt-2 grid gap-3 sm:grid-cols-3'>
        {(['success', 'partial', 'rejected'] as const).map((k) => (
          <div key={k}>
            <Label className='text-[11px]'>{labels[k]} → status</Label>
            <Input
              value={status[k]}
              onChange={(e) =>
                onStatus({ ...status, [k]: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) })
              }
              placeholder={String(DEFAULT_STATUS[k])}
              className='h-8 font-mono text-[12px]'
              data-inbound-response-status={k}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function ResponsePreview({ response }: { response: ShapedResponse }) {
  return (
    <div
      className='rounded-md border border-slate-200 bg-slate-50 p-2.5 dark:border-border dark:bg-muted/30'
      data-inbound-response-preview={response.status}
    >
      <div className='flex items-center gap-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
        <span className='font-mono font-semibold text-slate-800 dark:text-foreground'>
          {response.status}
        </span>
        <span>{response.content_type}</span>
        <span>· {response.shaped ? 'your template' : 'standard body'}</span>
      </div>
      {response.template_error && (
        <p className='mt-1 text-[11px] text-red-600 dark:text-red-400'>
          Template failed, standard body sent: {response.template_error}
        </p>
      )}
      <pre className='mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-700 dark:text-foreground'>
        {prettyBody(response.body)}
      </pre>
    </div>
  )
}

function EntryList({ results }: { results: RunEntry[] }) {
  return (
    <div className='space-y-2'>
      {results.map((r) => (
        <div
          key={r.index}
          className='rounded-md border border-slate-200 p-2.5 text-[12px] dark:border-border'
        >
          <div className='flex flex-wrap items-center gap-2'>
            <span
              className={cn(
                'rounded px-1.5 text-[10.5px] font-semibold uppercase',
                r.action === 'rejected' ? PILL.bad : PILL.ok
              )}
            >
              {r.action === 'preview' ? `would ${r.would ?? 'write'}` : r.action}
            </span>
            <span className='text-slate-400'>entry {r.index + 1}</span>
            {r.error && <span className='text-red-600 dark:text-red-400'>{r.error}</span>}
          </div>
          {r.child_error && (
            <p className='mt-1 text-[11px] text-red-600 dark:text-red-400' data-inbound-child-error>
              {r.child_error.field}
              {r.child_error.index != null ? ` row ${r.child_error.index + 1}` : ''}:{' '}
              {r.child_error.message}
            </p>
          )}
          <dl className='mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2'>
            {Object.entries(r.values).map(([k, v]) => (
              <div key={k} className='flex gap-2'>
                <dt className='font-mono text-slate-500 dark:text-muted-foreground'>{k}</dt>
                <dd className='truncate text-slate-800 dark:text-foreground'>
                  {v == null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </dd>
              </div>
            ))}
          </dl>
          {r.children && r.children.length > 0 && (
            <p className='mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {r.children
                .map((c) => `${c.field}: ${c.rows} of ${c.found} row${c.found === 1 ? '' : 's'}`)
                .join(' · ')}
            </p>
          )}
          {r.issues.length > 0 && (
            <ul className='mt-1.5 space-y-0.5'>
              {r.issues.map((i, n) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: issue list has no id
                  key={n}
                  className={cn(
                    'text-[11px]',
                    i.severity === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400'
                  )}
                >
                  {i.rule}: {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

interface FixtureRun {
  id: string
  name: string
  expect: 'write' | 'reject'
  pass: boolean
  reason: string
  run: { results: RunEntry[] } | null
  response: ShapedResponse | null
}

/**
 * #624 — saved partner payloads, re-run against the rules as they are being
 * edited. Green = the fixture does what it should (writes, or is refused when
 * it is marked "should be refused"); red names the entry and the reason.
 */
function FixtureBench({ mapping, draft }: { mapping: Mapping; draft: Draft }) {
  const queryClient = useQueryClient()
  const fixtures = mapping.fixtures ?? []
  const body = draftRunBody(draft)
  const bodyKey = JSON.stringify(body)
  const [debouncedKey, setDebouncedKey] = useState(bodyKey)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(bodyKey), 700)
    return () => clearTimeout(t)
  }, [bodyKey])
  const fixturesKey = fixtures.map((f) => `${f.id}:${f.expect}:${f.saved_at}`).join('|')
  const bench = useQuery({
    queryKey: ['inbound-bench', mapping.id, debouncedKey, fixturesKey],
    queryFn: () =>
      api
        .post<{ data: { fixtures: FixtureRun[]; passed: number; failed: number } }>(
          `/inbound-mappings/${mapping.id}/fixtures/run`,
          JSON.parse(debouncedKey)
        )
        .then((r) => r.data.data),
    enabled: fixtures.length > 0,
    retry: false
  })
  const running = bench.isFetching || debouncedKey !== bodyKey
  const runs = new Map((bench.data?.fixtures ?? []).map((f) => [f.id, f]))
  const benchError = (bench.error as { response?: { data?: { error?: string } } } | null)?.response
    ?.data?.error
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inbound-mappings'] })
  const onErr = (e: { response?: { data?: { error?: string } } }) =>
    toast.error(e.response?.data?.error ?? 'Request failed', { duration: 8000 })

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [expect, setExpect] = useState<'write' | 'reject'>('write')
  const [payload, setPayload] = useState('{\n  \n}')
  const parsed = (() => {
    try {
      return { ok: true as const, value: JSON.parse(payload) as unknown }
    } catch {
      return { ok: false as const, value: undefined }
    }
  })()
  const add = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      api.post(`/inbound-mappings/${mapping.id}/fixtures`, b),
    onSuccess: () => {
      refresh()
      setAdding(false)
      setName('')
      setPayload('{\n  \n}')
      toast.success('Fixture saved')
    },
    onError: onErr
  })
  const patch = useMutation({
    mutationFn: ({ id, ...b }: { id: string; expect?: string }) =>
      api.patch(`/inbound-mappings/${mapping.id}/fixtures/${id}`, b),
    onSuccess: refresh,
    onError: onErr
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/inbound-mappings/${mapping.id}/fixtures/${id}`),
    onSuccess: refresh,
    onError: onErr
  })
  const [open, setOpen] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'
      data-inbound-bench
    >
      <div className='flex flex-wrap items-center gap-2'>
        <div className='mr-auto'>
          <Label className='text-[11px]'>Fixtures — saved payloads, re-run on every edit</Label>
          <p className='text-[11px] text-slate-400'>
            Each runs against the rules as edited, saved or not. Nothing is written; the database
            insert itself is not tried, so a type or foreign-key refusal shows only on a real call.
          </p>
        </div>
        {fixtures.length > 0 && (
          <span
            className={cn(
              'rounded px-2 py-0.5 text-[11px] font-medium',
              running || !bench.data ? PILL.muted : bench.data.failed ? PILL.bad : PILL.ok
            )}
            data-inbound-bench-summary={
              running || !bench.data ? 'running' : bench.data.failed ? 'fail' : 'pass'
            }
          >
            {running || !bench.data
              ? 'Running…'
              : `${bench.data.passed} of ${bench.data.fixtures.length} pass`}
          </span>
        )}
        <CandidatePicker
          mappingId={mapping.id}
          full={fixtures.length >= 20}
          onPick={(logId) => add.mutate({ log_id: logId, name: `Call #${logId}` })}
        />
        <Button
          size='sm'
          variant='outline'
          className='h-8'
          disabled={fixtures.length >= 20}
          onClick={() => setAdding((v) => !v)}
          data-inbound-fixture-paste
        >
          <Plus className='mr-1.5 h-3.5 w-3.5' /> Paste a payload
        </Button>
      </div>
      {benchError && (
        <p className='mt-2 text-[11px] text-red-600 dark:text-red-400'>
          The edited config does not validate yet: {benchError}
        </p>
      )}
      {adding && (
        <div
          className='mt-3 space-y-2 rounded-md border border-slate-200 p-3 dark:border-border'
          data-inbound-fixture-form
        >
          <div className='grid gap-3 sm:grid-cols-2'>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Name — e.g. Order with two lines'
              className='h-8 text-[12px]'
            />
            <SimpleSelect
              value={expect}
              onChange={(v) => setExpect(v as 'write' | 'reject')}
              options={[
                { value: 'write', label: 'Should be written' },
                { value: 'reject', label: 'Should be refused' }
              ]}
              className='h-8 text-[12px]'
              ariaLabel='Expected result'
            />
          </div>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={6}
            spellCheck={false}
            className={cn(
              'w-full rounded-md border bg-white px-2.5 py-2 font-mono text-[11.5px] dark:bg-background dark:text-foreground',
              parsed.ok ? 'border-slate-200 dark:border-border' : 'border-red-400'
            )}
          />
          <div className='flex gap-2'>
            <Button
              size='sm'
              className='h-8'
              disabled={!parsed.ok || add.isPending}
              onClick={() => add.mutate({ name, expect, payload: parsed.value })}
              data-inbound-fixture-add
            >
              Save fixture
            </Button>
            <Button size='sm' variant='outline' className='h-8' onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {fixtures.length === 0 && !adding && (
        <p className='mt-3 text-[12px] text-slate-400'>
          No fixtures yet. Save a real partner payload — from a recent call or pasted — and every
          rule change is checked against it.
        </p>
      )}
      <ul className='mt-3 divide-y divide-slate-100 dark:divide-border'>
        {fixtures.map((f) => {
          const r = runs.get(f.id)
          const state = running || !r ? 'running' : r.pass ? 'pass' : 'fail'
          return (
            <li key={f.id} className='py-2' data-inbound-fixture={f.id} data-fixture-state={state}>
              <div className='flex items-start gap-2'>
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded px-1.5 text-[10.5px] font-semibold uppercase',
                    state === 'pass' ? PILL.ok : state === 'fail' ? PILL.bad : PILL.muted
                  )}
                >
                  {state === 'running' ? '…' : state}
                </span>
                <button
                  type='button'
                  className='min-w-0 flex-1 text-left'
                  onClick={() => setOpen((o) => (o === f.id ? null : f.id))}
                >
                  <span className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                    {f.name}
                  </span>
                  {f.source_log_id != null && (
                    <span className='ml-1.5 font-mono text-[10.5px] text-slate-400'>
                      call #{f.source_log_id}
                    </span>
                  )}
                  {r && (
                    <span
                      className={cn(
                        'block text-[11px]',
                        r.pass
                          ? 'text-slate-500 dark:text-muted-foreground'
                          : 'text-red-600 dark:text-red-400'
                      )}
                      data-fixture-reason
                    >
                      {r.reason}
                    </span>
                  )}
                </button>
                <SimpleSelect
                  value={f.expect}
                  onChange={(v) => patch.mutate({ id: f.id, expect: v })}
                  options={[
                    { value: 'write', label: 'Should write' },
                    { value: 'reject', label: 'Should refuse' }
                  ]}
                  className='h-7 w-[130px] text-[11px]'
                  ariaLabel='Expected result'
                />
                {confirmDel === f.id ? (
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-7'
                    onClick={() => remove.mutate(f.id)}
                    onBlur={() => setConfirmDel(null)}
                  >
                    Delete?
                  </Button>
                ) : (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 px-2 text-slate-400 hover:text-red-600'
                    aria-label={`Delete ${f.name}`}
                    onClick={() => setConfirmDel(f.id)}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </Button>
                )}
              </div>
              {open === f.id && (
                <div className='mt-2 grid gap-3 lg:grid-cols-2' data-inbound-fixture-detail>
                  <div>
                    <Label className='text-[11px]'>Payload</Label>
                    <pre className='mt-1 max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] text-slate-700 dark:border-border dark:bg-muted/30 dark:text-foreground'>
                      {prettyBody(f.payload)}
                    </pre>
                  </div>
                  <div className='space-y-2'>
                    {r?.response && <ResponsePreview response={r.response} />}
                    {r?.run && <EntryList results={r.run.results} />}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface Candidate {
  id: number
  at: string
  status: number
  caller: string | null
  error: string | null
  usable: boolean
  reason: string | null
  preview: string
}

/** Recent calls to this mapping's endpoint whose body was kept. */
function CandidatePicker({
  mappingId,
  full,
  onPick
}: {
  mappingId: number
  full: boolean
  onPick: (logId: number) => void
}) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['inbound-fixture-candidates', mappingId],
    queryFn: () =>
      api
        .get<{ data: Candidate[] }>(`/inbound-mappings/${mappingId}/fixtures/candidates`)
        .then((r) => r.data.data),
    enabled: open
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          className='h-8'
          disabled={full}
          data-inbound-fixture-candidates
        >
          <History className='mr-1.5 h-3.5 w-3.5' /> From a recent call
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[440px] p-0'>
        <div className='border-b border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          Calls to this endpoint by a token or API key keep their body for 14 days.
        </div>
        <div className='max-h-80 overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-2 p-3'>
              <Skeleton className='h-8 rounded' />
              <Skeleton className='h-8 rounded' />
            </div>
          ) : (data ?? []).length === 0 ? (
            <p className='p-3 text-[12px] text-slate-400'>No recent calls with a stored body.</p>
          ) : (
            (data ?? []).map((c) => (
              <button
                type='button'
                key={c.id}
                disabled={!c.usable}
                onClick={() => {
                  onPick(c.id)
                  setOpen(false)
                }}
                className='block w-full border-b border-slate-100 px-3 py-2 text-left last:border-0 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-border dark:hover:bg-muted/40'
                data-inbound-candidate={c.id}
              >
                <div className='flex items-center gap-2 text-[11px]'>
                  <span
                    className={cn(
                      'rounded px-1 font-mono font-semibold',
                      c.status >= 400 ? PILL.bad : PILL.ok
                    )}
                  >
                    {c.status}
                  </span>
                  <span className='text-slate-600 dark:text-foreground'>
                    {c.caller ?? 'caller'}
                  </span>
                  <span className='ml-auto text-slate-400'>{new Date(c.at).toLocaleString()}</span>
                </div>
                <p className='mt-0.5 truncate font-mono text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                  {c.usable ? c.preview : c.reason}
                </p>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TestPanel({ mapping, draft }: { mapping: Mapping; draft: Draft }) {
  const queryClient = useQueryClient()
  const [sample, setSample] = useState('{\n  \n}')
  const [result, setResult] = useState<null | {
    results: RunEntry[]
    response: ShapedResponse
  }>(null)
  const parsed = (() => {
    try {
      return { ok: true as const, value: JSON.parse(sample) as unknown }
    } catch {
      return { ok: false as const, value: undefined }
    }
  })()
  const test = useMutation({
    mutationFn: () =>
      api
        .post<{ data: typeof result }>(`/inbound-mappings/${mapping.id}/test`, {
          sample: parsed.value,
          ...draftRunBody(draft)
        })
        .then((r) => r.data.data),
    onSuccess: (d) => setResult(d),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Test failed', { duration: 8000 })
  })
  const keep = useMutation({
    mutationFn: () =>
      api.post(`/inbound-mappings/${mapping.id}/fixtures`, {
        payload: parsed.value,
        name: `Sample ${new Date().toLocaleString()}`
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbound-mappings'] })
      toast.success('Saved as a fixture')
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Could not save', { duration: 8000 })
  })
  return (
    <div
      className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'
      data-inbound-test
    >
      <div className='flex items-center justify-between gap-2'>
        <div className='mr-auto'>
          <Label className='text-[11px]'>Try a payload (dry run — nothing is written)</Label>
          <p className='text-[11px] text-slate-400'>
            Uses the rules, child rows and response as currently edited, saved or not.
          </p>
        </div>
        <Button
          size='sm'
          variant='ghost'
          className='h-8'
          disabled={!parsed.ok || keep.isPending}
          onClick={() => keep.mutate()}
          data-inbound-test-keep
        >
          Save as fixture
        </Button>
        <Button
          size='sm'
          variant='outline'
          className='h-8'
          disabled={!parsed.ok || test.isPending}
          onClick={() => test.mutate()}
          data-inbound-test-run
        >
          {test.isPending ? 'Mapping…' : 'Map it'}
        </Button>
      </div>
      <textarea
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        rows={6}
        spellCheck={false}
        className={cn(
          'mt-2 w-full rounded-md border bg-white px-2.5 py-2 font-mono text-[11.5px] dark:bg-background dark:text-foreground',
          parsed.ok ? 'border-slate-200 dark:border-border' : 'border-red-400'
        )}
      />
      {result && (
        <div className='mt-3 space-y-2' data-inbound-test-result>
          <ResponsePreview response={result.response} />
          <EntryList results={result.results} />
        </div>
      )}
    </div>
  )
}
