/**
 * Collection Designer — AI-assisted collection creation.
 *
 * Proposal-first by design: describe a collection (or upload a spreadsheet),
 * the AI proposes a plan, and NOTHING is created until the reviewed/edited
 * summary is explicitly applied. Backed by /data-model/designer/*.
 */
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  ArrowLeft,
  FileSpreadsheet,
  Link2,
  Loader2,
  Sparkles,
  Upload,
  Wand2,
  X
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

interface DesignField {
  field: string
  label?: string
  type: string
  interface?: string
  required?: boolean
  options?: { choices?: { value: string; text: string }[] } | null
  relation?: { related_collection: string; match_field?: string | null; junction?: string | null } | null
  source_column?: string | null
  _exclude?: boolean
}
interface DesignCollection {
  collection: string
  display_name: string
  singular?: string | null
  note?: string | null
  display_template?: string | null
  fields: DesignField[]
  import_key?: string[]
}
interface DesignPlan {
  collections: DesignCollection[]
  notes?: string
}
interface SheetInfo {
  name: string
  columns: string[]
  row_count: number
}

const FIELD_TYPES = [
  'm2m',
  'string',
  'text',
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'boolean',
  'date',
  'datetime',
  'uuid'
]
const IFACES = ['input', 'textarea', 'rich_text', 'select-dropdown', 'boolean', 'datetime', 'tags']

