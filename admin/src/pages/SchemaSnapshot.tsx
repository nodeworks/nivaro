import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeftRight, Download, GitCompare, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type ImportResult = {
  imported?: Record<string, number>
  [key: string]: unknown
}

type FieldChange = {
  collection: string
  field: string
  change: 'added' | 'removed' | 'modified'
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

type SchemaDiff = {
  added_collections: string[]
  removed_collections: string[]
  changed_fields: FieldChange[]
  added_relations: Record<string, unknown>[]
  removed_relations: Record<string, unknown>[]
  conflicts: FieldChange[]
}

type ApplyResult = {
  mode: string
  applied?: Record<string, number>
  skipped_destructive?: Array<{ kind: string; target: string; reason: string }>
  errors?: Array<{ target: string; error: string }>
}

const CHANGE_CLS: Record<FieldChange['change'], string> = {
  added:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300',
  removed:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
  modified:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'
}

function DiffRow({
  label,
  change,
  detail
}: {
  label: string
  change: FieldChange['change']
  detail?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px]',
        CHANGE_CLS[change]
      )}
    >
      <span className='w-16 shrink-0 text-[10px] font-semibold uppercase'>{change}</span>
      <span className='font-mono text-[11.5px]'>{label}</span>
      {detail && <span className='ml-auto truncate text-[10.5px] opacity-70'>{detail}</span>}
    </div>
  )
}

function nonDestructiveCount(diff: SchemaDiff): number {
  const conflictKeys = new Set(diff.conflicts.map((c) => `${c.collection}::${c.field}`))
  const fieldChanges = diff.changed_fields.filter(
    (c) => c.change !== 'removed' && !conflictKeys.has(`${c.collection}::${c.field}`)
  ).length
  return diff.added_collections.length + fieldChanges + diff.added_relations.length
}

// ─── Environment Sync card ────────────────────────────────────────────────────

