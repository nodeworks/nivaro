/**
 * #1177 — GraphQL resolver time per nested field. Field heat (#1134) counts which fields an
 * operation selects; this times each nested resolver (to-one, to-many, many-to-many, polymorphic
 * links, and the access gate each compiles) per field path, so a slow expansion is named. The
 * server only times resolvers while someone watches the map, so a fresh page fills in as traffic
 * arrives.
 */
import { useTrafficMap } from '../../context'
import { fmtMs } from '../../EventTicker'
import { Bar, Empty, Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { entityOf, useEntityDetail } from '../shared'

interface ResolverDetail {
  window_s: number
  timing: boolean
  paths: Array<{
    path: string
    kind: 'm2o' | 'o2m' | 'm2m' | 'm2a' | 'gate'
    calls: number
    total_ms: number
    avg_ms: number
    max_ms: number
  }>
}

const KIND_LABEL: Record<ResolverDetail['paths'][number]['kind'], string> = {
  m2o: 'to-one',
  o2m: 'to-many',
  m2m: 'many-to-many',
  m2a: 'linked records',
  gate: 'access check'
}

/** Resolver times are often sub-millisecond (an access check already compiled). */
export function msText(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0 ms'
  return v < 1 ? '<1 ms' : fmtMs(v)
}

/** `gate:workflows` → "access check on workflows"; anything else as written. */
export function resolverLabel(path: string): string {
  return path.startsWith('gate:') ? `access check on ${path.slice(5)}` : path
}

function ResolverPanel({ sel }: { sel: Selection }) {
  const { win } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<ResolverDetail>(
    e?.key ?? null,
    'graphql-resolvers',
    win
  )
  const paths = data?.paths ?? []
  const max = paths.reduce((a, p) => Math.max(a, p.total_ms), 0)
  return (
    <Section title='Nested resolver time'>
      {loading ? (
        <Empty>Reading resolver times…</Empty>
      ) : paths.length === 0 ? (
        <Empty>
          No nested field resolved in this operation since resolver timing started — it runs only
          while the map is open.
        </Empty>
      ) : (
        <div className='grid gap-2' data-tm-graphql-resolvers=''>
          {paths.slice(0, 12).map((p) => (
            <div key={p.path} data-tm-resolver={p.path} title={KIND_LABEL[p.kind]}>
              <Bar label={resolverLabel(p.path)} n={p.total_ms} max={max} />
              <span className='mt-0.5 block text-[11.5px] tabular-nums text-[var(--tm-muted)]'>
                {KIND_LABEL[p.kind]} · {p.calls.toLocaleString()} call{p.calls === 1 ? '' : 's'} ·{' '}
                {msText(p.avg_ms)} avg · {msText(p.max_ms)} worst
              </span>
            </div>
          ))}
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Milliseconds summed over every row a list resolved, so a field resolved per row can add
            up past the request's own time.
          </p>
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'graphql-resolvers',
  order: 46,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && e.lane === 'graphql' && !e.entity.startsWith('__')
  },
  Component: ResolverPanel
})
