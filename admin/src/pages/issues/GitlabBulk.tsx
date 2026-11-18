import { toastError } from '@nivaro/shared'
import { Gitlab, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { MonCombobox } from '@/components/filter-combobox'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { TrackerConnection } from '../issue-trackers/api'
import { BULK_MAX, type BulkResult, type BulkSummary, bulkSentence, summarizeBulk } from './gitlab'

export type GitlabFilterValue = '' | 'linked' | 'unlinked' | 'suggested'

export const GITLAB_FILTERS: Array<{ value: GitlabFilterValue; label: string }> = [
  { value: '', label: 'Any GitLab' },
  { value: 'linked', label: 'In GitLab' },
  { value: 'unlinked', label: 'Not in GitLab' },
  { value: 'suggested', label: 'Suggested' }
]

/**
 * "Create GitLab issues" in the bulk bar (admins, GitLab sync on). A dry run first says whether
 * the batch passes the connection's hourly limit (30); then the batch is queued and the outcome of
 * each selected issue is reported: sent, already linked, or refused with the server's reason.
 */
export function GitlabBulkCreate({
  ids,
  connections,
  onDone
}: {
  ids: number[]
  connections: TrackerConnection[]
  onDone: () => void
}) {
  const [connection, setConnection] = useState<number>(connections[0]?.id ?? 0)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<BulkSummary | null>(null)
  const tooMany = ids.length > BULK_MAX
  const conn = connections.find((c) => c.id === connection) ?? connections[0]
  // The second press ("create anyway") belongs to the batch the dry run judged: another
  // selection or connection is a new batch and gets its own dry run first.
  const batchKey = `${conn?.id ?? 0}|${ids.join(',')}`
  const [overCapFor, setOverCapFor] = useState<string | null>(null)
  const overCap = overCapFor === batchKey
  const setOverCap = (on: boolean) => setOverCapFor(on ? batchKey : null)

  const send = async (force: boolean) => {
    if (!conn || tooMany || busy) return
    setBusy(true)
    try {
      if (!(force && overCap)) {
        const dry = await api.post<{ data: { would_pass_cap: boolean } }>('/trackers/links/bulk', {
          issues: ids,
          connection: conn.id,
          dry_run: true
        })
        if (dry.data.data?.would_pass_cap) {
          setOverCap(true)
          return
        }
      }
      setOverCap(false)
      const r = await api.post<{ data: { results: BulkResult[] } }>('/trackers/links/bulk', {
        issues: ids,
        connection: conn.id
      })
      setSummary(summarizeBulk(r.data.data?.results ?? []))
      onDone()
    } catch (err) {
      toastError(err, 'Could not send the selected issues to GitLab')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {connections.length > 1 && (
        <MonCombobox
          value={String(connection)}
          onChange={(v) => v && setConnection(Number(v))}
          options={connections.map((c) => ({ value: String(c.id), label: c.name }))}
          className='h-7 w-40'
        />
      )}
      {overCap ? (
        <Button
          size='sm'
          variant='outline'
          className='h-7 gap-1.5 border-amber-400 text-[12px] text-amber-800 hover:bg-amber-50 dark:border-amber-500/50 dark:text-amber-300 dark:hover:bg-amber-500/10'
          disabled={busy}
          onClick={() => void send(true)}
          aria-label='Over 30 GitLab issues this hour — create anyway?'
        >
          <Gitlab className='h-3.5 w-3.5' aria-hidden />
          Over 30 this hour — create anyway?
        </Button>
      ) : (
        <Button
          size='sm'
          variant='outline'
          className='h-7 gap-1.5 text-[12px]'
          disabled={busy || tooMany || !conn}
          onClick={() => void send(false)}
          aria-label='Create GitLab issues'
          data-tip={tooMany ? `At most ${BULK_MAX} at once` : undefined}
        >
          <Gitlab className='h-3.5 w-3.5' aria-hidden />
          {busy ? 'Sending…' : 'Create GitLab issues'}
        </Button>
      )}
      {summary && <GitlabBulkReport summary={summary} onClose={() => setSummary(null)} />}
    </>
  )
}

/** The per-issue outcome of a bulk create, under the bulk bar until dismissed. */
export function GitlabBulkReport({
  summary,
  onClose
}: {
  summary: BulkSummary
  onClose: () => void
}) {
  const ids = (list: number[]) =>
    list.map((id, i) => (
      <span key={id}>
        {i > 0 && ', '}
        <Link to={`/issues/${id}`} className='tabular-nums hover:underline'>
          #{id}
        </Link>
      </span>
    ))
  return (
    <div
      role='status'
      aria-label='GitLab results'
      className={cn(
        'basis-full rounded-md border px-3 py-2 text-[12px]',
        summary.refused.length
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          : 'border-slate-200 bg-white text-slate-800 dark:border-border dark:bg-card dark:text-foreground'
      )}
    >
      <div className='flex items-start gap-2'>
        <p className='flex-1 font-medium'>{bulkSentence(summary)}</p>
        <button
          type='button'
          onClick={onClose}
          aria-label='Dismiss GitLab results'
          className='rounded p-0.5 text-current opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {summary.queued.length > 0 && (
        <p className='mt-1'>Sent: {ids(summary.queued)}. GitLab links appear as each one lands.</p>
      )}
      {summary.alreadyLinked.length > 0 && (
        <p className='mt-1'>Already in GitLab: {ids(summary.alreadyLinked)}</p>
      )}
      {summary.refused.length > 0 && (
        <ul className='mt-1 space-y-0.5'>
          {summary.refused.map((r) => (
            <li key={r.issue}>
              <Link to={`/issues/${r.issue}`} className='tabular-nums hover:underline'>
                #{r.issue}
              </Link>{' '}
              — {r.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
