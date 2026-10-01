// Topology (Traffic Map group C) — inspector panels for the new node kinds: sources (cron jobs,
// flows, the import worker, browser sockets) and downstream nodes (partners with their error
// classes and latency, email/SMS/push/Teams, AI provider, webhooks, Redis detail, SQL Server pool
// pressure). Window figures come from the topology poll; run history from the detail routes.
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { entityLabel, fmtCount, fmtMs } from '../../EventTicker'
import { Bar, Empty, Section, t } from '../../Inspector'
import { downKindOf, downLabel, OTHER_SOURCES } from '../../nodeKinds'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import {
  CLASS_HINT,
  CLASS_LABEL,
  CLASS_VAR,
  ERROR_CLASSES,
  type ErrorClass,
  isPartnerDown
} from './canvas'
import { type TopologyData, useTopology } from './store'

const LINK =
  'rounded-sm text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function useTop(): TopologyData | undefined {
  const { win, paused } = useTrafficMap()
  return useTopology(win, paused).data
}

/** A row of label/value figures (the inspector's own Facts grid, for panels). */
function Figures({ items }: { items: Array<[string, ReactNode, boolean?]> }) {
  return (
    <dl className='grid grid-cols-3 gap-x-3 gap-y-2'>
      {items.map(([k, v, bad]) => (
        <div key={k} className='min-w-0'>
          <dt className='truncate text-[11.5px] text-[var(--tm-muted)]'>{k}</dt>
          <dd
            className={cn(
              'text-[13.5px] font-semibold tabular-nums',
              bad && 'text-[var(--tm-error-ink)]'
            )}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const fmtTime = (v: unknown): string => {
  if (v == null) return '—'
  const d = new Date(typeof v === 'number' ? v : String(v))
  return Number.isNaN(d.getTime()) ? '—' : t(d.toISOString())
}
const isOk = (status: unknown) => status === 'success' || status === 'completed' || status === 'ok'

function RunRow({
  status,
  at,
  ms,
  note
}: {
  status: string
  at: unknown
  ms: number | null | undefined
  note?: string | null
}) {
  const ok = isOk(status)
  return (
    <li
      className='grid min-w-0 grid-cols-[auto_auto_auto_minmax(0,1fr)] items-baseline gap-2 text-[11.5px]'
      data-tm-run={status}
    >
      <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
        {fmtTime(at)}
      </span>
      <span
        className='font-medium'
        style={{
          color: ok
            ? 'var(--tm-create)'
            : status === 'running' || status === 'queued'
              ? 'var(--tm-fg-2)'
              : 'var(--tm-error-ink)'
        }}
      >
        {status}
      </span>
      <span className='tabular-nums text-[var(--tm-fg-2)]'>{ms != null ? fmtMs(ms) : ''}</span>
      <span className='min-w-0 truncate text-[var(--tm-muted)]' title={note ?? undefined}>
        {note ?? ''}
      </span>
    </li>
  )
}

function CountsLine({ counts }: { counts: Record<string, number> | undefined }) {
  const entries = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1])
  if (!entries.length) return <Empty>No runs in the last 24 hours.</Empty>
  return (
    <p className='text-[12px] tabular-nums text-[var(--tm-fg-2)]'>
      {entries.map(([k, n], i) => (
        <span key={k}>
          {i > 0 ? ' · ' : ''}
          {fmtCount(n)} {k}
        </span>
      ))}
    </p>
  )
}

// ── sources ──────────────────────────────────────────────────────────────────
interface SourceDetail {
  kind: 'cron' | 'flow' | 'import' | 'socket'
  job?: string
  description?: string | null
  expression?: string | null
  next_run?: string | null
  paused?: boolean
  flow?: { id: string; name: string; status: string; trigger: string } | null
  runs?: Array<{
    id: unknown
    status: string
    started_at: string
    duration_ms: number | null
    error?: string | null
    trigger?: string | null
  }>
  last_24h?: Record<string, number>
  active?: Array<{ id: number; import_key: string; status: string; row_count: number | null }>
  recent?: Array<{
    id: number
    import_key: string
    status: string
    row_count: number | null
    duration: number | null
    finished_at: string
  }>
  sockets?: number
  users?: number
  apps?: Array<{ app: string; n: number }>
}

function triggerText(key: string): string {
  if (key.startsWith('trigger:')) return `${key.slice(8)} trigger`
  if (key.startsWith('cron:')) return `job ${key.slice(5)}`
  if (key === 'import:worker') return 'staged import'
  const cut = key.indexOf('/')
  return cut > 0
    ? `${entityLabel(null, key.slice(0, cut), key.slice(cut + 1))} (${key.slice(0, cut)})`
    : key
}

function SourcePanel({ sel }: { sel: Selection }) {
  const id = sel.id
  const { model, win, tick } = useTrafficMap()
  const top = useTop()
  const fig = top?.sources?.sources[id]
  const detail = useQuery({
    queryKey: ['traffic-map', 'source-detail', id],
    queryFn: async () =>
      (await api.get(`/traffic-map/source-detail?id=${encodeURIComponent(id)}`)).data
        .data as SourceDetail,
    staleTime: 15_000,
    refetchInterval: 30_000
  })
  const d = detail.data
  const calls = Object.entries(top?.sources?.sd ?? {})
    .filter(([k]) => k.startsWith(`${id}>`))
    .map(([k, n]) => ({ down: k.slice(id.length + 1), n }))
    .sort((a, b) => b.n - a.n)
  const kind = id.slice(0, id.indexOf(':'))
  void tick
  return (
    <>
      {kind !== 'socket' && (
        <Section title={`Runs in the last ${Math.round(win / 60)} min`}>
          {fig ? (
            <Figures
              items={[
                ['Runs', fmtCount(fig.runs)],
                ['Failed', fmtCount(fig.errors), fig.errors > 0],
                ['p95', fig.p95_ms ? fmtMs(fig.p95_ms) : '—']
              ]}
            />
          ) : (
            <Empty>No run finished in this window on this node.</Empty>
          )}
          {fig?.last && (
            <p className='mt-2 text-[12px] text-[var(--tm-fg-2)]' data-tm-source-last=''>
              Last run {fmtTime(fig.last.at)} · {fmtMs(fig.last.ms)} ·{' '}
              <span
                style={{ color: fig.last.ok ? 'var(--tm-create)' : 'var(--tm-error-ink)' }}
                className='font-medium'
              >
                {fig.last.ok ? 'succeeded' : 'failed'}
              </span>
            </p>
          )}
        </Section>
      )}
      {kind === 'cron' && (
        <Section title='Schedule'>
          {d ? (
            <div className='grid gap-1 text-[12px]'>
              {d.description && <p className='text-[var(--tm-fg-2)]'>{d.description}</p>}
              <p className='tabular-nums'>
                <span className='font-mono text-[11px]'>{d.expression ?? '—'}</span>
                {d.paused ? (
                  <span className='ml-2 font-medium text-[var(--tm-update)]'>paused</span>
                ) : d.next_run ? (
                  <span className='text-[var(--tm-muted)]'> · next {fmtTime(d.next_run)}</span>
                ) : null}
              </p>
              <Link to='/background-jobs' className={cn(LINK, 'w-fit')}>
                Open Background Jobs
              </Link>
            </div>
          ) : (
            <Empty>{detail.isError ? 'Could not load the schedule.' : 'Loading…'}</Empty>
          )}
        </Section>
      )}
      {kind === 'flow' && (
        <Section title='Triggered by'>
          {top?.sources?.triggers[id]?.length ? (
            <div className='grid gap-1.5'>
              {top.sources.triggers[id].map((tr) => (
                <Bar
                  key={tr.key}
                  label={triggerText(tr.key)}
                  n={tr.n}
                  max={top.sources?.triggers[id][0].n ?? 1}
                  mono={false}
                />
              ))}
            </div>
          ) : (
            <Empty>No run in this window.</Empty>
          )}
          {d?.flow && (
            <Link to={`/flows/${d.flow.id}`} className={cn(LINK, 'mt-2 inline-block text-[12px]')}>
              Open the flow ({d.flow.status})
            </Link>
          )}
        </Section>
      )}
      {kind === 'import' && (
        <Section title='Import worker'>
          {top?.sources?.import.current ? (
            <p className='text-[12px] tabular-nums' data-tm-import-current=''>
              Run {top.sources.import.current.run_id} ·{' '}
              <span className='font-mono text-[11px]'>{top.sources.import.current.key}</span>
              {top.sources.import.current.rows != null
                ? ` · ${fmtCount(top.sources.import.current.rows)} rows`
                : ''}
              {top.sources.import.current.rows_per_s != null
                ? ` · ${top.sources.import.current.rows_per_s}/s`
                : ''}
            </p>
          ) : (
            <Empty>Nothing importing right now.</Empty>
          )}
          {d?.active?.length ? (
            <p className='mt-1 text-[12px] text-[var(--tm-fg-2)]'>
              {d.active.filter((a) => a.status === 'queued').length} queued
            </p>
          ) : null}
          <Link to='/imports' className={cn(LINK, 'mt-1 inline-block text-[12px]')}>
            Open the Import Console
          </Link>
        </Section>
      )}
      {kind === 'socket' && (
        <Section title='Connections'>
          {d ? (
            <>
              <Figures
                items={[
                  ['Sockets', fmtCount(d.sockets ?? 0)],
                  ['People', fmtCount(d.users ?? 0)],
                  ['Apps', fmtCount(d.apps?.length ?? 0)]
                ]}
              />
              <div className='mt-2 grid gap-1.5'>
                {(d.apps ?? []).map((a) => (
                  <Bar key={a.app} label={a.app} n={a.n} max={d.apps?.[0]?.n ?? 1} mono={false} />
                ))}
              </div>
            </>
          ) : (
            <Empty>{detail.isError ? 'Could not load the connections.' : 'Loading…'}</Empty>
          )}
          <SocketEvents model={model} win={win} />
        </Section>
      )}
      {(kind === 'cron' || kind === 'flow' || kind === 'import') && (
        <Section title='Recent runs'>
          {d ? (
            <>
              <CountsLine counts={d.last_24h} />
              <ul className='mt-1.5 grid gap-1' data-tm-source-runs=''>
                {(d.runs ?? []).map((r) => (
                  <RunRow
                    key={String(r.id)}
                    status={r.status}
                    at={r.started_at}
                    ms={r.duration_ms}
                    note={r.error ?? r.trigger}
                  />
                ))}
                {(d.recent ?? []).map((r) => (
                  <RunRow
                    key={r.id}
                    status={r.status}
                    at={r.finished_at}
                    ms={r.duration != null ? r.duration * 1000 : null}
                    note={`${r.import_key}${r.row_count != null ? ` · ${fmtCount(r.row_count)} rows` : ''}`}
                  />
                ))}
              </ul>
              {!d.runs?.length && !d.recent?.length && <Empty>No runs recorded yet.</Empty>}
            </>
          ) : (
            <Empty>{detail.isError ? 'Could not load the runs.' : 'Loading…'}</Empty>
          )}
        </Section>
      )}
      {calls.length > 0 && (
        <Section title='Calls into'>
          <div className='grid gap-1.5'>
            {calls.map((c) => (
              <Bar
                key={c.down}
                label={downLabel(model, null, c.down)}
                n={c.n}
                max={calls[0].n}
                mono={false}
              />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

function SocketEvents({
  model,
  win
}: {
  model: ReturnType<typeof useTrafficMap>['model']
  win: number
}) {
  const rows = model
    .entityKeys()
    .filter((k) => k.startsWith('socket/'))
    .map((k) => ({ key: k, n: model.entitySum(k, win)[0] }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
  if (!rows.length) return null
  return (
    <div className='mt-3 grid gap-1.5'>
      <h4 className='text-[11.5px] text-[var(--tm-muted)]'>Events in this window</h4>
      {rows.map((r) => (
        <Bar
          key={r.key}
          label={entityLabel(null, 'socket', r.key.slice(7))}
          n={r.n}
          max={rows[0].n}
        />
      ))}
    </div>
  )
}

register(inspectorPanels, {
  id: 'topology-source',
  order: 5,
  applies: (sel) => sel.kind === 'caller' && sel.id.includes(':') && sel.id !== OTHER_SOURCES,
  Component: SourcePanel
})

register(inspectorPanels, {
  id: 'topology-socket-entity',
  order: 5,
  applies: (sel) => sel.kind === 'entity' && sel.id.startsWith('socket/'),
  Component: () => (
    <Section title='Socket events'>
      <p className='text-[12px] text-[var(--tm-fg-2)]'>
        Inbound socket.io events counted after the handshake — they never reach the request log, so
        the live window is all there is.
      </p>
    </Section>
  )
})

// ── downstream nodes ─────────────────────────────────────────────────────────
function PartnerPanel({ sel }: { sel: Selection }) {
  const top = useTop()
  const p = top?.partners?.downs[sel.id]
  const buckets = top?.partners?.buckets ?? [100, 250, 500, 1000, 2500, 5000, 10000]
  const failures = ERROR_CLASSES.map((c) => [c, p?.classes[c] ?? 0] as [ErrorClass, number]).filter(
    ([, n]) => n > 0
  )
  const hist = p?.hist ?? []
  const histMax = Math.max(1, ...hist)
  const labelOf = (i: number) =>
    i === 0
      ? `< ${fmtMs(buckets[0])}`
      : i >= buckets.length
        ? `≥ ${fmtMs(buckets[buckets.length - 1])}`
        : `${fmtMs(buckets[i - 1])} – ${fmtMs(buckets[i])}`
  return (
    <>
      <Section title='Why calls fail'>
        {failures.length ? (
          <div className='grid gap-1.5' data-tm-error-classes=''>
            {failures.map(([c, n]) => (
              <div key={c} title={CLASS_HINT[c]} data-tm-error-class={c}>
                <Bar
                  label={CLASS_LABEL[c]}
                  n={n}
                  max={failures[0][1]}
                  color={CLASS_VAR[c]}
                  mono={false}
                />
              </div>
            ))}
            <p className='text-[11.5px] text-[var(--tm-muted)]'>
              The edge into this partner takes the colour of its most common class.
            </p>
          </div>
        ) : (
          <Empty>No failed calls in this window.</Empty>
        )}
      </Section>
      <Section title='Latency'>
        {hist.some((n) => n > 0) ? (
          <div className='grid gap-1' data-tm-latency-hist=''>
            {hist.map((n, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed bucket order
                key={i}
                className='grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-2 text-[11.5px]'
              >
                <span className='tabular-nums text-[var(--tm-fg-2)]'>{labelOf(i)}</span>
                <span className='block h-2 overflow-hidden rounded-sm bg-[var(--tm-accent-soft)]'>
                  <i
                    className='block h-full bg-[var(--tm-accent)]'
                    style={{ width: `${(100 * n) / histMax}%` }}
                  />
                </span>
                <span className='w-10 text-right tabular-nums'>{fmtCount(n)}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No calls in this window.</Empty>
        )}
      </Section>
      {sel.id.startsWith('x:') && <DeclaredNode id={sel.id} />}
    </>
  )
}

function useDownDetail<T>(id: string) {
  return useQuery({
    queryKey: ['traffic-map', 'down-detail', id],
    queryFn: async () =>
      (await api.get(`/traffic-map/down-detail?id=${encodeURIComponent(id)}`)).data.data as T,
    staleTime: 30_000
  })
}

function DeclaredNode({ id }: { id: string }) {
  const q = useDownDetail<{
    node: { extension: string; label: string; description: string | null; match: string } | null
  }>(id)
  const n = q.data?.node
  return (
    <Section title='Declared by an extension'>
      {n ? (
        <div className='grid gap-1 text-[12px]'>
          <p>
            <span className='font-mono text-[11px]'>{n.extension}</span>
            <span className='text-[var(--tm-muted)]'> · matches {n.match || 'nothing'}</span>
          </p>
          {n.description && <p className='text-[var(--tm-fg-2)]'>{n.description}</p>}
        </div>
      ) : (
        <Empty>{q.isLoading ? 'Loading…' : 'The extension is not loaded on this node.'}</Empty>
      )}
    </Section>
  )
}

const OUTCOMES = ['sent', 'failed', 'dropped', 'deferred', 'redirected'] as const
const OUTCOME_HINT: Record<string, string> = {
  dropped: 'test mode with no test recipient, or nobody active to send to',
  deferred: 'folded into the daily summary',
  redirected: 'test mode sent it to the test recipient instead'
}

function ChannelPanel({ sel }: { sel: Selection }) {
  const top = useTop()
  const row = top?.channels?.[sel.id]
  const q = useDownDetail<{ test_mode?: boolean }>(sel.id)
  return (
    <Section title='Sends in this window'>
      {row ? (
        <div className='grid gap-1.5' data-tm-channel-outcomes=''>
          {OUTCOMES.filter((o) => (row[o] ?? 0) > 0 || o === 'sent').map((o) => (
            <div key={o} title={OUTCOME_HINT[o]}>
              <Bar
                label={o}
                n={row[o] ?? 0}
                max={Math.max(1, ...OUTCOMES.map((x) => row[x] ?? 0))}
                color={o === 'failed' ? 'var(--tm-error)' : undefined}
                mono={false}
              />
            </div>
          ))}
        </div>
      ) : (
        <Empty>Nothing sent in this window.</Empty>
      )}
      {q.data?.test_mode && (
        <p className='mt-2 text-[12px] text-[var(--tm-fg-2)]' data-tm-channel-test=''>
          Test mode is on: sends outside the allowlist go to the test recipient.
        </p>
      )}
    </Section>
  )
}

function AiPanel({ sel }: { sel: Selection }) {
  const top = useTop()
  const p = top?.ai?.providers[sel.id]
  const fallbacks = top?.ai?.fallbacks ?? []
  return (
    <>
      <Section title='Calls in this window'>
        {p ? (
          <Figures
            items={[
              ['Calls', fmtCount(p.calls ?? 0)],
              ['Failed', fmtCount(p.errors ?? 0), (p.errors ?? 0) > 0],
              ['Cost', p.cost != null ? `$${p.cost.toFixed(p.cost < 1 ? 3 : 2)}` : '—'],
              ['Tokens in', fmtCount(p.in ?? 0)],
              ['Cached', fmtCount(p.cached ?? 0)],
              ['Tokens out', fmtCount(p.out ?? 0)]
            ]}
          />
        ) : (
          <Empty>No AI calls in this window.</Empty>
        )}
      </Section>
      {p?.models?.length ? (
        <Section title='Models answering'>
          <div className='grid gap-1.5'>
            {p.models.map((m) => (
              <Bar key={m.model} label={m.model} n={m.n} max={p.models?.[0]?.n ?? 1} />
            ))}
          </div>
        </Section>
      ) : null}
      <Section title='Model fallbacks'>
        {fallbacks.length ? (
          <ul className='grid gap-1 text-[12px]' data-tm-ai-fallbacks=''>
            {fallbacks.map((f) => (
              <li key={`${f.from}>${f.to}`} className='min-w-0 truncate'>
                <span className='font-mono text-[11px]'>{f.from}</span>
                <span className='text-[var(--tm-muted)]'> refused → </span>
                <span className='font-mono text-[11px]'>{f.to}</span>
                <span className='tabular-nums text-[var(--tm-fg-2)]'> ×{f.n}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            No model refused in this window
            {top?.ai?.fallbacks_since_boot ? ` (${top.ai.fallbacks_since_boot} since boot)` : ''}.
          </Empty>
        )}
        <Link to='/ai-analytics' className={cn(LINK, 'mt-2 inline-block text-[12px]')}>
          Open AI analytics
        </Link>
      </Section>
    </>
  )
}

function WebhookPanel({ sel }: { sel: Selection }) {
  const top = useTop()
  const w = top?.webhooks?.webhooks[sel.id]
  const q = useDownDetail<{
    found?: boolean
    id?: number
    name?: string | null
    host?: string | null
    enabled?: boolean
    events?: string | null
    recent_failures?: Array<{
      status_code: number | null
      latency_ms: number
      event: string
      created_at: string
    }>
  }>(sel.id)
  const codes = Object.entries(w?.codes ?? {}).sort((a, b) => b[1] - a[1])
  return (
    <>
      <Section title='Deliveries in this window'>
        {w ? (
          <>
            <Figures
              items={[
                ['Failed', fmtCount(w.failed), w.failed > 0],
                ['Slow', fmtCount(w.slow), w.slow > 0],
                ['Codes', fmtCount(codes.length)]
              ]}
            />
            <p className='mt-2 text-[11.5px] text-[var(--tm-muted)]'>
              Slow = over {fmtMs(top?.webhooks?.slow_ms ?? 5000)}.{' '}
              {codes.map(([c, n]) => `${c} ×${n}`).join(' · ')}
            </p>
          </>
        ) : (
          <Empty>No deliveries in this window.</Empty>
        )}
      </Section>
      <Section title='Receiver'>
        {q.data?.found ? (
          <div className='grid gap-1 text-[12px]'>
            <p>
              {q.data.name ?? `Webhook ${q.data.id}`}
              <span className='text-[var(--tm-muted)]'>
                {' '}
                · {q.data.host ?? 'unknown host'}
                {q.data.enabled === false ? ' · disabled' : ''}
              </span>
            </p>
            {q.data.recent_failures?.length ? (
              <ul className='grid gap-1'>
                {q.data.recent_failures.map((f, i) => (
                  <RunRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: failures can share a timestamp
                    key={i}
                    status={String(f.status_code ?? 'network')}
                    at={f.created_at}
                    ms={f.latency_ms}
                    note={f.event}
                  />
                ))}
              </ul>
            ) : null}
            <Link to={`/webhooks/${q.data.id}`} className={cn(LINK, 'w-fit')}>
              Open the webhook
            </Link>
          </div>
        ) : (
          <Empty>{q.isLoading ? 'Loading…' : 'This webhook no longer exists.'}</Empty>
        )}
      </Section>
    </>
  )
}

function RedisPanel() {
  const top = useTop()
  const r = top?.redis
  return (
    <Section title='Commands'>
      {r ? (
        <>
          <Figures
            items={[
              ['Commands/s', String(r.cps)],
              ['In window', fmtCount(r.commands)],
              ['Families', fmtCount(r.families.length)]
            ]}
          />
          <div className='mt-2.5 grid gap-1.5' data-tm-redis-families=''>
            {r.families.slice(0, 10).map((f) => (
              <Bar
                key={f.family}
                label={f.family}
                n={f.n}
                max={r.families[0]?.n ?? 1}
                mono={false}
              />
            ))}
          </div>
          <p className='mt-2 text-[11.5px] text-[var(--tm-muted)]'>
            Top commands: {r.top_commands.map((c) => `${c.name} ${fmtCount(c.n)}`).join(' · ')}
          </p>
        </>
      ) : (
        <Empty>No commands counted in this window.</Empty>
      )}
    </Section>
  )
}

function PoolPanel() {
  const top = useTop()
  const p = top?.pool
  const tone =
    p?.level === 'error'
      ? 'var(--tm-error-ink)'
      : p?.level === 'warn'
        ? 'var(--tm-update)'
        : undefined
  return (
    <Section title='Connection pool · last 5 min'>
      {p ? (
        <div data-tm-pool={p.level}>
          <Figures
            items={[
              ['p95 wait', fmtMs(p.wait_p95_ms), p.level === 'error'],
              ['All busy', `${p.saturated_pct}%`, p.level === 'error'],
              ['Peak in use', `${p.peak_used}/${p.max}`]
            ]}
          />
          <p className='mt-2 text-[12px] text-[var(--tm-fg-2)]'>
            {fmtCount(p.acquires)} checkouts · peak {fmtCount(p.peak_pending)} waiting
            {p.level !== 'ok' && (
              <span className='font-medium' style={{ color: tone }}>
                {' '}
                · {p.level === 'error' ? 'under heavy pressure' : 'under pressure'}
              </span>
            )}
          </p>
          <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
            Amber at the pool monitor's line (p95 wait 500 ms or all busy 25%), red at twice it.
          </p>
        </div>
      ) : (
        <Empty>No pool figures on this node yet.</Empty>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'topology-down',
  order: 5,
  applies: (sel) => sel.kind === 'down',
  Component: function DownPanel({ sel }) {
    const { model } = useTrafficMap()
    if (sel.id === 'db') return <PoolPanel />
    if (sel.id === 'redis') return <RedisPanel />
    if (isPartnerDown(sel.id)) return <PartnerPanel sel={sel} />
    const kind = downKindOf(model, sel.id)
    if (kind === 'channel') return <ChannelPanel sel={sel} />
    if (kind === 'ai') return <AiPanel sel={sel} />
    if (kind === 'webhook') return <WebhookPanel sel={sel} />
    return null
  }
})
