/**
 * #1200 — the definitions behind two kinds of map node: a saved custom query (SQL, parameters,
 * cache settings and live cache stats, freshness sources, the last slow plan, who uses it) and
 * a record widget (type, config summary, bound query, recent render errors).
 */
import { useMemo, useState } from 'react'
import { PlanViewer } from '@/components/plan-viewer'
import { fmtCount, fmtMs, fmtTime } from '../../EventTicker'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { BTN, SafeLink } from '../shared'
import {
  Block,
  Facts,
  Figure,
  Figures,
  Muted,
  PanelError,
  PanelLoading,
  type RequestLine,
  RequestList,
  Spark,
  useCatalog,
  useMapLive
} from './parts'

interface CacheRow {
  hits: number
  misses: number
  bypasses: number
  uncached_runs: number
  runs: number
  hit_rate: number | null
  avg_exec_ms: number | null
  last_run_at: string | null
  advice: string | null
}

interface QueryDetail {
  id: number
  slug: string
  name: string
  description: string | null
  sql_text: string
  params: Array<{ name?: string; type?: string; required?: boolean; default_value?: unknown }>
  cache_ttl: number
  enabled: boolean
  access: string | null
  warm_daily: boolean
  updated_at: string | null
  entity: string
  cache: { since: string; row: CacheRow | null; last_error: { at: string; message: string } | null }
  freshness:
    | {
        ok: true
        data_changed_at: string | null
        sources: Array<{ table: string; column: string; changed_at: string | null }>
      }
    | { ok: false }
  plan: {
    captured_at: string
    duration_ms: number
    params: Record<string, unknown>
    plan_xml: string
    missing_indexes: string[]
  } | null
  dependents: Array<{ surface: string; id: unknown; name: string; detail: string | null }> | null
  recent_errors: RequestLine[]
}

/** The entity's live spark from the map's ring (queries/<slug>, widgets/<id>). */
function LiveSpark({ entityKey }: { entityKey: string }) {
  const live = useMapLive()
  const tick = live?.tick
  const series = useMemo(() => {
    void tick
    return live ? live.model.entitySeries(entityKey, live.win, 40) : []
  }, [live, entityKey, tick])
  return <Spark data={series} caption='Live calls, from the map (this API process)' />
}

function CacheFacts({ row, ttl }: { row: CacheRow | null; ttl: number }) {
  if (!row)
    return (
      <Muted hook='cache-none'>
        Not run on this API process since it started{ttl ? '' : ' — and it is not cached'}.
      </Muted>
    )
  return (
    <Figures>
      <Figure label='Runs' value={fmtCount(row.runs)} />
      <Figure
        label='Hit rate'
        value={row.hit_rate == null ? '—' : `${Math.round(row.hit_rate * 100)}%`}
      />
      <Figure label='Avg run' value={fmtMs(row.avg_exec_ms ?? 0)} />
    </Figures>
  )
}

