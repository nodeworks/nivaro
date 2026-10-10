import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, HardDrive } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../../ui/dialog'
import { helpVideoError } from '../api'
import { helpVideoSettingsApi, helpVideoSettingsKeys, type StoragePlanDto } from './api'
import {
  formatBytes,
  nextStorageSort,
  parseRetentionInput,
  type StorageRow,
  type StorageSort,
  type StorageSortKey,
  sortStorageRows,
  storageRows
} from './storage'

const noteClass = 'text-[12px] text-muted-foreground'
const warnClass =
  'rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
const errorClass =
  'rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12.5px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
const inputClass =
  'h-8 w-20 rounded-md border border-border bg-background px-2 text-[13px] tabular-nums text-foreground disabled:opacity-60'
const th =
  'sticky top-0 bg-card px-2 py-1.5 text-left text-[11.5px] font-medium text-muted-foreground'
const td = 'px-2 py-1 align-top text-[12.5px]'
const num = `${td} text-right tabular-nums`

const COLUMNS: Array<{ key: StorageSortKey; label: string; right?: boolean }> = [
  { key: 'title', label: 'Video' },
  { key: 'version', label: 'Version' },
  { key: 'state', label: 'State' },
  { key: 'created_at', label: 'Created' },
  { key: 'source', label: 'Recording', right: true },
  { key: 'rendered', label: 'Render', right: true },
  { key: 'captions', label: 'Captions', right: true },
  { key: 'poster', label: 'Poster', right: true },
  { key: 'bytes', label: 'Total', right: true }
]
const STATE_LABEL: Record<StorageRow['state'], string> = {
  published: 'Published',
  draft: 'Draft',
  earlier: 'Earlier cut',
  removed: 'Files removed'
}

