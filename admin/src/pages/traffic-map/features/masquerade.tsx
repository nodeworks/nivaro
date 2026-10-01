import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { callerLabel, fmtCount } from '../EventTicker'
import { Section } from '../Inspector'
import type { TrafficModel } from '../model'
import { canvasLayers } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { ago, inEdgeEnds, inPage, snapExt, strokeEdge, useEntityDetail, useLens } from './b1-shared'

/**
 * #1138 — masquerade and View-as traffic. Requests an admin makes while acting as someone (or
 * simulating an API key) count as that person or key; this marks them so they never read as the
 * person's own traffic: their caller → lane edges are drawn dashed, ticker events carry a
 * `masquerade` tag, and the inspector says who was acting ("Rob Lee as Beth Smith").
 */
export const MASQUERADE_TAP = 'masquerade'

export interface MasqSession {
  admin: string
  caller: string
  auth: string
  n: number
  last_at: string
}

const seen = new WeakMap<TrafficModel, { frame: number; edges: Map<string, number> }>()
/** Caller → lane edges that carried masquerade traffic in the last minute. */
export function masqueradeEdges(m: TrafficModel): string[] {
  let h = seen.get(m)
  if (!h) {
    h = { frame: -1, edges: new Map() }
    seen.set(m, h)
    for (const [k, n] of Object.entries(
      snapExt<{ edges: Record<string, number> }>(m, MASQUERADE_TAP)?.edges ?? {}
    ))
      if (n > 0) h.edges.set(k, m.now)
  }
  for (const entry of m.frameExtLog ?? []) {
    if (entry.seq <= h.frame) continue
    h.frame = entry.seq
    const f = entry.ext[MASQUERADE_TAP] as { edges?: Record<string, number> } | undefined
    for (const [k, n] of Object.entries(f?.edges ?? {})) if (n > 0) h.edges.set(k, entry.sec)
  }
  const out: string[] = []
  for (const [k, sec] of h.edges) {
    if (m.now - sec <= 60) out.push(k)
    else h.edges.delete(k)
  }
  return out
}

/** Display names for the admins in `sessions` (catalog first, else /traffic-map/people). */
function useAdminNames(sessions: MasqSession[]): (key: string) => string {
  const { catalog } = useTrafficMap()
  const missing = [...new Set(sessions.map((s) => s.admin))].filter((k) => !catalog?.callers[k])
  const q = useQuery({
    queryKey: ['traffic-map', 'people', missing.sort().join(',')],
    queryFn: async () => {
      const res = await api.get(`/traffic-map/people?ids=${encodeURIComponent(missing.join(','))}`)
      return (res.data.data ?? {}) as Record<string, string>
    },
    enabled: missing.length > 0,
    staleTime: 300_000
  })
  return (key) => catalog?.callers[key]?.label ?? q.data?.[key] ?? 'An admin'
}

function SessionLines({ sessions }: { sessions: MasqSession[] }) {
  const { catalog } = useTrafficMap()
  const admin = useAdminNames(sessions)
  return (
    <div className='grid gap-1 text-[12px]' id='tm-masquerade'>
      {sessions.map((s) => (
        <div
          key={`${s.admin}>${s.caller}`}
          className='grid gap-0.5'
          data-tm-masq={`${s.admin}>${s.caller}`}
        >
          <span className='min-w-0 truncate'>
            <span className='font-semibold'>{admin(s.admin)}</span>
            <span className='text-[var(--tm-muted)]'> as </span>
            <span className='font-semibold'>{callerLabel(catalog, s.caller)}</span>
          </span>
          <span className='text-[11.5px] tabular-nums text-[var(--tm-fg-2)]'>
            {fmtCount(s.n)} requests · {s.auth === 'key_sim' ? 'simulating the key' : 'masquerade'}{' '}
            · last {ago(s.last_at)}
          </span>
        </div>
      ))}
      <p className='text-[11.5px] text-[var(--tm-muted)]'>
        Counted under the person or key acted as; their edges are dashed on the map.
      </p>
    </div>
  )
}

function CallerMasq({ sel }: { sel: Selection }) {
  const { data } = useLens<{ sessions: MasqSession[] }>(MASQUERADE_TAP)
  const sessions = (data?.sessions ?? []).filter((s) => s.caller === sel.id || s.admin === sel.id)
  if (!sessions.length) return null
  return (
    <Section title='Acting as someone'>
      <SessionLines sessions={sessions} />
    </Section>
  )
}
function EntityMasq({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const detail = useEntityDetail(sel.id)
  const d = (detail?.[MASQUERADE_TAP] ?? model.entityMeta(sel.id)?.ext?.[MASQUERADE_TAP]) as
    | { n: number; sessions: MasqSession[] }
    | undefined
  if (!d?.sessions?.length) return null
  return (
    <Section title='Acting as someone'>
      <SessionLines sessions={d.sessions} />
    </Section>
  )
}

register(canvasLayers, {
  id: 'masquerade',
  order: 40,
  draw(ctx, { layout, tokens, model }) {
    const edges = masqueradeEdges(model)
    if (!edges.length) return
    ctx.setLineDash([2, 4])
    ctx.lineCap = 'round'
    ctx.lineWidth = 2.5
    ctx.strokeStyle = tokens.update
    for (const k of edges) {
      const i = k.lastIndexOf('>')
      const ends = inEdgeEnds(layout, k.slice(0, i), k.slice(i + 1))
      if (ends) strokeEdge(ctx, ends.a, ends.b)
    }
  }
})
register(inspectorPanels, {
  id: 'masquerade-caller',
  order: 12,
  applies: (sel) => sel.kind === 'caller',
  Component: inPage(CallerMasq)
})
register(inspectorPanels, {
  id: 'masquerade-entity',
  order: 12,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(EntityMasq)
})
