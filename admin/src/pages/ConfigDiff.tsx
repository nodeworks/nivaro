import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  GitCompare,
  Upload
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'

interface Instance {
  version: string
  environment: string
  database: string
  label?: string
}

interface Classification {
  config: string[]
  derived: string[]
  runtime: string[]
  unclassified: string[]
  absent: string[]
}

interface Inventory {
  instance: Instance
  classification: Classification
  counts: Record<string, number>
}

interface FieldDiff {
  field: string
  mine: unknown
  theirs: unknown
}

interface TableDiff {
  table: string
  added: string[]
  removed: string[]
  changed: Array<{ key: string; fields: FieldDiff[] }>
  same: number
  only_on: 'mine' | 'theirs' | null
}

interface SnapshotDiff {
  mine: Instance
  theirs: Instance
  generated_at: { mine: string; theirs: string }
  tables: TableDiff[]
  totals: { added: number; removed: number; changed: number; tables_differing: number }
  schema_drift: { only_mine: string[]; only_theirs: string[] }
}

function short(v: unknown): string {
  if (v === null || v === undefined) return '—'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 140 ? `${s.slice(0, 140)}…` : s
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <p className='text-[11px] uppercase tracking-wide text-muted-foreground'>{label}</p>
      <p className={cn('mt-0.5 text-[18px] font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  )
}

function TableDiffRow({ diff }: { diff: TableDiff }) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className='border-b border-slate-200 last:border-0 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted'
      >
        <Chevron className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
        <span className='min-w-0 flex-1 truncate font-mono text-[12px]'>{diff.table}</span>
        {diff.only_on && (
          <span className='shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400'>
            only on {diff.only_on === 'mine' ? 'this instance' : 'the uploaded one'}
          </span>
        )}
        <span className='w-16 shrink-0 text-right text-[12px] tabular-nums text-green-600 dark:text-green-400'>
          {diff.added.length ? `+${diff.added.length}` : ''}
        </span>
        <span className='w-16 shrink-0 text-right text-[12px] tabular-nums text-red-600 dark:text-red-400'>
          {diff.removed.length ? `−${diff.removed.length}` : ''}
        </span>
        <span className='w-16 shrink-0 text-right text-[12px] tabular-nums text-amber-600 dark:text-amber-400'>
          {diff.changed.length ? `~${diff.changed.length}` : ''}
        </span>
        <span className='w-20 shrink-0 text-right text-[11px] text-muted-foreground'>
          {formatNumber(diff.same)} same
        </span>
      </button>

      {open && (
        <div className='space-y-3 bg-slate-50 px-3 py-3 dark:bg-background'>
          {diff.added.length > 0 && (
            <div>
              <p className='mb-1 text-[11px] font-medium text-green-600 dark:text-green-400'>
                Only here ({diff.added.length})
              </p>
              <p className='break-all font-mono text-[10.5px] text-muted-foreground'>
                {diff.added.slice(0, 40).join(', ')}
                {diff.added.length > 40 ? ` … +${diff.added.length - 40}` : ''}
              </p>
            </div>
          )}
          {diff.removed.length > 0 && (
            <div>
              <p className='mb-1 text-[11px] font-medium text-red-600 dark:text-red-400'>
                Only on the uploaded instance ({diff.removed.length})
              </p>
              <p className='break-all font-mono text-[10.5px] text-muted-foreground'>
                {diff.removed.slice(0, 40).join(', ')}
                {diff.removed.length > 40 ? ` … +${diff.removed.length - 40}` : ''}
              </p>
            </div>
          )}
          {diff.changed.length > 0 && (
            <div>
              <p className='mb-1 text-[11px] font-medium text-amber-600 dark:text-amber-400'>
                Changed ({diff.changed.length})
              </p>
              <div className='space-y-2'>
                {diff.changed.slice(0, 25).map((row) => (
                  <div
                    key={row.key}
                    className='rounded border border-slate-200 bg-white p-2 dark:border-border dark:bg-card'
                  >
                    <p className='mb-1 font-mono text-[10.5px] text-muted-foreground'>{row.key}</p>
                    {row.fields.length === 0 && (
                      // Hashes differ but every value compares equal — the two
                      // snapshots hashed different column sets, i.e. the
                      // instances are on different migrations for this table.
                      <p className='text-[10.5px] text-muted-foreground'>
                        Row hashes differ but no field values do — the two instances captured
                        different columns for this table.
                      </p>
                    )}
                    {row.fields.map((f) => (
                      <div key={f.field} className='grid grid-cols-[140px_1fr_1fr] gap-2 py-0.5'>
                        <span className='truncate font-mono text-[10.5px]'>{f.field}</span>
                        <span className='break-all text-[10.5px] text-green-700 dark:text-green-400'>
                          {short(f.mine)}
                        </span>
                        <span className='break-all text-[10.5px] text-red-700 dark:text-red-400'>
                          {short(f.theirs)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
                {diff.changed.length > 25 && (
                  <p className='text-[11px] text-muted-foreground'>
                    +{diff.changed.length - 25} more changed rows — download both snapshots to see
                    the full set.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ConfigDiffPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: inventory } = useQuery<Inventory>({
    queryKey: ['config-inventory'],
    queryFn: () => api.get<{ data: Inventory }>('/config-diff/inventory').then((r) => r.data.data)
  })

  const compare = useMutation<SnapshotDiff, Error, unknown>({
    mutationFn: (snapshot) =>
      api
        .post<{ data: SnapshotDiff }>('/config-diff/compare', { snapshot })
        .then((r) => r.data.data)
  })

  async function download() {
    const res = await api.get<{ data: unknown }>('/config-diff/snapshot')
    const blob = new Blob([JSON.stringify(res.data.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nivaro-config-${inventory?.instance.database ?? 'snapshot'}-${new Date()
      .toISOString()
      .slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function onFile(file: File) {
    setError(null)
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      // Accept the raw snapshot, the API envelope it was downloaded inside, or
      // a {snapshot} wrapper — operators hand over whichever they happen to
      // have, and rejecting a file over its wrapper helps nobody.
      const unwrapped =
        parsed && typeof parsed === 'object' && !('tables' in parsed)
          ? ((parsed.data ?? parsed.snapshot ?? parsed) as unknown)
          : parsed
      compare.mutate(unwrapped)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file as JSON')
    }
  }

  const diff = compare.data
  const totalConfigRows = Object.values(inventory?.counts ?? {}).reduce((a, b) => a + b, 0)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <GitCompare className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-lg font-semibold'>Environment Config</h1>
            <p className='text-[11px] text-muted-foreground'>
              What differs between this instance and another one.
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className='h-8 gap-1.5 text-[12px]'
            onClick={download}
          >
            <Download className='h-3.5 w-3.5' />
            Download snapshot
          </Button>
          <Button
            size='sm'
            className='h-8 gap-1.5 text-[12px]'
            disabled={compare.isPending}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className='h-3.5 w-3.5' />
            {compare.isPending ? 'Comparing…' : 'Compare a snapshot'}
          </Button>
          <input
            ref={fileRef}
            type='file'
            accept='application/json,.json'
            className='hidden'
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <div className='mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4'>
          <Stat label='This instance' value={inventory?.instance.database ?? '—'} />
          <Stat
            label='Version / env'
            value={
              inventory ? `${inventory.instance.version} · ${inventory.instance.environment}` : '—'
            }
          />
          <Stat
            label='Config tables'
            value={inventory ? String(inventory.classification.config.length) : '—'}
          />
          <Stat label='Config rows' value={formatNumber(totalConfigRows)} />
        </div>

        {inventory && inventory.classification.unclassified.length > 0 && (
          <div className='mb-4 flex gap-2 rounded-lg border border-amber-300 bg-white p-3 dark:border-amber-500/40 dark:bg-card'>
            <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400' />
            <div>
              <p className='text-[12px] font-medium'>
                {inventory.classification.unclassified.length} table(s) are not classified
              </p>
              <p className='text-[11px] text-muted-foreground'>
                A migration added tables this build has never classified, so they are excluded from
                every snapshot and diff. Add them to CONFIG_TABLES, DERIVED_TABLES or RUNTIME_TABLES
                in <span className='font-mono'>services/config-inventory.ts</span>:{' '}
                <span className='font-mono'>
                  {inventory.classification.unclassified.join(', ')}
                </span>
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className='mb-4 rounded-lg border border-red-300 bg-white p-3 text-[12px] text-red-600 dark:border-red-500/40 dark:bg-card dark:text-red-400'>
            {error}
          </div>
        )}
        {compare.isError && (
          <div className='mb-4 rounded-lg border border-red-300 bg-white p-3 text-[12px] text-red-600 dark:border-red-500/40 dark:bg-card dark:text-red-400'>
            {compare.error.message}
          </div>
        )}

        {!diff ? (
          <div className='rounded-lg border border-slate-200 bg-white p-8 text-center dark:border-border dark:bg-card'>
            <p className='text-[13px] font-medium'>No comparison yet</p>
            <p className='mx-auto mt-1 max-w-[62ch] text-[12px] text-muted-foreground'>
              Download a snapshot from the other environment, then upload it here. Comparison is
              file-based rather than instance-to-instance so the two environments never need to
              reach each other over the network. Secrets are stripped from every snapshot before it
              leaves the server.
            </p>
          </div>
        ) : (
          <>
            <div className='mb-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
              <div className='mb-3 grid gap-2 sm:grid-cols-2'>
                <div>
                  <p className='text-[11px] uppercase tracking-wide text-green-600 dark:text-green-400'>
                    This instance
                  </p>
                  <p className='text-[13px] font-medium'>{diff.mine.database}</p>
                  <p className='text-[11px] text-muted-foreground'>
                    {diff.mine.version} · {diff.mine.environment}
                  </p>
                </div>
                <div>
                  <p className='text-[11px] uppercase tracking-wide text-red-600 dark:text-red-400'>
                    Uploaded snapshot
                  </p>
                  <p className='text-[13px] font-medium'>
                    {diff.theirs.database}
                    {diff.theirs.label ? ` (${diff.theirs.label})` : ''}
                  </p>
                  <p className='text-[11px] text-muted-foreground'>
                    {diff.theirs.version} · {diff.theirs.environment} · taken{' '}
                    {new Date(diff.generated_at.theirs).toLocaleString()}
                  </p>
                </div>
              </div>

              <div className='grid grid-cols-4 gap-2'>
                <Stat
                  label='Only here'
                  value={formatNumber(diff.totals.added)}
                  tone='text-green-600 dark:text-green-400'
                />
                <Stat
                  label='Only there'
                  value={formatNumber(diff.totals.removed)}
                  tone='text-red-600 dark:text-red-400'
                />
                <Stat
                  label='Changed'
                  value={formatNumber(diff.totals.changed)}
                  tone='text-amber-600 dark:text-amber-400'
                />
                <Stat label='Tables differing' value={String(diff.totals.tables_differing)} />
              </div>

              {(diff.schema_drift.only_mine.length > 0 ||
                diff.schema_drift.only_theirs.length > 0) && (
                <p className='mt-3 text-[11px] text-muted-foreground'>
                  <span className='font-medium text-amber-600 dark:text-amber-400'>
                    Schema drift:
                  </span>{' '}
                  {diff.schema_drift.only_mine.length > 0 &&
                    `${diff.schema_drift.only_mine.length} table(s) exist only here`}
                  {diff.schema_drift.only_mine.length > 0 &&
                    diff.schema_drift.only_theirs.length > 0 &&
                    ' · '}
                  {diff.schema_drift.only_theirs.length > 0 &&
                    `${diff.schema_drift.only_theirs.length} only there`}
                  {' — the two instances are on different migrations.'}
                </p>
              )}
            </div>

            {diff.tables.length === 0 ? (
              <div className='rounded-lg border border-slate-200 bg-white p-8 text-center dark:border-border dark:bg-card'>
                <p className='text-[13px] font-medium text-green-600 dark:text-green-400'>
                  Configuration is identical
                </p>
                <p className='mt-1 text-[12px] text-muted-foreground'>
                  Every captured config row matches across both instances.
                </p>
              </div>
            ) : (
              <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
                  <span className='flex-1 text-[12px] font-medium'>Differences by table</span>
                  <span className='w-16 text-right text-[10.5px] uppercase tracking-wide text-muted-foreground'>
                    here
                  </span>
                  <span className='w-16 text-right text-[10.5px] uppercase tracking-wide text-muted-foreground'>
                    there
                  </span>
                  <span className='w-16 text-right text-[10.5px] uppercase tracking-wide text-muted-foreground'>
                    changed
                  </span>
                  <span className='w-20' />
                </div>
                {diff.tables.map((t) => (
                  <TableDiffRow key={t.table} diff={t} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