/** What help videos take up, with the retention rule and the next sweep (#1531). Administrators only. */
export function StorageButton() {
  const { isAdmin } = useItemEditAuth()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const ids = { retention: useId() }
  const [open, setOpen] = useState(false)
  const [sort, setSort] = useState<StorageSort>({ key: 'bytes', dir: 'desc' })
  const [retention, setRetention] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [sweeping, setSweeping] = useState(false)
  const [sweepNote, setSweepNote] = useState<string | null>(null)
  const report = useQuery({
    queryKey: helpVideoSettingsKeys.storage,
    enabled: isAdmin && open,
    queryFn: () => helpVideoSettingsApi(client).storage()
  })
  const plan = useQuery({
    queryKey: helpVideoSettingsKeys.storagePlan,
    enabled: isAdmin && open && report.data?.retention_days != null,
    queryFn: () => helpVideoSettingsApi(client).storagePlan()
  })
  const dto = report.data
  useEffect(() => {
    if (dto && open) setRetention(dto.retention_days == null ? '' : String(dto.retention_days))
  }, [dto, open])
  if (!isAdmin) return null

  const migrated = dto?.migrated !== false
  const rows = dto ? sortStorageRows(storageRows(dto.videos), sort) : []
  const parsed = dto ? parseRetentionInput(retention, dto.limits) : null
  const dirty = !!dto && !!parsed && parsed.ok && parsed.days !== (dto.retention_days ?? null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: helpVideoSettingsKeys.storage })
    void qc.invalidateQueries({ queryKey: helpVideoSettingsKeys.storagePlan })
  }
  const save = async () => {
    if (!dto || !parsed) return
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await helpVideoSettingsApi(client).saveRetention(parsed.days)
      qc.setQueryData(helpVideoSettingsKeys.storage, {
        ...dto,
        retention_days: next.retention_days
      })
      void qc.invalidateQueries({ queryKey: helpVideoSettingsKeys.storagePlan })
      setSaved(true)
    } catch (e) {
      const err = helpVideoError(e)
      setError(
        err?.code === 'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
          ? 'Not saved: this database needs the update that adds these settings (migration 410).'
          : `Not saved. ${(e as Error).message}`
      )
    } finally {
      setSaving(false)
    }
  }
  const sweep = async () => {
    setSweeping(true)
    setSweepNote(null)
    try {
      const r = await helpVideoSettingsApi(client).sweepStorage()
      setSweepNote(r.summary)
      refresh()
    } catch (e) {
      setSweepNote(`The sweep could not run. ${(e as Error).message}`)
    } finally {
      setSweeping(false)
    }
  }
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setError(null)
          setSaved(false)
          setSweepNote(null)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size='sm' variant='outline' data-hv-storage>
          <HardDrive className='mr-1 h-4 w-4' aria-hidden /> Storage
        </Button>
      </DialogTrigger>
      <DialogContent
        className='flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[960px] flex-col dark:bg-card'
        data-hv-storage-panel
      >
        <DialogHeader>
          <DialogTitle className='text-[16px] dark:text-foreground'>Storage</DialogTitle>
          <DialogDescription className='text-[13px] text-muted-foreground'>
            What help videos take up, per video and version, and the retention rule that removes
            superseded versions' files.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='min-h-0 flex-1 space-y-3 overflow-y-auto text-[13px]'>
          {report.isError ? (
            <p className={errorClass} role='alert'>
              Storage could not be loaded.{' '}
              <button type='button' className='underline' onClick={() => void report.refetch()}>
                Try again
              </button>
            </p>
          ) : !dto ? (
            <p className={noteClass} role='status'>
              Loading…
            </p>
          ) : (
            <>
              <dl
                className='grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border px-3 py-2 sm:grid-cols-4'
                data-hv-storage-totals
              >
                <Total label='Everything' value={dto.totals.bytes} />
                <Total label='Recordings' value={dto.totals.by_role.source} />
                <Total label='Renders' value={dto.totals.by_role.rendered} />
                <Total
                  label='Captions and posters'
                  value={dto.totals.by_role.captions + dto.totals.by_role.poster}
                />
                <p className={`${noteClass} col-span-full`}>
                  {dto.totals.files} files across {dto.totals.versions} versions of{' '}
                  {dto.totals.videos} videos.
                </p>
              </dl>

              <section className='space-y-1.5' aria-labelledby={`${ids.retention}-h`}>
                <h3 id={`${ids.retention}-h`} className='text-[13px] font-semibold text-foreground'>
                  Retention
                </h3>
                {!migrated && (
                  <p className={warnClass} data-hv-storage-migration>
                    The retention rule needs a database update (migration 410) before it can be
                    saved.
                  </p>
                )}
                <div className='flex flex-wrap items-center gap-2'>
                  <label htmlFor={ids.retention} className='text-[12.5px]'>
                    Remove the files of earlier cuts after
                  </label>
                  <input
                    id={ids.retention}
                    type='number'
                    min={dto.limits.retention_min_days}
                    max={dto.limits.retention_max_days}
                    step={1}
                    value={retention}
                    placeholder='never'
                    disabled={!migrated}
                    onChange={(e) => {
                      setRetention(e.target.value)
                      setSaved(false)
                    }}
                    className={inputClass}
                    data-hv-storage-retention
                  />
                  <span className='text-[12.5px]'>days</span>
                  <Button
                    size='sm'
                    disabled={!migrated || saving || !dirty}
                    onClick={() => void save()}
                    data-hv-storage-save
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                  {saved && !dirty && (
                    <span
                      className='text-[12px] text-emerald-700 dark:text-emerald-300'
                      role='status'
                    >
                      Saved
                    </span>
                  )}
                </div>
                <p className={noteClass}>
                  Blank keeps everything. The published version and its recording, the current
                  draft, versions with a render queued or running, and any version whose recording a
                  kept version still uses are always kept. Runs every night; each removed file is
                  written to the activity log.
                </p>
                {parsed && !parsed.ok && (
                  <p className={errorClass} role='alert'>
                    {parsed.error}
                  </p>
                )}
                {error && (
                  <p className={errorClass} role='alert'>
                    {error}
                  </p>
                )}
              </section>

              <section className='space-y-1.5' data-hv-storage-plan>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <h3 className='text-[13px] font-semibold text-foreground'>Next sweep</h3>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={sweeping || dto.retention_days == null || !plan.data?.migrated}
                    onClick={() => void sweep()}
                    data-hv-storage-sweep
                  >
                    {sweeping ? 'Running…' : 'Run now'}
                  </Button>
                </div>
                <PlanSummary
                  retention={dto.retention_days}
                  plan={plan.data}
                  loading={plan.isLoading}
                  failed={plan.isError}
                />
                {sweepNote && (
                  <p className={noteClass} role='status' data-hv-storage-sweep-note>
                    {sweepNote}
                  </p>
                )}
              </section>

              <div className='overflow-x-auto rounded-md border border-border'>
                <table className='w-full border-collapse' data-hv-storage-table>
                  <thead>
                    <tr className='border-b border-border'>
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          scope='col'
                          className={`${th} ${c.right ? 'text-right' : ''}`}
                          aria-sort={
                            sort.key === c.key
                              ? sort.dir === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          <button
                            type='button'
                            className='inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                            onClick={() => setSort((s) => nextStorageSort(s, c.key))}
                            data-hv-storage-sort={c.key}
                          >
                            {c.label}
                            {sort.key === c.key && <Arrow className='h-3 w-3' aria-hidden />}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.version_id}
                        className='border-b border-border last:border-b-0'
                        data-hv-storage-row={r.version_id}
                      >
                        <td className={`${td} max-w-[260px]`}>
                          <span className='block truncate' title={r.title}>
                            {r.title}
                          </span>
                          {r.status !== 'published' && (
                            <span className={noteClass}>{r.status}</span>
                          )}
                        </td>
                        <td className={`${td} tabular-nums`}>v{r.version}</td>
                        <td className={td}>{STATE_LABEL[r.state]}</td>
                        <td className={`${td} whitespace-nowrap`}>
                          {new Date(r.created_at).toLocaleDateString()}
                        </td>
                        <td className={num}>{formatBytes(r.source)}</td>
                        <td className={num}>{formatBytes(r.rendered)}</td>
                        <td className={num}>{formatBytes(r.captions)}</td>
                        <td className={num}>{formatBytes(r.poster)}</td>
                        <td className={`${num} font-medium`}>{formatBytes(r.bytes)}</td>
                      </tr>
                    ))}
                    {!rows.length && (
                      <tr>
                        <td className={td} colSpan={COLUMNS.length}>
                          No videos yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className={noteClass}>{label}</dt>
      <dd className='text-[14px] font-semibold tabular-nums'>{formatBytes(value)}</dd>
    </div>
  )
}

