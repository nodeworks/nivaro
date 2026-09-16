import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Inbox, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, type Collection } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Combobox,
  type ImportHeaderRule,
  RuleEditor,
  useFieldOptions
} from './ImportTemplatesSection'

// ─── #88 — inbound mappings ─────────────────────────────────────────────────
// An integration POSTs its own payload shape to /api/inbound/<key>; the rules
// (the import-template header-rule format) turn it into a record. Master-
// detail: list left, editor + tester right.

interface Mapping {
  id: number
  key: string
  label: string
  collection: string
  mode: 'create' | 'upsert'
  upsert_keys: string[]
  rules: ImportHeaderRule[]
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
  is_active: boolean
}

const EMPTY: Draft = {
  key: '',
  label: '',
  collection: '',
  mode: 'create',
  upsert_keys: '',
  rules: [],
  is_active: true
}

function toDraft(m: Mapping): Draft {
  return {
    key: m.key,
    label: m.label,
    collection: m.collection,
    mode: m.mode,
    upsert_keys: m.upsert_keys.join(', '),
    rules: m.rules,
    is_active: m.is_active
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
    is_active: d.is_active
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
  useEffect(() => {
    if (selected === 'new') setDraft(EMPTY)
    else if (current) setDraft(toDraft(current))
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
                      placeholder='Vendor orders from LinX'
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
                      onChange={(v) => setDraft((d) => ({ ...d, collection: v, rules: [] }))}
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
                  <label className='flex items-center gap-2 text-[12px] text-slate-600 sm:col-span-2'>
                    <Switch
                      checked={draft.is_active}
                      onCheckedChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
                    />
                    Active — inactive mappings answer 404
                  </label>
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
              {current && <TestPanel mapping={current} rules={draft.rules} />}
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

function TestPanel({ mapping, rules }: { mapping: Mapping; rules: ImportHeaderRule[] }) {
  const [sample, setSample] = useState('{\n  \n}')
  const [result, setResult] = useState<null | {
    results: Array<{
      index: number
      action: string
      values: Record<string, unknown>
      issues: Array<{ severity: string; rule: string; message: string }>
      error?: string
    }>
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
          rules
        })
        .then((r) => r.data.data),
    onSuccess: (d) => setResult(d),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Test failed', { duration: 8000 })
  })
  return (
    <div
      className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'
      data-inbound-test
    >
      <div className='flex items-center justify-between'>
        <div>
          <Label className='text-[11px]'>Try a payload (dry run — nothing is written)</Label>
          <p className='text-[11px] text-slate-400'>
            Uses the rules as currently edited, saved or not.
          </p>
        </div>
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
          'mt-2 w-full rounded-md border bg-white px-2.5 py-2 font-mono text-[11.5px] dark:bg-background',
          parsed.ok ? 'border-slate-200 dark:border-border' : 'border-red-400'
        )}
      />
      {result && (
        <div className='mt-3 space-y-2' data-inbound-test-result>
          {result.results.map((r) => (
            <div
              key={r.index}
              className='rounded-md border border-slate-200 p-2.5 text-[12px] dark:border-border'
            >
              <div className='flex items-center gap-2'>
                <span
                  className={cn(
                    'rounded px-1.5 text-[10.5px] font-semibold uppercase',
                    r.action === 'rejected'
                      ? 'bg-red-50 text-red-700'
                      : 'bg-emerald-50 text-emerald-700'
                  )}
                >
                  {r.action === 'preview' ? 'would write' : r.action}
                </span>
                <span className='text-slate-400'>entry {r.index + 1}</span>
                {r.error && <span className='text-red-600'>{r.error}</span>}
              </div>
              <dl className='mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2'>
                {Object.entries(r.values).map(([k, v]) => (
                  <div key={k} className='flex gap-2'>
                    <dt className='font-mono text-slate-500'>{k}</dt>
                    <dd className='truncate text-slate-800 dark:text-foreground'>
                      {v == null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
              {r.issues.length > 0 && (
                <ul className='mt-1.5 space-y-0.5'>
                  {r.issues.map((i, n) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: issue list has no id
                    <li
                      key={n}
                      className={cn(
                        'text-[11px]',
                        i.severity === 'error' ? 'text-red-600' : 'text-amber-600'
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
      )}
    </div>
  )
}
