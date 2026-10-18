/**
 * Inspector panels of the platform nodes: the storage backend (#2164), database server resources
 * (#2265), work queues (#2157), a running bulk action (#2271), a job's missed run (#2267), the
 * import worker's file size (#2268) and pending tuning proposals (#2199).
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import { fmtCount, fmtMs } from '../../EventTicker'
import { Empty, t as hhmmss, Section } from '../../Inspector'
import { useInspectDetail } from '../../inspect/api'
import type { InspectPanelProps } from '../../registry/inspectables'
import { inspectFooters } from '../../registry/inspectFooters'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { Sparkline } from '../../Sparkline'
import type { Selection } from '../../types'
import { snapExt } from '../b1-shared'
import { latestFrameValue, useDbLens } from '../db-lenses/shared'
import type { StatementDetail } from '../inspect-request/api'
import { LINK, SafeLink } from '../shared'
import {
  bulkOf,
  type DbServerSample,
  fmtAge,
  fmtBytes,
  fmtMb,
  fmtRate,
  fmtSaving,
  importSizeVerdict,
  isBulkNode,
  isQueueNode,
  isStorageNode,
  missFor,
  queueOf,
  STORAGE_PREFIX,
  type StorageOp,
  type StorageSnapshot,
  storageLevel,
  tuningFor,
  tuningForTables
} from './logic'
import { platformNow, usePlatformNodes } from './store'
import { Figs, HINT, LevelLine } from './ui'

const OP_LABEL: Record<StorageOp, string> = {
  read: 'Reads',
  write: 'Writes',
  delete: 'Deletes',
  check: 'Existence checks',
  list: 'Listings'
}

// ── #2164 storage backend ─────────────────────────────────────────────────────
function StoragePanel({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const snap = snapExt<StorageSnapshot>(model, 'storage')
  const fig = snap?.drivers[sel.id.slice(STORAGE_PREFIX.length)]
  if (!fig || !snap)
    return (
      <Section title='Storage backend'>
        <Empty>No file reads or writes in this window.</Empty>
      </Section>
    )
  const level = storageLevel(fig)
  const ops = Object.entries(fig.ops) as Array<
    [StorageOp, NonNullable<(typeof fig.ops)[StorageOp]>]
  >
  const failed = ops.reduce((a, [, o]) => a + o.failed, 0)
  const slow = ops.reduce((a, [, o]) => a + o.slow, 0)
  const moved = ops.reduce((a, [, o]) => a + o.bytes, 0)
  return (
    <Section title={`${fig.label} · what the backend itself did`}>
      <div className='grid gap-2' data-tm-storage={level}>
        <Figs
          items={[
            ['Moved', fmtBytes(moved)],
            ['Failed', fmtCount(failed), failed > 0],
            ['Slowest', fmtMs(fig.max_ms), fig.max_ms >= snap.slow_ms]
          ]}
        />
        <table className='w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='text-left text-[11.5px] text-[var(--tm-muted)]'>
              <th className='py-0.5 font-medium'>Call</th>
              <th className='py-0.5 text-right font-medium'>Count</th>
              <th className='py-0.5 text-right font-medium'>Bytes</th>
              <th className='py-0.5 text-right font-medium'>p50</th>
              <th className='py-0.5 text-right font-medium'>p95</th>
            </tr>
          </thead>
          <tbody>
            {ops.map(([op, o]) => (
              <tr key={op} data-tm-storage-op={op}>
                <td className='py-0.5'>{OP_LABEL[op]}</td>
                <td className='py-0.5 text-right'>
                  {fmtCount(o.n)}
                  {o.failed > 0 && (
                    <span className='text-[var(--tm-error-ink)]'> · {o.failed} failed</span>
                  )}
                  {o.missing > 0 && (
                    <span className='text-[var(--tm-muted)]'> · {o.missing} missing</span>
                  )}
                </td>
                <td className='py-0.5 text-right'>{o.bytes ? fmtBytes(o.bytes) : '—'}</td>
                <td className='py-0.5 text-right'>{fmtMs(o.p50_ms)}</td>
                <td
                  className={`py-0.5 text-right ${o.p95_ms >= snap.slow_ms ? 'text-[var(--tm-update)]' : ''}`}
                >
                  {fmtMs(o.p95_ms)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {fig.last_failure ? (
          <LevelLine level='error'>
            Last failure {hhmmss(new Date(fig.last_failure.at).toISOString())} on a{' '}
            {OP_LABEL[fig.last_failure.op].toLowerCase().replace(/s$/, '')}:{' '}
            {fig.last_failure.reason}
          </LevelLine>
        ) : slow > 0 ? (
          <LevelLine level='warn'>
            {slow} call{slow === 1 ? '' : 's'} took over {fmtMs(snap.slow_ms)}.
          </LevelLine>
        ) : (
          <LevelLine level='ok'>No failures and no slow calls in this window.</LevelLine>
        )}
        <p className={HINT}>
          Backend time only — the request around the call is on the File storage node. A missing
          object is counted as missing, not as a failure.
        </p>
      </div>
    </Section>
  )
}

// ── #2265 database server resources ───────────────────────────────────────────
function DbServerPanel() {
  const { model } = useTrafficMap()
  const { data, loading } = useDbLens<DbServerSample>('server', { every: 15_000 })
  const s = data ?? latestFrameValue<DbServerSample>(model, 'db-server', 60)
  return (
    <Section title='Database server resources'>
      <div className='grid gap-2' data-tm-db-server={s?.level ?? 'none'}>
        {!s && loading ? (
          <Empty>Reading the server's own counters…</Empty>
        ) : !s ? (
          <Empty>No server figures yet.</Empty>
        ) : !s.available ? (
          <Empty>{s.error ?? 'The server resources could not be read.'}</Empty>
        ) : (
          <>
            <Figs
              items={[
                ['SQL CPU', s.cpu ? `${s.cpu.sql_pct}%` : '—', !!s.cpu && s.cpu.sql_pct >= 95],
                ['Other CPU', s.cpu ? `${s.cpu.other_pct}%` : '—'],
                [
                  'tempdb used',
                  s.tempdb ? `${s.tempdb.used_pct}%` : '—',
                  !!s.tempdb && s.tempdb.used_pct >= 90
                ]
              ]}
            />
            {s.cpu && s.cpu.series.length > 1 && (
              <span className='flex items-center gap-2 text-[11.5px] text-[var(--tm-muted)]'>
                SQL CPU, last {s.cpu.series.length} min
                <Sparkline data={s.cpu.series} className='h-[14px] min-w-[60px] flex-1' />
              </span>
            )}
            {s.waits ? (
              <Figs
                items={[
                  ['Disk reads', `${s.waits.data_io} ms/s`, s.waits.data_io >= 1000],
                  ['Log writes', `${s.waits.log_io} ms/s`, s.waits.log_io >= 500],
                  ['Lock waits', `${s.waits.locks} ms/s`]
                ]}
              />
            ) : (
              <p className={HINT}>Wait rates appear after the second sample.</p>
            )}
            {s.memory && (
              <Figs
                items={[
                  [
                    'Waiting for memory',
                    fmtCount(s.memory.grants_waiting),
                    s.memory.grants_waiting >= 5
                  ],
                  [
                    'Grants held',
                    `${fmtCount(s.memory.grants_held)} · ${fmtMb(s.memory.granted_mb)}`
                  ],
                  [
                    'Server memory',
                    s.memory.sql_used_mb != null && s.memory.machine_total_mb
                      ? `${fmtMb(s.memory.sql_used_mb)} of ${fmtMb(s.memory.machine_total_mb)}`
                      : '—'
                  ]
                ]}
              />
            )}
            {s.tempdb && (
              <p className={HINT}>
                tempdb {fmtMb(s.tempdb.total_mb)}: user objects {fmtMb(s.tempdb.user_mb)}, sorts and
                hashes {fmtMb(s.tempdb.internal_mb)}, version store {fmtMb(s.tempdb.version_mb)},{' '}
                {fmtMb(s.tempdb.free_mb)} free.
              </p>
            )}
            <LevelLine level={s.level}>
              {s.reasons.length
                ? `${s.reasons.join('. ')}.`
                : 'The server has room on every counter.'}
            </LevelLine>
            <p className={HINT}>
              Read from the server's own views every 15 s while the map is open; disk and lock waits
              are the change since the last sample.
            </p>
          </>
        )}
      </div>
    </Section>
  )
}

// ── #2157 work queues ─────────────────────────────────────────────────────────
function QueuePanel({ sel }: { sel: Selection }) {
  const d = usePlatformNodes().data ?? platformNow()
  const q = queueOf(d, sel.id)
  if (!q)
    return (
      <Section title='Work queue'>
        <Empty>Nothing waiting and nothing moved in the last 15 minutes.</Empty>
      </Section>
    )
  return (
    <Section title={q.label}>
      <div className='grid gap-2' data-tm-queue={q.id} data-tm-queue-level={q.level}>
        <Figs
          items={[
            ['Waiting', fmtCount(q.depth), q.level === 'error'],
            ['Oldest', q.depth ? fmtAge(q.oldest_age_s) : '—', q.level !== 'ok'],
            ['Draining', q.drain_per_min != null ? fmtRate(q.drain_per_min, 'min') : '—']
          ]}
        />
        <LevelLine level={q.level}>
          {q.reason ??
            (q.depth === 0
              ? 'Empty — everything that arrived has been handled.'
              : q.eta_s != null
                ? `At this pace it empties in ${fmtAge(q.eta_s)}.`
                : 'Waiting for the next pass.')}
          {q.trend === 'growing' && q.reason !== 'The backlog is growing'
            ? ' The backlog is growing.'
            : q.trend === 'draining'
              ? ' It is shrinking.'
              : ''}
        </LevelLine>
        {q.retrying > 0 && (
          <p className={HINT}>{q.retrying} of them already failed once and wait to be retried.</p>
        )}
        <SafeLink to={q.link} className={`${LINK} w-fit text-[12px]`}>
          Open it
        </SafeLink>
      </div>
    </Section>
  )
}

// ── #2271 bulk action run ─────────────────────────────────────────────────────
function BulkPanel({ sel }: { sel: Selection }) {
  const d = usePlatformNodes().data ?? platformNow()
  const r = bulkOf(d, sel.id)
  if (!r)
    return (
      <Section title='Bulk action'>
        <Empty>This run has finished.</Empty>
      </Section>
    )
  return (
    <Section title={r.label}>
      <div className='grid gap-2' data-tm-bulk={r.id}>
        <Figs
          items={[
            [
              'Processed',
              r.total
                ? `${fmtCount(r.done + r.failed)} of ${fmtCount(r.total)}`
                : fmtCount(r.done + r.failed)
            ],
            ['Per second', r.per_s != null ? String(r.per_s) : '—'],
            ['Refused', fmtCount(r.failed), r.failed > 0]
          ]}
        />
        {r.pct != null && (
          <div
            className='h-1.5 overflow-hidden rounded-full bg-[var(--tm-line)]'
            role='progressbar'
            aria-valuenow={r.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label='Bulk action progress'
          >
            <div className='h-full bg-[var(--tm-accent)]' style={{ width: `${r.pct}%` }} />
          </div>
        )}
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          Started {hhmmss(r.started_at)}
          {r.by ? ` by ${r.by}` : ''}
          {r.collection ? ` · into ${r.collection}` : ''}
        </p>
        <p className={HINT}>The node goes away when the run finishes.</p>
        <SafeLink to='/background-jobs' className={`${LINK} w-fit text-[12px]`}>
          Open Background Jobs
        </SafeLink>
      </div>
    </Section>
  )
}

// ── #2267 missed runs on a job node ───────────────────────────────────────────
function MissedRunPanel({ sel }: { sel: Selection }) {
  const d = usePlatformNodes().data ?? platformNow()
  const m = missFor(d, sel.id)
  if (!m) return null
  return (
    <Section title='Missed run'>
      <div className='grid gap-1.5 text-[12px]' data-tm-missed-run={m.id}>
        <LevelLine level='warn'>This job did not run when it should have.</LevelLine>
        <p className='tabular-nums'>
          Expected {new Date(m.expected_at).toLocaleString()}
          <span className='text-[var(--tm-muted)]'> (grace {m.grace_min} min)</span>
        </p>
        <p className='tabular-nums'>
          {m.last_run_at
            ? `Last ran ${new Date(m.last_run_at).toLocaleString()}`
            : 'No run recorded'}
        </p>
        <p className={HINT}>Found by the miss detector, which checks every 30 minutes.</p>
      </div>
    </Section>
  )
}

// ── #2268 import size on the import worker node ───────────────────────────────
interface ImportRecent {
  id: number
  import_key: string
  status: string
  row_count: number | null
  duration: number | null
  finished_at: string | null
  file_bytes: number | string | null
}
interface ImportDetail {
  recent?: ImportRecent[]
}

function ImportSizePanel({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  // the same key as the source panel's read, so the two share one request
  const q = useQuery({
    queryKey: ['traffic-map', 'source-detail', sel.id],
    queryFn: async () =>
      (await api.get(`/traffic-map/source-detail?id=${encodeURIComponent(sel.id)}`)).data
        .data as ImportDetail,
    staleTime: 15_000,
    refetchInterval: 30_000
  })
  const cur = snapExt<{
    import: {
      current: {
        run_id: number
        key: string
        rows: number | null
        bytes?: number | null
        rows_per_s: number | null
      } | null
    }
  }>(model, 'sources')?.import.current
  const recent = (q.data?.recent ?? []).filter((r) => r.status === 'completed')
  const key = cur?.key ?? recent[0]?.import_key
  const same = recent.filter((r) => r.import_key === key)
  const runs = [
    ...(cur?.bytes ? [{ bytes: cur.bytes, rows: cur.rows, seconds: null as number | null }] : []),
    ...same.map((r) => ({
      bytes: r.file_bytes != null ? Number(r.file_bytes) : null,
      rows: r.row_count,
      seconds: r.duration
    }))
  ]
  const verdict = cur?.bytes ? null : importSizeVerdict(runs)
  if (!cur?.bytes && !same.length) return null
  return (
    <Section title='File size per run'>
      <div className='grid gap-2' data-tm-import-size=''>
        {cur?.bytes ? (
          <p className='text-[12px] tabular-nums' data-tm-import-size-current=''>
            Now: {fmtBytes(cur.bytes)}
            {cur.rows != null ? ` · ${fmtCount(cur.rows)} rows` : ''}
            {cur.rows_per_s != null ? ` · ${cur.rows_per_s} rows/s` : ''}
          </p>
        ) : null}
        {same.length > 0 && (
          <ul className='grid gap-0.5 text-[12px] tabular-nums'>
            {same.slice(0, 6).map((r) => (
              <li
                key={r.id}
                className='flex min-w-0 justify-between gap-2'
                data-tm-import-size-run={r.id}
              >
                <span className='min-w-0 truncate text-[var(--tm-fg-2)]'>
                  Run {r.id}
                  {r.finished_at ? ` · ${hhmmss(r.finished_at)}` : ''}
                </span>
                <span className='shrink-0'>
                  {r.file_bytes != null ? fmtBytes(Number(r.file_bytes)) : 'size unknown'}
                  {r.row_count != null ? ` · ${fmtCount(r.row_count)} rows` : ''}
                  {r.duration != null ? ` · ${fmtAge(r.duration)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {verdict && <LevelLine level={verdict.bigger ? 'ok' : 'warn'}>{verdict.text}</LevelLine>}
      </div>
    </Section>
  )
}

// ── #2199 tuning proposals ────────────────────────────────────────────────────
function TuningList({
  items
}: {
  items: Array<{ id: string; title: string; saving_ms_per_day: number; risk: string }>
}) {
  return (
    <ul className='grid gap-1.5 text-[12px]' data-tm-tuning=''>
      {items.slice(0, 5).map((p) => (
        <li key={p.id} className='grid gap-0.5' data-tm-tuning-proposal={p.id}>
          <span className='min-w-0 truncate font-medium' title={p.title}>
            {p.title}
          </span>
          <span className='text-[11.5px] text-[var(--tm-muted)]'>
            Saves {fmtSaving(p.saving_ms_per_day)}
            {p.risk === 'review' ? ' · needs review' : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

function EntityTuningPanel({ sel }: { sel: Selection }) {
  const d = usePlatformNodes().data ?? platformNow()
  const t = tuningFor(d, sel.id)
  if (!t || !d?.tuning) return null
  const items = d.tuning.proposals.filter((p) => p.entity === sel.id)
  return (
    <Section title={`Tuning proposals · ${t.count}`}>
      <div className='grid gap-2'>
        <TuningList items={items} />
        <SafeLink to='/db-tuning' className={`${LINK} w-fit text-[12px]`} id='tm-tuning-link'>
          Open Database tuning
        </SafeLink>
      </div>
    </Section>
  )
}

/** Under a statement shape: proposals for the tables the statement touches. */
function StatementTuningFooter({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const d = usePlatformNodes().data ?? platformNow()
  // the same key as the statement panel's read, so no second request goes out
  const detail = useInspectDetail<StatementDetail>(inspectRef, anchor, windowSec)
  const hits = tuningForTables(d, detail.data?.tables ?? [])
  if (!hits.length) return null
  return (
    <div className='grid gap-2' data-tm-statement-tuning=''>
      <h3 className='text-[12px] font-semibold text-[var(--tm-fg-2)]'>
        Tuning proposals for these tables · {hits.length}
      </h3>
      <TuningList items={hits} />
      <SafeLink to='/db-tuning' className={`${LINK} w-fit text-[12px]`}>
        Open Database tuning
      </SafeLink>
    </div>
  )
}

register(inspectorPanels, {
  id: 'platform-storage',
  order: 6,
  applies: (sel) => sel.kind === 'down' && isStorageNode(sel.id),
  Component: StoragePanel
})
register(inspectorPanels, {
  id: 'platform-db-server',
  order: 7,
  applies: (sel) => sel.kind === 'down' && sel.id === 'db',
  Component: DbServerPanel
})
register(inspectorPanels, {
  id: 'platform-queue',
  order: 20,
  applies: (sel) => sel.kind === 'down' && isQueueNode(sel.id),
  Component: QueuePanel
})
register(inspectorPanels, {
  id: 'platform-bulk',
  order: 20,
  applies: (sel) => sel.kind === 'down' && isBulkNode(sel.id),
  Component: BulkPanel
})
register(inspectorPanels, {
  id: 'platform-missed-run',
  order: 4,
  applies: (sel) => sel.kind === 'caller' && sel.id.startsWith('cron:'),
  Component: MissedRunPanel
})
register(inspectorPanels, {
  id: 'platform-import-size',
  order: 12,
  applies: (sel) => sel.kind === 'caller' && sel.id === 'import:worker',
  Component: ImportSizePanel
})
register(inspectorPanels, {
  id: 'platform-tuning',
  order: 45,
  applies: (sel) => sel.kind === 'entity',
  Component: EntityTuningPanel
})
register(inspectFooters, {
  id: 'platform-statement-tuning',
  order: 30,
  applies: (ref) => ref.kind === 'statement',
  Component: StatementTuningFooter
})