export function CollectionDesigner({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'describe' | 'file'>('describe')
  const [prompt, setPrompt] = useState('')
  const [fileToken, setFileToken] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SheetInfo[]>([])
  const [sheet, setSheet] = useState<string>('')
  const [plan, setPlan] = useState<DesignPlan | null>(null)
  const [refine, setRefine] = useState('')
  const [importRows, setImportRows] = useState(true)
  const [createImport, setCreateImport] = useState(true)
  const fileInput = useRef<HTMLInputElement>(null)

  const { data: existingCollections } = useQuery<{ collection: string }[]>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data),
    staleTime: 60_000,
    enabled: open
  })
  const relationTargets = useMemo(() => {
    const names = new Set<string>(['nivaro_users'])
    for (const c of existingCollections ?? []) {
      if (!c.collection.startsWith('nivaro_')) names.add(c.collection)
    }
    for (const c of plan?.collections ?? []) names.add(c.collection)
    return [...names].sort()
  }, [existingCollections, plan])

  const parse = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      return api
        .post<{ data: { file_token: string; file_name: string; sheets: SheetInfo[] } }>(
          '/data-model/designer/parse',
          fd,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        )
        .then((r) => r.data.data)
    },
    onSuccess: (d) => {
      setFileToken(d.file_token)
      setFileName(d.file_name)
      setSheets(d.sheets)
      setSheet(d.sheets[0]?.name ?? '')
    },
    onError: (err: unknown) => toast.error(errMsg(err, 'Could not parse the file'))
  })

  const analyze = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api
        .post<{ data: { plan: DesignPlan } }>('/data-model/designer/analyze', body)
        .then((r) => r.data.data),
    onSuccess: (d) => {
      setPlan(d.plan)
      setRefine('')
    },
    onError: (err: unknown) => toast.error(errMsg(err, 'AI analysis failed'), { duration: 9000 })
  })

  const apply = useMutation({
    mutationFn: () => {
      const cleaned: DesignPlan = {
        collections: (plan?.collections ?? []).map((c) => ({
          ...c,
          fields: c.fields.filter((f) => !f._exclude).map(({ _exclude, ...f }) => f)
        }))
      }
      return api
        .post<{
          data: {
            created: string[]
            imported: { inserted: number; skipped: number } | null
            import_pipeline: { collection: string; procedure: string; staging_table: string }[]
            errors: string[]
          }
        }>('/data-model/designer/apply', {
          plan: cleaned,
          import:
            mode === 'file' && importRows && fileToken ? { file_token: fileToken, sheet } : null,
          create_import: mode === 'file' && createImport
        })
        .then((r) => r.data.data)
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['data-model-tables'] })
      qc.invalidateQueries({ queryKey: ['collections'] })
      if (!d.created.length) {
        toast.error(d.errors[0] ?? 'Nothing was created')
        return
      }
      toast.success(
        `Created ${d.created.join(', ')}${d.imported ? ` — imported ${d.imported.inserted} rows` : ''}${
          d.import_pipeline?.length
            ? ` — ${d.import_pipeline.map((p) => p.procedure).join(', ')} ready in the Import Console`
            : ''
        }`,
        { duration: 9000 }
      )
      for (const e of d.errors) toast.warning(e, { duration: 10000 })
      onClose()
      navigate(`/data-model/${d.created[0]}`)
    },
    onError: (err: unknown) => toast.error(errMsg(err, 'Create failed'), { duration: 9000 })
  })

  const activeSheet = sheets.find((s) => s.name === sheet)
  const busy = analyze.isPending || apply.isPending

  const updateCollection = (ci: number, patch: Partial<DesignCollection>) =>
    setPlan((p) =>
      p
        ? {
            ...p,
            collections: p.collections.map((c, i) => (i === ci ? { ...c, ...patch } : c))
          }
        : p
    )
  const createLookupCollection = (ci: number, fi: number) =>
    setPlan((p) => {
      if (!p) return p
      const f = p.collections[ci]?.fields[fi]
      if (!f) return p
      const base = f.field.replace(/_?(id|name|code|number)$/, '') || f.field
      let name = base.endsWith('s') ? base : `${base}s`
      const taken = new Set(p.collections.map((c) => c.collection))
      if (taken.has(name)) name = `${name}_lookup`
      const lookup: DesignCollection = {
        collection: name,
        display_name: name
          .split('_')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' '),
        display_template: '{{name}}',
        fields: [{ field: 'name', type: 'string', interface: 'input', required: true }],
        import_key: []
      }
      return {
        ...p,
        collections: [
          ...p.collections.map((c, i) =>
            i === ci
              ? {
                  ...c,
                  fields: c.fields.map((ff, j) =>
                    j === fi
                      ? {
                          ...ff,
                          type: ff.type === 'm2m' ? 'm2m' : 'integer',
                          relation: { related_collection: name, match_field: 'name' }
                        }
                      : ff
                  )
                }
              : c
          ),
          lookup
        ]
      }
    })
  const updateField = (ci: number, fi: number, patch: Partial<DesignField>) =>
    setPlan((p) =>
      p
        ? {
            ...p,
            collections: p.collections.map((c, i) =>
              i === ci
                ? { ...c, fields: c.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)) }
                : c
            )
          }
        : p
    )

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side='right' className='flex w-[920px] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[96vw]'>
        <SheetHeader className='shrink-0 border-b border-slate-200 px-5 py-3.5 dark:border-border'>
          <SheetTitle className='flex items-center gap-2 text-[15px]'>
            <Sparkles className='h-4 w-4 text-[#00ceff]' />
            Design a collection with AI
            {plan && (
              <button
                type='button'
                className='ml-2 inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-border dark:text-slate-400'
                onClick={() => setPlan(null)}
              >
                <ArrowLeft className='h-3 w-3' /> Start over
              </button>
            )}
          </SheetTitle>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {plan
              ? 'Review the proposal below — rename, retype, exclude, or refine. Nothing is created until you click Create.'
              : 'Describe what you need, or upload a spreadsheet and let AI infer the fields and relationships.'}
          </p>
        </SheetHeader>

        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
          {!plan ? (
            <div className='space-y-4'>
              <div className='inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-border'>
                {(['describe', 'file'] as const).map((m) => (
                  <button
                    key={m}
                    type='button'
                    onClick={() => setMode(m)}
                    className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      mode === m
                        ? 'bg-[#00ceff]/10 text-[#009abe] dark:text-nvr-cyan'
                        : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                    }`}
                  >
                    {m === 'describe' ? 'Describe it' : 'From a file'}
                  </button>
                ))}
              </div>

              {mode === 'file' && (
                <div className='space-y-3'>
                  <input
                    ref={fileInput}
                    type='file'
                    accept='.xlsx,.xls,.csv'
                    className='hidden'
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) parse.mutate(f)
                      e.target.value = ''
                    }}
                  />
                  {!fileToken ? (
                    <button
                      type='button'
                      onClick={() => fileInput.current?.click()}
                      className='flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-200 px-6 py-10 text-slate-400 transition-colors hover:border-[#00ceff]/50 hover:text-slate-600 dark:border-border'
                    >
                      {parse.isPending ? (
                        <Loader2 className='h-6 w-6 animate-spin' />
                      ) : (
                        <Upload className='h-6 w-6' />
                      )}
                      <span className='text-[13px] font-medium'>
                        {parse.isPending ? 'Parsing…' : 'Upload an Excel or CSV file'}
                      </span>
                      <span className='text-[11px]'>Headers + sample rows are analyzed — the file never leaves this server</span>
                    </button>
                  ) : (
                    <div className='space-y-3 rounded-lg border border-slate-200 p-3 dark:border-border'>
                      <div className='flex items-center gap-2 text-[13px]'>
                        <FileSpreadsheet className='h-4 w-4 text-emerald-500' />
                        <span className='font-medium text-slate-700 dark:text-foreground'>{fileName}</span>
                        <button
                          type='button'
                          className='ml-auto text-slate-400 hover:text-slate-600'
                          onClick={() => {
                            setFileToken(null)
                            setSheets([])
                          }}
                        >
                          <X className='h-3.5 w-3.5' />
                        </button>
                      </div>
                      {sheets.length > 1 && (
                        <div className='flex items-center gap-2'>
                          <span className='text-[12px] text-slate-500'>Sheet</span>
                          <Select value={sheet} onValueChange={setSheet}>
                            <SelectTrigger className='h-8 w-[280px] text-[12px]'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {sheets.map((s) => (
                                <SelectItem key={s.name} value={s.name} className='text-[12px]'>
                                  {s.name} · {s.row_count.toLocaleString()} rows · {s.columns.length} cols
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      {activeSheet && (
                        <div className='flex flex-wrap gap-1'>
                          {activeSheet.columns.slice(0, 24).map((c) => (
                            <span
                              key={c}
                              className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-500 dark:bg-muted dark:text-muted-foreground'
                            >
                              {c}
                            </span>
                          ))}
                          {activeSheet.columns.length > 24 && (
                            <span className='px-1 text-[10.5px] text-slate-400'>
                              +{activeSheet.columns.length - 24} more
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className='mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                  {mode === 'describe' ? 'What do you need?' : 'Guidance (optional)'}
                </label>
                <textarea
                  className='min-h-[110px] w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-[12.5px] leading-relaxed text-slate-800 outline-none focus:border-[#00ceff] dark:border-border dark:bg-background dark:text-foreground'
                  placeholder={
                    mode === 'describe'
                      ? 'e.g. Track vendor contracts: vendor, contract number, start/end dates, annual value, status (draft/active/expired), renewal owner, notes…'
                      : 'e.g. This is a PO line export — relate warehouse codes to the warehouses collection, statuses are a fixed set…'
                  }
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <Button
                size='sm'
                disabled={busy || (mode === 'describe' ? !prompt.trim() : !fileToken)}
                onClick={() =>
                  analyze.mutate(
                    mode === 'describe'
                      ? { prompt }
                      : { file_token: fileToken, sheet, prompt: prompt.trim() || undefined }
                  )
                }
              >
                {analyze.isPending ? (
                  <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Wand2 className='mr-1.5 h-3.5 w-3.5' />
                )}
                {analyze.isPending ? 'Analyzing…' : mode === 'describe' ? 'Generate proposal' : 'Analyze file'}
              </Button>
            </div>
          ) : (
            <div className='space-y-4'>
              {plan.notes && (
                <div className='rounded-lg border border-[#00ceff]/25 bg-[#00ceff]/5 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300'>
                  {plan.notes}
                </div>
              )}

              {plan.collections.map((c, ci) => {
                const referencedBy = plan.collections.flatMap((other) =>
                  other.collection === c.collection
                    ? []
                    : other.fields
                        .filter(
                          (f) => !f._exclude && f.relation?.related_collection === c.collection
                        )
                        .map((f) => ({ from: other.collection, f }))
                )
                return (
                <div key={ci} className='rounded-lg border border-slate-200 dark:border-border'>
                  {referencedBy.length > 0 && (
                    <div className='border-b border-violet-500/20 bg-violet-500/5 px-3 py-2 text-[11.5px] leading-relaxed text-violet-700 dark:text-violet-300'>
                      New lookup collection —{' '}
                      {referencedBy
                        .map(
                          (r) =>
                            `${r.from}.${r.f.field} ${r.f.type === 'm2m' ? 'links (many-to-many)' : 'links'} here${
                              r.f.source_column && r.f.relation?.match_field
                                ? `; auto-filled with the distinct "${r.f.source_column}" values on import`
                                : ''
                            }`
                        )
                        .join(' · ')}
                    </div>
                  )}
                  <div className='flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-border'>
                    <Input
                      className='h-8 w-[220px] font-mono text-[12.5px]'
                      value={c.collection}
                      onChange={(e) =>
                        updateCollection(ci, {
                          collection: e.target.value.replace(/[^A-Za-z0-9_]/g, '_')
                        })
                      }
                    />
                    <Input
                      className='h-8 w-[200px] text-[12.5px]'
                      value={c.display_name}
                      placeholder='Display name'
                      onChange={(e) => updateCollection(ci, { display_name: e.target.value })}
                    />
                    <span className='ml-auto text-[11px] text-slate-400'>
                      {c.fields.filter((f) => !f._exclude).length} fields
                      {c.display_template ? ` · ${c.display_template}` : ''}
                    </span>
                  </div>
                  {c.fields.some((f) => f.source_column && f.type !== 'm2m') && (
                    <div className='flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-border dark:bg-muted/30'>
                      <span
                        className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'
                        data-tip='Re-imports of the same file shape match existing rows on these fields — matched rows update, everything else inserts. No key = every import appends.'
                      >
                        Re-import key
                      </span>
                      {c.fields
                        .filter((f) => f.source_column && f.type !== 'm2m' && !f._exclude)
                        .map((f) => {
                          const on = (c.import_key ?? []).includes(f.field)
                          return (
                            <button
                              key={f.field}
                              type='button'
                              onClick={() =>
                                updateCollection(ci, {
                                  import_key: on
                                    ? (c.import_key ?? []).filter((k) => k !== f.field)
                                    : [...(c.import_key ?? []), f.field]
                                })
                              }
                              className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                                on
                                  ? 'border-[#00ceff]/50 bg-[#00ceff]/10 font-semibold text-[#009abe] dark:text-nvr-cyan'
                                  : 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-border'
                              }`}
                            >
                              {f.field}
                            </button>
                          )
                        })}
                      <span className='ml-auto text-[10.5px] text-slate-400'>
                        {(c.import_key ?? []).length
                          ? `upserts on ${(c.import_key ?? []).join(' + ')}`
                          : 'append-only'}
                      </span>
                    </div>
                  )}
                  <table className='w-full text-[12px]'>
                    <thead>
                      <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
                        <th className='w-8 px-3 py-1.5' />
                        <th className='py-1.5 pr-2'>Field</th>
                        <th className='py-1.5 pr-2'>Type</th>
                        <th className='py-1.5 pr-2'>Interface</th>
                        <th className='py-1.5 pr-2 text-center'>Req</th>
                        <th className='py-1.5 pr-2'>Relates to</th>
                        <th className='py-1.5 pr-3'>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.fields.map((f, fi) => (
                        <tr
                          key={fi}
                          className={`border-t border-slate-100 dark:border-border ${f._exclude ? 'opacity-40' : ''}`}
                        >
                          <td className='px-3 py-1'>
                            <input
                              type='checkbox'
                              checked={!f._exclude}
                              onChange={(e) => updateField(ci, fi, { _exclude: !e.target.checked })}
                            />
                          </td>
                          <td className='py-1 pr-2'>
                            <Input
                              className='h-7 font-mono text-[11.5px]'
                              value={f.field}
                              onChange={(e) =>
                                updateField(ci, fi, {
                                  field: e.target.value.replace(/[^A-Za-z0-9_]/g, '_')
                                })
                              }
                            />
                          </td>
                          <td className='py-1 pr-2'>
                            <Select
                              value={f.type}
                              onValueChange={(v) => updateField(ci, fi, { type: v })}
                            >
                              <SelectTrigger className='h-7 w-[104px] text-[11.5px]'>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {FIELD_TYPES.map((t) => (
                                  <SelectItem key={t} value={t} className='text-[12px]'>
                                    {t}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className='py-1 pr-2'>
                            {f.relation || f.type === 'm2m' ? (
                              <span
                                className='inline-flex max-w-[130px] items-center gap-1 truncate rounded bg-violet-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-violet-600 dark:text-violet-300'
                                data-tip={
                                  f.relation
                                    ? `Each row ${f.type === 'm2m' ? 'links to MANY' : 'links to one'} ${f.relation.related_collection} record${f.relation.match_field ? `, matched by ${f.relation.match_field}` : ''}`
                                    : 'Pick a related collection for this many-to-many field'
                                }
                              >
                                <Link2 className='h-3 w-3 shrink-0' />
                                {f.type === 'm2m' ? 'M2M' : 'M2O'}
                                {f.relation ? ` → ${f.relation.related_collection}` : ' — pick target'}
                              </span>
                            ) : (
                              <Select
                                value={f.interface ?? 'input'}
                                onValueChange={(v) => updateField(ci, fi, { interface: v })}
                              >
                                <SelectTrigger className='h-7 w-[130px] text-[11.5px]'>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {IFACES.map((t) => (
                                    <SelectItem key={t} value={t} className='text-[12px]'>
                                      {t}
                                      {t === 'select-dropdown' && f.options?.choices
                                        ? ` (${f.options.choices.length})`
                                        : ''}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </td>
                          <td className='py-1 pr-2 text-center'>
                            <input
                              type='checkbox'
                              checked={!!f.required}
                              onChange={(e) => updateField(ci, fi, { required: e.target.checked })}
                            />
                          </td>
                          <td className='py-1 pr-2'>
                            <RelationCell
                              collection={c}
                              field={f}
                              relationTargets={relationTargets}
                              planCollections={plan.collections}
                              onChange={(patch) => updateField(ci, fi, patch)}
                              onCreateNew={() => createLookupCollection(ci, fi)}
                            />
                          </td>
                          <td className='max-w-[130px] truncate py-1 pr-3 font-mono text-[10.5px] text-slate-400' data-tip={f.source_column ?? undefined}>
                            {f.source_column ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )
              })}

              <div className='flex items-center gap-2'>
                <Input
                  className='h-8 flex-1 text-[12.5px]'
                  placeholder='Refine with AI — e.g. "split supplier into its own collection", "make promised_date required"…'
                  value={refine}
                  onChange={(e) => setRefine(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && refine.trim() && !busy) {
                      analyze.mutate({ plan, instruction: refine })
                    }
                  }}
                />
                <Button
                  size='sm'
                  variant='outline'
                  disabled={!refine.trim() || busy}
                  onClick={() => analyze.mutate({ plan, instruction: refine })}
                >
                  {analyze.isPending ? (
                    <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Sparkles className='mr-1.5 h-3.5 w-3.5' />
                  )}
                  Refine
                </Button>
              </div>
            </div>
          )}
        </div>

        {plan && (
          <div className='flex shrink-0 items-center gap-3 border-t border-slate-200 px-5 py-3 dark:border-border'>
            {mode === 'file' && fileToken && (
              <div className='flex flex-col gap-1'>
                <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                  <input
                    type='checkbox'
                    checked={importRows}
                    onChange={(e) => setImportRows(e.target.checked)}
                  />
                  Import the {activeSheet?.row_count.toLocaleString() ?? ''} parsed rows after creating
                </label>
                <label
                  className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'
                  data-tip='Creates a staging table + an import_{name} stored procedure keyed on the re-import key, registered in the Import Console for repeat uploads of this file shape'
                >
                  <input
                    type='checkbox'
                    checked={createImport}
                    onChange={(e) => setCreateImport(e.target.checked)}
                  />
                  Create a repeatable import (staging table + import procedure)
                </label>
              </div>
            )}
            <Button size='sm' className='ml-auto' disabled={busy} onClick={() => apply.mutate()}>
              {apply.isPending && <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />}
              {apply.isPending
                ? 'Creating…'
                : `Create ${plan.collections.map((p) => p.collection).join(', ')}`}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}


/**
 * Relation editor for one field: target collection (with a "create new
 * lookup table" option), the match field on that target, and — for m2m —
 * the junction table name.
 */
function RelationCell({
  collection,
  field: f,
  relationTargets,
  planCollections,
  onChange,
  onCreateNew
}: {
  collection: DesignCollection
  field: DesignField
  relationTargets: string[]
  planCollections: DesignCollection[]
  onChange: (patch: Partial<DesignField>) => void
  onCreateNew: () => void
}) {
  const target = f.relation?.related_collection ?? null
  const planTarget = planCollections.find((c) => c.collection === target)
  const { data: existingFields } = useQuery<{ fields?: { field: string }[] }>({
    queryKey: ['collection-fields', target],
    queryFn: () => api.get(`/collections/${target}`).then((r) => r.data.data),
    enabled: !!target && !planTarget,
    staleTime: 300_000
  })
  const matchOptions = planTarget
    ? planTarget.fields.filter((tf) => tf.type !== 'm2m').map((tf) => tf.field)
    : (existingFields?.fields ?? []).map((tf) => tf.field).filter((n) => n !== 'id')

  return (
    <div className='flex w-[190px] flex-col gap-1'>
      <Select
        value={target ?? '__none__'}
        onValueChange={(v) => {
          if (v === '__new__') return onCreateNew()
          onChange({
            relation:
              v === '__none__'
                ? null
                : {
                    related_collection: v,
                    match_field: v === target ? f.relation?.match_field : undefined,
                    junction: v === target ? f.relation?.junction : undefined
                  }
          })
        }}
      >
        <SelectTrigger className='h-7 text-[11.5px]'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className='max-h-[280px]'>
          <SelectItem value='__none__' className='text-[12px] text-slate-400'>
            — none —
          </SelectItem>
          <SelectItem value='__new__' className='text-[12px] font-medium text-[#009abe]'>
            ＋ New collection…
          </SelectItem>
          {relationTargets.map((t) => (
            <SelectItem key={t} value={t} className='text-[12px]'>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {f.relation && (
        <div className='flex items-center gap-1'>
          <span className='shrink-0 text-[10px] text-slate-400'>via</span>
          <Select
            value={f.relation.match_field ?? '__id__'}
            onValueChange={(v) =>
              onChange({
                relation: { ...f.relation!, match_field: v === '__id__' ? null : v }
              })
            }
          >
            <SelectTrigger className='h-6 flex-1 text-[10.5px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className='max-h-[240px]'>
              <SelectItem value='__id__' className='text-[11.5px] text-slate-400'>
                id (numeric)
              </SelectItem>
              {matchOptions.map((m) => (
                <SelectItem key={m} value={m} className='text-[11.5px]'>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {f.relation && f.type === 'm2m' && (
        <Input
          className='h-6 font-mono text-[10.5px]'
          placeholder={`${collection.collection}_${f.relation.related_collection}`}
          value={f.relation.junction ?? ''}
          data-tip='Junction table name — leave blank for the default'
          onChange={(e) =>
            onChange({
              relation: {
                ...f.relation!,
                junction: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') || null
              }
            })
          }
        />
      )}
    </div>
  )
}

function errMsg(err: unknown, fallback: string) {
  return (
    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
  )
}
