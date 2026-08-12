import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { patch, post } from '../../lib/commands'
import { cn, formatNumber } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { type ImportDefinition, definitionTitle } from './types'

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
    is_active: d?.is_active ?? true
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

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
      toDraft(
        selectedId === NEW ? null : (definitions.find((d) => d.id === selectedId) ?? null)
      )
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
        is_active: draft.is_active
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
  const canSave =
    (selectedId === NEW ? IDENT.test(draft.key.trim()) : selectedId != null) &&
    !tableProblem &&
    !procProblem

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
                hint='Bulk pushes a file to the share and BULK INSERTs it; insert batches rows directly.'
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

              <Field label='Sort' hint='Order in the import picker.'>
                <Input
                  value={draft.sort}
                  onChange={(e) => setDraft((d) => ({ ...d, sort: e.target.value.replace(/[^\d-]/g, '') }))}
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