function PlanSummary({
  retention,
  plan,
  loading,
  failed
}: {
  retention: number | null
  plan: StoragePlanDto | undefined
  loading: boolean
  failed: boolean
}) {
  if (retention == null) {
    return <p className={noteClass}>Retention is off: the sweep removes nothing.</p>
  }
  if (failed) {
    return (
      <p className={errorClass} role='alert'>
        The plan could not be loaded.
      </p>
    )
  }
  if (!plan || loading) {
    return (
      <p className={noteClass} role='status'>
        Working out what the next sweep would remove…
      </p>
    )
  }
  if (!plan.migrated) {
    return (
      <p className={warnClass} data-hv-storage-plan-migration>
        The sweep needs a database update (migration 415) before it can remove anything.
      </p>
    )
  }
  if (!plan.removals.length) {
    return (
      <p className={noteClass} data-hv-storage-plan-empty>
        Nothing to remove: every earlier cut is newer than {retention} days or still in use.
      </p>
    )
  }
  return (
    <div className='space-y-1'>
      <p className={noteClass}>
        The next sweep removes {plan.files} files ({formatBytes(plan.bytes)}) from{' '}
        {plan.removals.length} versions:
      </p>
      <ul className='max-h-40 space-y-0.5 overflow-y-auto text-[12.5px]' data-hv-storage-removals>
        {plan.removals.map((r) => (
          <li key={r.version_id} className='flex flex-wrap gap-x-2'>
            <span className='font-medium'>
              {r.title || 'Untitled video'} v{r.version}
            </span>
            <span className='text-muted-foreground'>
              {r.why} · {r.files.map((f) => f.role).join(', ') || 'no files'} ·{' '}
              {formatBytes(r.bytes)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
