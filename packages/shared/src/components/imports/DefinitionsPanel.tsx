import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, patch, post } from '../../lib/commands'
import { cn, formatNumber } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { StagingColumnsBuilder, ValidationBuilder } from './SchemaValidationBuilders'
import { ServiceConfigBuilder } from './ServiceConfigBuilder'
import { definitionTitle, type ImportDefinition } from './types'

const NEW = '__new__'

type Draft = {
  key: string
  label: string
  description: string
  staging_table: string
  procedure: string
  loader: '' | 'bulk' | 'insert'
  sort: string
  is_active: boolean
  staging_columns: string
  validation: string
  procedure_body: string
  processor: '' | 'service'
  service_config: string
  post_run_flows: string[]
}

const parseIdList = (raw: string | null | undefined): string[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((v) => String(v).toUpperCase()) : []
  } catch {
    return []
  }
}

const prettyJson = (raw: string | null | undefined): string => {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function toDraft(d: ImportDefinition | null): Draft {
  return {
    key: d?.key ?? '',
    label: d?.label ?? '',
    description: d?.description ?? '',
    staging_table: d?.staging_table ?? '',
    procedure: d?.procedure ?? '',
    loader: d?.loader ?? '',
    sort: String(d?.sort ?? 0),
    is_active: d?.is_active ?? true,
    staging_columns: prettyJson(d?.staging_columns),
    validation: prettyJson(d?.validation),
    procedure_body: d?.procedure_body ?? '',
    processor: d?.processor === 'service' ? 'service' : '',
    service_config: prettyJson(d?.service_config),
    post_run_flows: parseIdList(d?.post_run_flows)
  }
}

type FlowRow = { id: string; name: string; status: string; trigger: string }

/** Ordered multi-select over the instance's flows — checked flows run in the
 *  order listed (move up/down), unchecked ones are ignored. Admin-only data:
 *  GET /flows is admin-gated, and so is this panel. */
function PostRunFlowsPicker({
  value,
  onChange
}: {
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const client = useNivaroClient()
  const flows = useQuery({
    queryKey: ['flows', 'post-run-picker'],
    queryFn: () => client.request<{ data: FlowRow[] }>(get('/flows')),
    staleTime: 60_000
  })
  const rows = flows.data?.data ?? []
  const byId = new Map(rows.map((f) => [String(f.id).toUpperCase(), f]))
  const selected = value.map(
    (id) =>
      byId.get(id) ?? {
        id,
        name: `Unknown flow ${id.slice(0, 8)}…`,
        status: 'missing',
        trigger: ''
      }
  )
  const available = rows.filter((f) => !value.includes(String(f.id).toUpperCase()))
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...value]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    onChange(next)
  }
  return (
    <div className='space-y-2'>
      {selected.length === 0 && (
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>No post-run flows.</p>
      )}
      {selected.map((f, idx) => (
        <div
          key={String(f.id)}
          className='flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] dark:border-border dark:bg-card'
        >
          <span className='w-5 shrink-0 text-center font-mono text-[11px] text-slate-400'>
            {idx + 1}
          </span>
          <span className='min-w-0 flex-1 truncate'>
            {f.name}
            {f.status !== 'active' && (
              <span className='ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'>
                {f.status === 'missing' ? 'missing' : 'inactive — skipped'}
              </span>
            )}
          </span>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-1.5'
            onClick={() => move(idx, -1)}
            disabled={idx === 0}
          >
            ↑
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-1.5'
            onClick={() => move(idx, 1)}
            disabled={idx === selected.length - 1}
          >
            ↓
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-1.5 text-red-600'
            onClick={() => onChange(value.filter((id) => id !== String(f.id).toUpperCase()))}
          >
            ✕
          </Button>
        </div>
      ))}
      <SimpleSelect
        value=''
        onChange={(v) => {
          if (v) onChange([...value, String(v).toUpperCase()])
        }}
        options={[
          { value: '', label: flows.isLoading ? 'Loading flows…' : '＋ Add a flow…' },
          ...available.map((f) => ({
            value: f.id,
            label: `${f.name}${f.status !== 'active' ? ' (inactive)' : ''} · ${f.trigger}`
          }))
        ]}
        className='h-8 text-[12.5px]'
      />
    </div>
  )
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Declared staging column names off the (possibly mid-edit) JSON draft —
 *  the builder seeds one mapping row per declared column. */
function declaredColumnNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((c) => (c && typeof c === 'object' ? String((c as { name?: unknown }).name ?? '') : ''))
      .filter((n) => n && n !== 'id')
  } catch {
    return []
  }
}