export function QueryPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const cat = useCatalog()
  const [showSql, setShowSql] = useState(true)
  const q = useInspectDetail<QueryDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelLoading />
  if (q.isError || !q.data) return <PanelError error={q.error} what='custom query' />
  const d = q.data
  const row = d.cache.row
  return (
    <div className='grid min-w-0 gap-3.5' data-tm-inspect-query={d.slug}>
      <div className='grid gap-1'>
        <p className='text-[14px] font-semibold text-[var(--tm-fg)]'>{d.name}</p>
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          <span className='font-mono text-[11px]'>{d.slug}</span>
          {d.enabled ? '' : ' · disabled'}
          {d.access ? ` · ${d.access}` : ''}
        </p>
        {d.description && <Muted>{d.description}</Muted>}
        <div className='flex flex-wrap items-center gap-3 text-[12px]'>
          <InspectLink inspectRef={{ kind: 'entity', id: d.entity, label: d.name }}>
            <span data-tm-inspect-query-entity=''>Traffic for this query</span>
          </InspectLink>
          <SafeLink
            to={`/custom-queries/${d.id}`}
            className='text-[var(--tm-muted)] hover:underline'
          >
            Open full page
          </SafeLink>
        </div>
      </div>

      <LiveSpark entityKey={d.entity} />

      <Block
        title='SQL'
        hook='sql'
        aside={
          <button type='button' className='hover:underline' onClick={() => setShowSql((v) => !v)}>
            {showSql ? 'Hide' : 'Show'}
          </button>
        }
      >
        {showSql && (
          <pre
            className='max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] p-2 font-mono text-[11px] leading-snug text-[var(--tm-fg)]'
            data-tm-inspect-query-sql=''
          >
            {d.sql_text || '—'}
          </pre>
        )}
        {d.params.length > 0 && (
          <Facts
            rows={d.params.map(
              (p) =>
                [
                  `:${p.name ?? '?'}`,
                  `${p.type ?? 'string'}${p.required ? ' · required' : ''}${
                    p.default_value != null && p.default_value !== ''
                      ? ` · default ${String(p.default_value)}`
                      : ''
                  }`
                ] as [string, string]
            )}
          />
        )}
      </Block>

      <Block
        title='Cache'
        hook='cache'
        aside={d.cache_ttl ? `cached ${d.cache_ttl}s` : 'not cached'}
      >
        <CacheFacts row={row} ttl={d.cache_ttl} />
        {row?.advice && <Muted hook='cache-advice'>{row.advice}</Muted>}
        {d.cache.last_error && (
          <p className='text-[12px] text-[var(--tm-error-ink)]' data-tm-inspect-query-last-error=''>
            Last failed at {fmtTime(d.cache.last_error.at)}: {d.cache.last_error.message}
          </p>
        )}
        <Muted>Counted on this API process since {new Date(d.cache.since).toLocaleString()}.</Muted>
      </Block>

      <Block title='Freshness' hook='freshness'>
        {d.freshness.ok ? (
          d.freshness.sources.length ? (
            <Facts
              rows={d.freshness.sources.map(
                (s) =>
                  [
                    `${s.table}.${s.column}`,
                    s.changed_at
                      ? `changed ${new Date(s.changed_at).toLocaleString()}`
                      : 'never written'
                  ] as [string, string]
              )}
            />
          ) : (
            <Muted>
              No source tables could be found in its SQL, so freshness cannot be judged.
            </Muted>
          )
        ) : (
          <Muted>Freshness could not be read right now.</Muted>
        )}
      </Block>

      <Block title='Last slow plan' hook='plan'>
        {d.plan ? (
          <div className='grid gap-1.5' data-tm-inspect-query-plan=''>
            <Muted>
              Captured {new Date(d.plan.captured_at).toLocaleString()} after a{' '}
              {fmtMs(d.plan.duration_ms)} run.
            </Muted>
            <PlanViewer xml={d.plan.plan_xml} />
          </div>
        ) : (
          <Muted hook='plan-none'>
            No slow run captured on this API process — a plan is kept only for runs slower than the
            capture threshold, and only in memory until the process restarts.
          </Muted>
        )}
      </Block>

      <Block title='Used by' hook='dependents'>
        {d.dependents == null ? (
          <Muted>Who uses this query could not be read right now.</Muted>
        ) : d.dependents.length ? (
          <ul className='grid gap-0.5 text-[12px]'>
            {d.dependents.map((x) => (
              <li key={`${x.surface}:${String(x.id)}`} data-tm-inspect-query-dependent={x.surface}>
                {x.surface === 'Record widgets' && /^\d+$/.test(String(x.id)) ? (
                  <InspectLink inspectRef={{ kind: 'widget', id: String(x.id), label: x.name }}>
                    {x.name}
                  </InspectLink>
                ) : x.surface === 'Other custom queries' && x.detail ? (
                  <InspectLink inspectRef={{ kind: 'query', id: x.detail, label: x.name }}>
                    {x.name}
                  </InspectLink>
                ) : (
                  <span>{x.name}</span>
                )}{' '}
                <span className='text-[var(--tm-muted)]'>· {x.surface}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Muted>Nothing saved refers to this query.</Muted>
        )}
      </Block>

      <Block title='Recent failed runs' hook='recent-errors'>
        <RequestList
          rows={d.recent_errors}
          showCaller
          cat={cat}
          empty='No failed run of this query in the window (or older than the API log keeps — 14 days).'
        />
      </Block>
    </div>
  )
}

interface WidgetDetail {
  id: number
  name: string
  description: string | null
  type: string
  active: boolean
  inputs: unknown
  config_lines: Array<{ label: string; value: string }>
  config_raw: string
  query:
    | {
        id: number
        slug: string
        name: string
        cache_ttl: number
        cache: CacheRow | null
        missing?: false
      }
    | { id: number; missing: true }
    | null
  entity: string
  recent_errors: RequestLine[]
}

export function WidgetPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const cat = useCatalog()
  const [raw, setRaw] = useState(false)
  const q = useInspectDetail<WidgetDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelLoading />
  if (q.isError || !q.data) return <PanelError error={q.error} what='widget' />
  const d = q.data
  const query = d.query
  return (
    <div className='grid min-w-0 gap-3.5' data-tm-inspect-widget={d.id}>
      <div className='grid gap-1'>
        <p className='text-[14px] font-semibold text-[var(--tm-fg)]'>{d.name}</p>
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          {d.type || 'widget'} · #{d.id}
          {d.active ? '' : ' · inactive'}
        </p>
        {d.description && <Muted>{d.description}</Muted>}
        <div className='flex flex-wrap items-center gap-3 text-[12px]'>
          <InspectLink inspectRef={{ kind: 'entity', id: d.entity, label: d.name }}>
            <span data-tm-inspect-widget-entity=''>Traffic for this widget</span>
          </InspectLink>
          <SafeLink to='/record-widgets' className='text-[var(--tm-muted)] hover:underline'>
            Open full page
          </SafeLink>
        </div>
      </div>

      <LiveSpark entityKey={d.entity} />

      <Block title='Definition' hook='definition'>
        <Facts rows={d.config_lines.map((l) => [l.label, l.value] as [string, string])} />
        {!d.config_lines.length && <Muted>No settings beyond its type.</Muted>}
        {d.config_raw && (
          <button
            type='button'
            className={BTN}
            onClick={() => setRaw((v) => !v)}
            data-tm-inspect-widget-raw=''
          >
            {raw ? 'Hide the raw config' : 'Show the raw config'}
          </button>
        )}
        {raw && (
          <pre className='max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] p-2 font-mono text-[11px] text-[var(--tm-fg)]'>
            {d.config_raw}
          </pre>
        )}
      </Block>

      <Block title='Bound query' hook='query'>
        {query == null ? (
          <Muted>This widget runs no saved custom query.</Muted>
        ) : query.missing ? (
          <Muted>It points at custom query #{query.id}, which no longer exists.</Muted>
        ) : (
          <div className='grid gap-1.5'>
            <InspectLink inspectRef={{ kind: 'query', id: query.slug, label: query.name }}>
              <span data-tm-inspect-widget-query={query.slug}>{query.name}</span>
            </InspectLink>
            <CacheFacts row={query.cache} ttl={query.cache_ttl} />
          </div>
        )}
      </Block>

      <Block title='Recent render errors' hook='recent-errors'>
        <RequestList
          rows={d.recent_errors}
          showCaller
          cat={cat}
          empty='No failed render in the window (or older than the API log keeps — 14 days).'
        />
      </Block>
    </div>
  )
}