function EnvironmentSyncCard() {
  const dropRef = useRef<HTMLInputElement>(null)
  const [snapshotText, setSnapshotText] = useState('')
  const [diff, setDiff] = useState<SchemaDiff | null>(null)
  const [confirmApply, setConfirmApply] = useState(false)
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)
  const [dragOver, setDragOver] = useState(false)

  function parseSnapshot(): unknown | null {
    try {
      return JSON.parse(snapshotText) as unknown
    } catch {
      toast.error('Snapshot is not valid JSON')
      return null
    }
  }

  const exportSchema = useMutation({
    mutationFn: async () => {
      const response = await api.get('/schema-snapshot/export', { responseType: 'blob' })
      const url = URL.createObjectURL(
        new Blob([response.data as BlobPart], { type: 'application/json' })
      )
      const a = document.createElement('a')
      a.href = url
      a.download = `nivaro-schema-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    },
    onSuccess: () => toast.success('Schema exported'),
    onError: () => toast.error('Export failed')
  })

  const previewDiff = useMutation({
    mutationFn: async (snapshot: unknown) =>
      api.post<{ data: SchemaDiff }>('/schema-snapshot/diff', snapshot).then((r) => r.data.data),
    onSuccess: (d) => {
      setDiff(d)
      setApplyResult(null)
      setConfirmApply(false)
    },
    onError: () => toast.error('Failed to compute diff')
  })

  const applySync = useMutation({
    mutationFn: async (snapshot: unknown) =>
      api
        .post<{ data: ApplyResult }>('/schema-snapshot/import', { snapshot, mode: 'apply' })
        .then((r) => r.data.data),
    onSuccess: (result, snapshot) => {
      setApplyResult(result)
      setConfirmApply(false)
      toast.success('Non-destructive changes applied')
      // Refresh the diff against the now-updated schema
      previewDiff.mutate(snapshot)
    },
    onError: () => toast.error('Apply failed')
  })

  async function loadFile(file: File) {
    const text = await file.text()
    setSnapshotText(text)
    setDiff(null)
    setApplyResult(null)
  }

  const safeCount = diff ? nonDestructiveCount(diff) : 0
  const destructiveCount = diff
    ? diff.removed_collections.length +
      diff.changed_fields.filter((c) => c.change === 'removed').length +
      diff.conflicts.length +
      diff.removed_relations.length
    : 0

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            <ArrowLeftRight className='h-3.5 w-3.5 text-slate-400' />
            Environment Sync
          </h2>
          <p className='mt-0.5 text-[11px] text-slate-400'>
            Move collections, fields, and relations between environments. Destructive changes are
            listed but never auto-applied.
          </p>
        </div>
        <Button
          variant='outline'
          size='sm'
          className='gap-2'
          onClick={() => exportSchema.mutate()}
          disabled={exportSchema.isPending}
        >
          <Download className='h-3.5 w-3.5' />
          {exportSchema.isPending ? 'Exporting…' : 'Export'}
        </Button>
      </div>

      {/* Snapshot input */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: decorative drop target; the file picker button is the accessible path */}
      <div
        className={cn(
          'mt-4 rounded-lg border border-dashed p-3 transition-colors',
          dragOver ? 'border-nvr-cyan bg-nvr-cyan/5' : 'border-slate-200 dark:border-border'
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files?.[0]
          if (file) void loadFile(file)
        }}
      >
        <div className='mb-2 flex items-center justify-between'>
          <span className='text-[11px] font-medium text-slate-500'>
            Paste an exported schema JSON, or drop / choose a file
          </span>
          <input
            ref={dropRef}
            type='file'
            accept='.json'
            className='hidden'
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void loadFile(file)
            }}
          />
          <Button
            variant='outline'
            size='sm'
            className='h-6 text-[11px]'
            onClick={() => dropRef.current?.click()}
          >
            Choose file
          </Button>
        </div>
        <Textarea
          value={snapshotText}
          onChange={(e) => {
            setSnapshotText(e.target.value)
            setDiff(null)
            setApplyResult(null)
          }}
          rows={5}
          spellCheck={false}
          placeholder='{"collections": [...], "fields": [...], "relations": [...]}'
          className='resize-y font-mono text-[11px]'
        />
      </div>

      <div className='mt-3 flex items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          className='gap-1.5'
          disabled={!snapshotText.trim() || previewDiff.isPending}
          onClick={() => {
            const snap = parseSnapshot()
            if (snap) previewDiff.mutate(snap)
          }}
        >
          <GitCompare className='h-3.5 w-3.5' />
          {previewDiff.isPending ? 'Comparing…' : 'Preview diff'}
        </Button>
        {diff && safeCount > 0 && !confirmApply && (
          <Button size='sm' className='ml-auto' onClick={() => setConfirmApply(true)}>
            Apply non-destructive changes
          </Button>
        )}
        {diff && confirmApply && (
          <div className='ml-auto flex items-center gap-2'>
            <span className='text-[11px] text-slate-500'>
              Apply {safeCount} change{safeCount !== 1 ? 's' : ''}?
              {destructiveCount > 0 && ` (${destructiveCount} destructive skipped)`}
            </span>
            <Button
              size='sm'
              disabled={applySync.isPending}
              onClick={() => {
                const snap = parseSnapshot()
                if (snap) applySync.mutate(snap)
              }}
            >
              {applySync.isPending ? 'Applying…' : 'Confirm'}
            </Button>
            <Button size='sm' variant='outline' onClick={() => setConfirmApply(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* Diff result */}
      {diff && (
        <div className='mt-4 space-y-3'>
          {safeCount === 0 && destructiveCount === 0 ? (
            <p className='rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'>
              Schemas are in sync — no differences found.
            </p>
          ) : (
            <>
              {diff.conflicts.length > 0 && (
                <div className='flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30'>
                  <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600' />
                  <p className='text-[11px] text-amber-700 dark:text-amber-400'>
                    {diff.conflicts.length} type conflict{diff.conflicts.length !== 1 ? 's' : ''} —
                    these require a manual migration and will be skipped.
                  </p>
                </div>
              )}
              {diff.added_collections.length > 0 && (
                <div className='space-y-1'>
                  <p className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>
                    Collections
                  </p>
                  {diff.added_collections.map((c) => (
                    <DiffRow key={c} label={c} change='added' />
                  ))}
                </div>
              )}
              {diff.removed_collections.length > 0 && (
                <div className='space-y-1'>
                  {diff.removed_collections.map((c) => (
                    <DiffRow key={c} label={c} change='removed' detail='never auto-dropped' />
                  ))}
                </div>
              )}
              {diff.changed_fields.length > 0 && (
                <div className='space-y-1'>
                  <p className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>
                    Fields
                  </p>
                  {diff.changed_fields.map((c) => (
                    <DiffRow
                      key={`${c.collection}.${c.field}.${c.change}`}
                      label={`${c.collection}.${c.field}`}
                      change={c.change}
                      detail={
                        c.change === 'modified'
                          ? `${String(c.before?.type ?? '?')} → ${String(c.after?.type ?? '?')}`
                          : c.change === 'removed'
                            ? 'never auto-dropped'
                            : String(c.after?.type ?? '')
                      }
                    />
                  ))}
                </div>
              )}
              {(diff.added_relations.length > 0 || diff.removed_relations.length > 0) && (
                <div className='space-y-1'>
                  <p className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>
                    Relations
                  </p>
                  {diff.added_relations.map((r) => (
                    <DiffRow
                      key={`rel-add-${r.many_collection}.${r.many_field}`}
                      label={`${r.many_collection}.${r.many_field} → ${String(r.one_collection ?? r.one_collection_field ?? '')}`}
                      change='added'
                    />
                  ))}
                  {diff.removed_relations.map((r) => (
                    <DiffRow
                      key={`rel-rem-${r.many_collection}.${r.many_field}`}
                      label={`${r.many_collection}.${r.many_field} → ${String(r.one_collection ?? r.one_collection_field ?? '')}`}
                      change='removed'
                      detail='never auto-removed'
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Apply result */}
      {applyResult && (
        <div className='mt-4 rounded-lg border border-slate-100 bg-slate-50/70 p-4 dark:border-border dark:bg-muted/30'>
          <p className='mb-2 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
            Apply result
          </p>
          <div className='space-y-1'>
            {Object.entries(applyResult.applied ?? {}).map(([k, v]) => (
              <div
                key={k}
                className='flex items-center justify-between text-[12px] text-slate-600 dark:text-muted-foreground'
              >
                <span className='capitalize'>{k.replace(/_/g, ' ')}</span>
                <span className='font-mono tabular-nums'>{v}</span>
              </div>
            ))}
          </div>
          {(applyResult.skipped_destructive?.length ?? 0) > 0 && (
            <div className='mt-3 space-y-1'>
              <p className='text-[11px] font-semibold text-amber-700 dark:text-amber-400'>
                Skipped destructive changes
              </p>
              {(applyResult.skipped_destructive ?? []).map((s) => (
                <p key={`${s.kind}-${s.target}`} className='text-[11px] text-slate-500'>
                  <span className='font-mono'>{s.target}</span> — {s.reason}
                </p>
              ))}
            </div>
          )}
          {(applyResult.errors?.length ?? 0) > 0 && (
            <div className='mt-3 space-y-1'>
              <p className='text-[11px] font-semibold text-red-600'>Errors</p>
              {(applyResult.errors ?? []).map((e) => (
                <p key={e.target} className='text-[11px] text-red-500'>
                  <span className='font-mono'>{e.target}</span> — {e.error}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function SchemaSnapshotPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [lastExport, setLastExport] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)

  const exportSnapshot = useMutation({
    mutationFn: async () => {
      const response = await api.get('/schema-snapshot/export', { responseType: 'blob' })
      const disposition = (response.headers['content-disposition'] as string) ?? ''
      const match = disposition.match(/filename="?([^";\s]+)"?/)
      const filename = match?.[1] ?? `schema-snapshot-${Date.now()}.json`
      const url = URL.createObjectURL(
        new Blob([response.data as BlobPart], { type: 'application/json' })
      )
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      return filename
    },
    onSuccess: (filename) => {
      setLastExport(new Date().toLocaleString())
      toast.success(`Exported ${filename}`)
    },
    onError: () => toast.error('Export failed')
  })

  const importSnapshot = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text()
      const body = JSON.parse(text) as unknown
      const r = await api.post('/schema-snapshot/import', body)
      return r.data as ImportResult
    },
    onSuccess: (result) => {
      setImportResult(result.data ? (result.data as ImportResult) : result)
      toast.success('Snapshot imported')
    },
    onError: () => toast.error('Import failed — check the file format')
  })

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    setImportResult(null)
  }

  const counts = importResult?.imported ?? null

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>
          Schema Snapshot
        </h1>
      </div>

      <div className='p-8'>
        <div className='mx-auto max-w-2xl space-y-5'>
          {/* Export */}
          <div className='rounded-xl border border-slate-200 bg-white p-6'>
            <div className='flex items-center justify-between'>
              <div>
                <h2 className='text-[13px] font-semibold text-slate-900'>Export</h2>
                <p className='mt-0.5 text-[11px] text-slate-400'>
                  Download a JSON snapshot of all collections, fields, relations, and metadata.
                </p>
                {lastExport && (
                  <p className='mt-2 text-[11px] text-slate-500'>
                    Last exported: <span className='font-medium'>{lastExport}</span>
                  </p>
                )}
              </div>
              <Button
                onClick={() => exportSnapshot.mutate()}
                disabled={exportSnapshot.isPending}
                className='gap-2'
              >
                <Download className='h-3.5 w-3.5' />
                {exportSnapshot.isPending ? 'Exporting…' : 'Export Snapshot'}
              </Button>
            </div>
          </div>

          {/* Import */}
          <div className='rounded-xl border border-slate-200 bg-white p-6'>
            <h2 className='text-[13px] font-semibold text-slate-900'>Import</h2>
            <p className='mt-0.5 text-[11px] text-slate-400'>
              Upload a previously exported snapshot file.
            </p>

            <div className='mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5'>
              <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600' />
              <p className='text-[11px] text-amber-700'>
                Importing will upsert all resources. Existing records with matching IDs will be
                overwritten.
              </p>
            </div>

            <div className='mt-4 flex items-center gap-2'>
              <input
                ref={fileRef}
                type='file'
                accept='.json'
                onChange={handleFileChange}
                className='hidden'
              />
              <Button variant='outline' size='sm' onClick={() => fileRef.current?.click()}>
                Choose file
              </Button>
              <span className='text-[12px] text-slate-500'>
                {selectedFile ? selectedFile.name : 'No file selected'}
              </span>
              <Button
                size='sm'
                className='ml-auto gap-2'
                disabled={!selectedFile || importSnapshot.isPending}
                onClick={() => selectedFile && importSnapshot.mutate(selectedFile)}
              >
                <Upload className='h-3.5 w-3.5' />
                {importSnapshot.isPending ? 'Importing…' : 'Import Snapshot'}
              </Button>
            </div>

            {counts && (
              <div className='mt-4 rounded-lg border border-slate-100 bg-slate-50/70 p-4'>
                <p className='mb-2 text-[12px] font-semibold text-slate-700'>Import result</p>
                <div className='space-y-1'>
                  {Object.entries(counts).map(([resource, count]) => (
                    <div
                      key={resource}
                      className='flex items-center justify-between text-[12px] text-slate-600'
                    >
                      <span className='capitalize'>{resource.replace(/_/g, ' ')}</span>
                      <span className='font-mono tabular-nums text-slate-800'>{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {importResult && !counts && (
              <pre className='mt-4 max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100'>
                {JSON.stringify(importResult, null, 2)}
              </pre>
            )}
          </div>

          {/* Environment Sync */}
          <EnvironmentSyncCard />
        </div>
      </div>
    </>
  )
}