/**
 * Definition registry (admin). Master-detail rather than a dialog: an operator
 * comparing two imports' targets needs both the list and the editor on screen.
 */
export function DefinitionsPanel({
  definitions,
  runCounts,
  isLoading
}: {
  definitions: ImportDefinition[]
  /** Runs per import key — a definition's history is the main thing that makes
   *  it recognisable, and the reason deactivating beats deleting. */
  runCounts: Record<string, number>
  isLoading?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | typeof NEW | null>(null)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<Draft>(toDraft(null))
  const [error, setError] = useState<string | null>(null)

  const selected =
    selectedId === NEW || selectedId == null
      ? null
      : (definitions.find((d) => d.id === selectedId) ?? null)

  // Re-seed the editor when the selection changes, not on every definitions
  // refetch — a background poll must never clobber what's being typed.
  useEffect(() => {
    if (selectedId == null) return
    setError(null)
    setDraft(
      toDraft(selectedId === NEW ? null : (definitions.find((d) => d.id === selectedId) ?? null))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return definitions
    return definitions.filter((d) =>
      [d.key, d.label, d.staging_table, d.procedure]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [definitions, search])

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        label: draft.label.trim() || null,
        description: draft.description.trim() || null,
        staging_table: draft.staging_table.trim() || null,
        procedure: draft.procedure.trim() || null,
        loader: draft.loader || null,
        sort: Number(draft.sort) || 0,
        is_active: draft.is_active,
        staging_columns: draft.staging_columns.trim() || null,
        validation: draft.validation.trim() || null,
        procedure_body: draft.procedure_body.trim() || null,
        processor: draft.processor || null,
        service_config: draft.service_config.trim() || null,
        post_run_flows: draft.post_run_flows
      }
      if (selectedId === NEW) {
        return client.request(
          post<{ data: ImportDefinition }>('/staged-imports/definitions', {
            ...body,
            key: draft.key.trim()
          })
        )
      }
      return client.request(
        patch<{ data: ImportDefinition }>(`/staged-imports/definitions/${selectedId}`, body)
      )
    },
    onSuccess: (res) => {
      setError(null)
      void qc.invalidateQueries({ queryKey: ['staged-import-definitions'] })
      const saved = (res as { data?: ImportDefinition })?.data
      if (saved?.id) setSelectedId(saved.id)
    },
    onError: (err: Error) => setError(err.message)
  })

  const keyProblem =
    selectedId === NEW && draft.key.trim() && !IDENT.test(draft.key.trim())
      ? 'Letters, digits and underscores only, starting with a letter.'
      : null
  const tableProblem =
    draft.staging_table.trim() && !IDENT.test(draft.staging_table.trim())
      ? 'Must be a plain table name — it is interpolated into SQL, so it is rejected at run time otherwise.'
      : null
  const procProblem =
    draft.procedure.trim() && !IDENT.test(draft.procedure.trim())
      ? 'Must be a plain procedure name.'
      : null
  const jsonProblem = (raw: string): string | null => {
    if (!raw.trim()) return null
    try {
      JSON.parse(raw)
      return null
    } catch {
      return 'Not valid JSON.'
    }
  }
  const stagingColsProblem = jsonProblem(draft.staging_columns)
  const validationProblem = jsonProblem(draft.validation)
  const serviceConfigProblem =
    jsonProblem(draft.service_config) ??
    (draft.processor === 'service' && !draft.service_config.trim()
      ? 'Service mode needs a config: {"collection", "match_by", "columns"}.'
      : null)
  const canSave =
    (selectedId === NEW ? IDENT.test(draft.key.trim()) : selectedId != null) &&
    !tableProblem &&
    !procProblem &&
    !stagingColsProblem &&
    !validationProblem &&
    !serviceConfigProblem

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      {/* ── List ─────────────────────────────────────────────────────────── */}
      <aside className='flex w-[288px] shrink-0 flex-col border-r border-slate-200 dark:border-border'>
        <div className='flex items-center gap-2 border-b border-slate-200 p-2.5 dark:border-border'>
          <div className='relative flex-1'>
            <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search…'
              className='h-7 pl-8 text-[12px]'
            />
          </div>
          <Button size='sm' className='h-7 px-2' onClick={() => setSelectedId(NEW)}>
            <Plus className='h-3.5 w-3.5' />
            New
          </Button>
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto'>
          {selectedId === NEW && (
            <div className='border-b border-slate-100 bg-nvr-cyan/10 px-3 py-2 text-[12.5px] font-medium text-slate-900 dark:border-border/60 dark:bg-nvr-cyan/15 dark:text-foreground'>
              New import definition
            </div>
          )}
          {isLoading && definitions.length === 0 && (
            <p className='px-3 py-6 text-center text-[12px] text-slate-400'>Loading…</p>
          )}
          {!isLoading && filtered.length === 0 && (
            <p className='px-3 py-6 text-center text-[12px] text-slate-400'>
              {search ? `No import matches “${search}”.` : 'No imports are defined yet.'}
            </p>
          )}
          {filtered.map((d) => {
            const active = d.id === selectedId
            return (
              <button
                key={d.id}
                type='button'
                onClick={() => setSelectedId(d.id)}
                className={cn(
                  'flex w-full flex-col gap-0.5 border-b border-slate-100 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-muted/40',
                  active && 'bg-nvr-cyan/10 hover:bg-nvr-cyan/15 dark:bg-nvr-cyan/15'
                )}
              >
                <span className='flex items-center gap-1.5'>
                  <span
                    className={cn(
                      'truncate text-[12.5px] font-medium',
                      d.is_active
                        ? 'text-slate-900 dark:text-foreground'
                        : 'text-slate-400 line-through dark:text-muted-foreground'
                    )}
                  >
                    {definitionTitle(d)}
                  </span>
                  {runCounts[d.key] != null && (
                    <span className='ml-auto shrink-0 text-[10.5px] tabular-nums text-slate-400'>
                      {formatNumber(runCounts[d.key])}
                    </span>
                  )}
                </span>
                <span className='truncate font-mono text-[10.5px] text-slate-400'>{d.key}</span>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── Editor ───────────────────────────────────────────────────────── */}
      <div className='min-w-0 flex-1 overflow-y-auto bg-slate-50 p-5 dark:bg-background'>
        {selectedId == null ? (
          <div className='max-w-[52ch] pt-6'>
            <h3 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
              Import definitions
            </h3>
            <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
              Each definition says where a file's rows land and what runs over them afterwards — a
              staging table, and optionally a stored procedure. A definition with no procedure is a
              valid import; the load alone is the job.
            </p>
            <p className='mt-2.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
              Pick one on the left to edit it, or add a new one. Definitions are never deleted here
              — deactivating keeps their run history readable and stops new uploads.
            </p>
          </div>
        ) : (
          <div className='max-w-[720px] space-y-4'>
            <div className='flex items-start justify-between gap-4'>
              <div className='min-w-0'>
                <h3 className='truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                  {selectedId === NEW ? 'New import definition' : definitionTitle(selected!)}
                </h3>
                {selected && (
                  <p className='mt-0.5 font-mono text-[11px] text-slate-400'>
                    {selected.staging_table || `staging_${selected.key}`}
                    {selected.procedure && (
                      <>
                        {' '}
                        <ArrowRight className='inline h-3 w-3 -translate-y-px' />{' '}
                        {selected.procedure}
                      </>
                    )}
                  </p>
                )}
              </div>
              <label className='flex shrink-0 items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
                <Switch
                  checked={draft.is_active}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
                />
                {draft.is_active ? 'Active' : 'Inactive'}
              </label>
            </div>

            <div className='grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card sm:grid-cols-2'>
              <Field label='Key' hint='Stable slug used by the API and by every run row.'>
                <Input
                  value={draft.key}
                  disabled={selectedId !== NEW}
                  onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                  placeholder='purchase_orders'
                  className='h-8 font-mono text-[12px]'
                />
                {keyProblem && <Problem>{keyProblem}</Problem>}
              </Field>

              <Field label='Label' hint='What operators see. Falls back to the key.'>
                <Input
                  value={draft.label}
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  placeholder='Purchase Orders'
                  className='h-8 text-[12.5px]'
                />
              </Field>

              <Field
                label='Staging table'
                hint={`Where cleaned rows land. Blank means staging_${draft.key || '<key>'}.`}
              >
                <Input
                  value={draft.staging_table}
                  onChange={(e) => setDraft((d) => ({ ...d, staging_table: e.target.value }))}
                  placeholder={draft.key ? `staging_${draft.key}` : 'staging_…'}
                  className='h-8 font-mono text-[12px]'
                />
                {tableProblem && <Problem>{tableProblem}</Problem>}
              </Field>

              <Field label='Procedure' hint='Runs after the load. Blank = load only.'>
                <Input
                  value={draft.procedure}
                  onChange={(e) => setDraft((d) => ({ ...d, procedure: e.target.value }))}
                  placeholder='import_…'
                  className='h-8 font-mono text-[12px]'
                />
                {procProblem && <Problem>{procProblem}</Problem>}
              </Field>

              <Field
                label='Loader'
                hint='Bulk pushes a file to the share and BULK INSERTs it; insert batches rows directly. Ignored in service mode.'
              >
                <SimpleSelect
                  value={draft.loader}
                  onChange={(v) => setDraft((d) => ({ ...d, loader: v as Draft['loader'] }))}
                  options={[
                    { value: '', label: 'Deployment default' },
                    { value: 'bulk', label: 'Bulk (file share)' },
                    { value: 'insert', label: 'Insert (batched)' }
                  ]}
                  className='h-8 text-[12.5px]'
                />
              </Field>

              <Field
                label='Processor'
                hint='Stored procedure MERGEs staging rows (no revisions). Items service diffs and writes only real changes — revisions, activity, rules and computed fields apply.'
              >
                <SimpleSelect
                  value={draft.processor}
                  onChange={(v) => setDraft((d) => ({ ...d, processor: v as Draft['processor'] }))}
                  options={[
                    { value: '', label: 'Stored procedure' },
                    { value: 'service', label: 'Items service (revisioned)' }
                  ]}
                  className='h-8 text-[12.5px]'
                />
              </Field>

              {draft.processor === 'service' && (
                <div className='sm:col-span-2'>
                  <Field label='Service mapping'>
                    <ServiceConfigBuilder
                      value={draft.service_config}
                      onChange={(json) => setDraft((d) => ({ ...d, service_config: json }))}
                      stagingColumns={declaredColumnNames(draft.staging_columns)}
                    />
                    {serviceConfigProblem && <Problem>{serviceConfigProblem}</Problem>}
                  </Field>
                </div>
              )}

              <div className='sm:col-span-2'>
                <Field
                  label='After each run'
                  hint='Flows executed in this order right after a run of this import completes, with the run summary (import_key, run_id, row_count …) as the payload. Use it for work the raw-SQL import cannot trigger itself — e.g. re-evaluating automatic workflow transitions once purchase orders have landed. Flows on the generic "Staged Import Completed" trigger also fire, but never twice.'
                >
                  <PostRunFlowsPicker
                    value={draft.post_run_flows}
                    onChange={(ids) => setDraft((d) => ({ ...d, post_run_flows: ids }))}
                  />
                </Field>
              </div>

              <Field label='Sort' hint='Order in the import picker.'>
                <Input
                  value={draft.sort}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, sort: e.target.value.replace(/[^\d-]/g, '') }))
                  }
                  inputMode='numeric'
                  className='h-8 w-24 text-right font-mono text-[12px]'
                />
              </Field>

              <div className='sm:col-span-2'>
                <Field label='Description' hint='Shown to whoever is choosing an import to run.'>
                  <Textarea
                    value={draft.description}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    rows={2}
                    className='text-[12.5px]'
                  />
                </Field>
              </div>
            </div>

            {selectedId !== NEW && selected && (
              <AdvancedConfigSection
                definition={selected}
                draft={draft}
                setDraft={setDraft}
                stagingColsProblem={stagingColsProblem}
                validationProblem={validationProblem}
              />
            )}

            <div className='flex items-center gap-3'>
              <Button size='sm' disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? (
                  <>
                    <Loader2 className='h-3.5 w-3.5 animate-spin' /> Saving…
                  </>
                ) : selectedId === NEW ? (
                  'Create definition'
                ) : (
                  'Save changes'
                )}
              </Button>
              <Button variant='ghost' size='sm' onClick={() => setSelectedId(null)}>
                Close
              </Button>
              {save.isSuccess && !save.isPending && (
                <span className='text-[12px] text-emerald-600 dark:text-emerald-400'>Saved.</span>
              )}
              {error && <span className='text-[12px] text-red-600 dark:text-red-400'>{error}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Pre-flight validation, declared staging schema, and the app-managed
 * procedure body — the config that makes an import self-describing: the
 * schema the table converges on, the checks the preview runs, and the SQL
 * that consumes it, versioned together.
 */
function AdvancedConfigSection({
  definition,
  draft,
  setDraft,
  stagingColsProblem,
  validationProblem
}: {
  definition: ImportDefinition
  draft: Draft
  setDraft: React.Dispatch<React.SetStateAction<Draft>>
  stagingColsProblem: string | null
  validationProblem: string | null
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(
    !!(definition.procedure_body || definition.validation || definition.staging_columns)
  )
  const [msg, setMsg] = useState<string | null>(null)

  const suggest = useMutation({
    mutationFn: () =>
      client.request<{ data: { suggestion: unknown; note: string } }>(
        post(`/staged-imports/definitions/${definition.id}/suggest-validation`, {})
      ),
    onSuccess: (res) => {
      const suggestion = (res as { data?: { suggestion?: unknown } })?.data?.suggestion
      if (suggestion) {
        setDraft((d) => ({ ...d, validation: JSON.stringify(suggestion, null, 2) }))
        setMsg('Suggestion loaded from the live procedure — review, adjust, then Save.')
      }
    },
    onError: (err: Error) => setMsg(err.message)
  })

  const loadLive = useMutation({
    mutationFn: () =>
      client.request<{ data: { live_body: string | null } }>(
        get(`/staged-imports/definitions/${definition.id}/procedure`)
      ),
    onSuccess: (res) => {
      const live = (res as { data?: { live_body?: string | null } })?.data?.live_body
      if (live) {
        setDraft((d) => ({ ...d, procedure_body: live }))
        setMsg('Live procedure body loaded — Save to take ownership, Deploy to push edits back.')
      } else setMsg('The procedure does not exist in the database yet.')
    },
    onError: (err: Error) => setMsg(err.message)
  })

  const deploy = useMutation({
    mutationFn: () =>
      client.request(post(`/staged-imports/definitions/${definition.id}/deploy`, {})),
    onSuccess: () => {
      setMsg('Deployed.')
      void qc.invalidateQueries({ queryKey: ['staged-import-definitions'] })
    },
    onError: (err: Error) => setMsg(err.message)
  })

  const { data: versions = [] } = useQuery<
    Array<{ id: number; version: number; note: string | null; created_at: string }>
  >({
    queryKey: ['staged-import-def-versions', definition.id],
    queryFn: () =>
      client
        .request<{
          data: Array<{ id: number; version: number; note: string | null; created_at: string }>
        }>(get(`/staged-imports/definitions/${definition.id}/versions`))
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 15_000
  })
  const restore = useMutation({
    mutationFn: (versionId: number) =>
      client.request(
        post(`/staged-imports/definitions/${definition.id}/versions/${versionId}/restore`, {})
      ),
    onSuccess: () => {
      setMsg('Restored — reload the definition to see it.')
      void qc.invalidateQueries({ queryKey: ['staged-import-definitions'] })
      void qc.invalidateQueries({ queryKey: ['staged-import-def-versions', definition.id] })
    },
    onError: (err: Error) => setMsg(err.message)
  })

  const bodyEdited =
    !!draft.procedure_body.trim() &&
    (!definition.procedure_hash || draft.procedure_body !== (definition.procedure_body ?? ''))

  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-2.5 text-left'
      >
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
          Validation, schema &amp; procedure
        </span>
        <span className='text-[11px] text-slate-400'>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className='space-y-4 border-t border-slate-100 p-4 dark:border-border'>
          <Field
            label='Declared staging columns'
            hint='When set, the staging table converges on this schema and only these columns load — a sheet column can never invent a staging column.'
          >
            <StagingColumnsBuilder
              value={draft.staging_columns}
              onChange={(json) => setDraft((d) => ({ ...d, staging_columns: json }))}
            />
            {stagingColsProblem && <Problem>{stagingColsProblem}</Problem>}
          </Field>

          <Field
            label='Pre-flight checks'
            hint='Run in the upload preview; hard errors block queueing before anything loads.'
          >
            <div className='mb-1.5'>
              <Button
                variant='outline'
                size='sm'
                className='h-7 text-[11.5px]'
                disabled={suggest.isPending || !definition.procedure}
                onClick={() => suggest.mutate()}
              >
                {suggest.isPending ? 'Reading procedure…' : 'Suggest from procedure'}
              </Button>
            </div>
            <ValidationBuilder
              value={draft.validation}
              onChange={(json) => setDraft((d) => ({ ...d, validation: json }))}
              stagingColumns={declaredColumnNames(draft.staging_columns)}
            />
            {validationProblem && <Problem>{validationProblem}</Problem>}
          </Field>

          <Field
            label='Procedure body (app-managed)'
            hint='When set, this app owns the procedure: Deploy runs CREATE OR ALTER, the schema sync skips it, and every save versions it. Empty = the procedure is managed outside.'
          >
            <div className='mb-1.5 flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                className='h-7 text-[11.5px]'
                disabled={loadLive.isPending || !definition.procedure}
                onClick={() => loadLive.mutate()}
              >
                {loadLive.isPending ? 'Loading…' : 'Load live body'}
              </Button>
              <Button
                size='sm'
                className='h-7 text-[11.5px]'
                disabled={deploy.isPending || !definition.procedure_body}
                onClick={() => deploy.mutate()}
              >
                {deploy.isPending ? 'Deploying…' : 'Deploy procedure'}
              </Button>
              {bodyEdited && (
                <span className='text-[11px] text-amber-600 dark:text-amber-400'>
                  Save first — Deploy pushes the SAVED body.
                </span>
              )}
            </div>
            <Textarea
              value={draft.procedure_body}
              onChange={(e) => setDraft((d) => ({ ...d, procedure_body: e.target.value }))}
              rows={12}
              className='font-mono text-[11px] leading-snug'
              placeholder='CREATE OR ALTER PROCEDURE import_… AS BEGIN … END'
            />
          </Field>

          {versions.length > 0 && (
            <Field
              label='Versions'
              hint='Every save snapshots the whole definition. Restore is itself versioned.'
            >
              <div className='max-h-40 space-y-1 overflow-y-auto'>
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className='flex items-center justify-between rounded border border-slate-100 px-2.5 py-1.5 text-[11.5px] dark:border-border'
                  >
                    <span className='min-w-0 truncate text-slate-600 dark:text-muted-foreground'>
                      v{v.version} · {v.note ?? '—'} · {new Date(v.created_at).toLocaleString()}
                    </span>
                    <button
                      type='button'
                      className='shrink-0 text-[11px] text-nvr-cyan hover:underline'
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(v.id)}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </Field>
          )}

          {msg && <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>{msg}</p>}
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-1'>
      <Label className='text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
        {label}
      </Label>
      {children}
      {hint && <p className='text-[11px] leading-snug text-slate-400'>{hint}</p>}
    </div>
  )
}

function Problem({ children }: { children: React.ReactNode }) {
  return <p className='text-[11px] leading-snug text-red-600 dark:text-red-400'>{children}</p>
}
