/**
 * #1155 — fire a probe: one safe read (a GET) at the entity, sent by the server as the admin who
 * clicked, so it shows up on the map end to end — a live smoke check.
 */
import { useMutation } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@/lib/api'
import { fmtMs } from '../EventTicker'
import type { InspectorData } from '../Inspector'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { BTN, entityOf, errorOf, Note } from './shared'

/** Lanes the server knows a safe GET for (mirrors probePath on the server). */
export function probeable(sel: Selection): boolean {
  const e = entityOf(sel)
  if (!e || e.entity.startsWith('__')) return false
  if (e.lane === 'items')
    return /^[a-z0-9_]{1,128}$/.test(e.entity) && !/^(nivaro_|directus_|sys)/.test(e.entity)
  if (e.lane === 'system') return /^(nivaro_|directus_|sys)[a-z0-9_]{0,124}$/.test(e.entity)
  if (e.lane === 'pages') return /^[a-z0-9][a-z0-9_-]{0,119}$/.test(e.entity)
  return false
}

function Probe({ sel }: { sel: Selection; d: InspectorData }) {
  const e = entityOf(sel)
  const m = useMutation({
    mutationFn: async () => {
      const res = await api.get('/traffic-map/probe', { params: { key: e?.key } })
      return (res?.data as { data?: { path: string; status: number; ms: number } })?.data ?? null
    }
  })
  const selKey = sel.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: a result belongs to the node probed
  useEffect(() => {
    m.reset()
  }, [selKey])
  const r = m.data
  return (
    <>
      <button
        type='button'
        className={BTN}
        id='tm-probe'
        disabled={m.isPending}
        title='Send one safe read at this entity and watch it light up'
        onClick={() => m.mutate()}
      >
        {m.isPending ? 'Probing…' : 'Probe'}
      </button>
      {m.isError && <Note tone='error'>Probe failed: {errorOf(m.error)}</Note>}
      {r && (
        <Note tone={r.status >= 400 ? 'error' : 'ok'}>
          <span data-tm-probe-result={r.status}>
            GET <span className='font-mono'>{r.path}</span> answered {r.status} in {fmtMs(r.ms)}
          </span>
        </Note>
      )}
    </>
  )
}

register(inspectorActions, {
  id: 'probe',
  order: 30,
  applies: (sel) => probeable(sel),
  Component: Probe
})
