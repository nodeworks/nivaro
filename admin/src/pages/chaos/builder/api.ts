import { api } from '@/lib/api'
import type { ArmedFault, ChaosRun, FaultTarget, HypothesisRule } from '../api'
import type { ParamValue } from './model'

/**
 * Client for the builder (#2844) and presets (#2855): presets CRUD, run-from-preset, the sampler
 * list (#2828, optional) and the Traffic Map blast radius (#2841, optional). Optional sources
 * answer null when the server does not have them, so the builder degrades instead of erroring.
 * The environment caps (#2862) come from GET /chaos/operator (ops-api.ts `fetchOperator`), which
 * every chaos operator may read — GET /chaos/settings is administrators only.
 */

export interface PresetSpec {
  fault_key: string
  target?: FaultTarget
  params?: Record<string, ParamValue>
  seconds?: number
  hypothesis?: HypothesisRule[]
  /** Samples in a row past tolerance before the run aborts (1–10, default 3). */
  abort_after?: number
  note?: string | null
}

export interface ChaosPreset {
  id: string | null
  key: string
  label: string
  description: string | null
  proves: string | null
  claim_keys: string[]
  spec: PresetSpec
  source: 'shipped' | 'saved'
  overrides_shipped: boolean
  created_by: string | null
  updated_at: string | null
  fault: { installed: boolean; label: string; danger: 'low' | 'medium' | 'high' | null }
}

export interface PresetInput {
  key?: string
  label?: string
  description?: string | null
  proves?: string | null
  claim_keys?: string[]
  spec?: PresetSpec
}

export const builderKeys = {
  presets: ['chaos', 'presets'] as const,
  preset: (key: string) => ['chaos', 'presets', key] as const,
  samplers: ['chaos', 'samplers'] as const,
  blast: (node: string) => ['chaos', 'blast', node] as const,
  routes: ['chaos', 'route-choices'] as const,
  tables: ['chaos', 'table-choices'] as const
}

export const fetchPresets = () =>
  api
    .get('/chaos/presets')
    .then((r) => r.data.data as { store: 'db' | 'redis' | 'memory'; presets: ChaosPreset[] })

export const fetchPreset = (key: string) =>
  api.get(`/chaos/presets/${encodeURIComponent(key)}`).then((r) => r.data.data as ChaosPreset)

export const createPreset = (body: PresetInput) =>
  api.post('/chaos/presets', body).then((r) => r.data.data as ChaosPreset)

export const updatePreset = (key: string, body: PresetInput) =>
  api
    .patch(`/chaos/presets/${encodeURIComponent(key)}`, body)
    .then((r) => r.data.data as ChaosPreset)

export const deletePreset = (key: string) =>
  api
    .delete(`/chaos/presets/${encodeURIComponent(key)}`)
    .then((r) => r.data.data as { deleted: boolean; restored: boolean })

export const runPreset = (key: string, body: Record<string, unknown>) =>
  api
    .post(`/chaos/presets/${encodeURIComponent(key)}/run`, body)
    .then((r) => r.data.data as { run: ChaosRun; fault: ArmedFault })

const status = (e: unknown) => (e as { response?: { status?: number } })?.response?.status

/** An optional source: 404/405/501 = not on this server → null. */
async function optional<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (e) {
    const s = status(e)
    if (s === 404 || s === 405 || s === 501) return null
    throw e
  }
}

/** Samplers the hypothesis can name (#2828) when the server lists them. */
export const fetchSamplers = () =>
  optional(() =>
    api
      .get('/chaos/samplers')
      .then((r) => r.data.data as Array<{ key: string; label: string; unit: string }>)
  )

export interface BlastEstimate {
  label: string
  window: string
  routes: Array<{ route: string; per_min: number; strength: 'direct' | 'indirect'; why: string }>
  jobs: Array<{ id: string; strength: string; why: string }>
  claims: {
    fails: Array<{ text: string }>
    degrades: Array<{ text: string }>
    keeps: Array<{ text: string }>
  }
  totals: {
    routes: number
    per_min: number
    share_of_calls: number | null
    screens: number
    jobs: number
    channels: number
  }
  notes: string[]
}

/**
 * The simulate-down estimate for a dependency node (#2841, window form). A server without it
 * answers 400 for a dependency node, or the older shape — both read as "no estimate" (null).
 */
export async function fetchBlast(node: string): Promise<BlastEstimate | null> {
  try {
    const r = await api.get('/traffic-map/blast-radius', { params: { node, window: '24h' } })
    const d = r.data.data as Partial<BlastEstimate>
    if (!d?.totals || !Array.isArray(d.routes) || !d.claims) return null
    return d as BlastEstimate
  } catch (e) {
    const s = status(e)
    if (s === 400 || s === 404) return null
    throw e
  }
}

/** Route patterns seen on the Traffic Map in the last 15 minutes, busiest first. */
export async function fetchRouteChoices(): Promise<Array<{ template: string; n: number }>> {
  const r = await api.get('/traffic-map/snapshot', { params: { window: 900 } })
  const ents = (r.data.data?.entities ?? []) as Array<{
    routes?: Array<{ route: string; n: number }>
  }>
  const by = new Map<string, number>()
  for (const e of ents)
    for (const rt of e.routes ?? []) by.set(rt.route, (by.get(rt.route) ?? 0) + (rt.n || 0))
  return [...by.entries()]
    .map(([template, n]) => ({ template, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 300)
}

export const fetchTableChoices = () =>
  api
    .get('/collections')
    .then((r) => ((r.data.data ?? []) as Array<{ collection: string }>).map((c) => c.collection))
