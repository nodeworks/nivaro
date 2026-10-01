// api/src/services/traffic-taps/tenant-load.ts
/**
 * Traffic Map tap `tenant-load` (#1185) — one small set of counters per store: requests, errors,
 * database wall time (request-trace's sqlMs) and summed latency. In cloud mode a store is a
 * tenant, so ranking the stores ranks the tenants ("who is the noisy neighbour on this API
 * process?"). Self-hosted there is one store and nothing to rank. Memory only.
 *
 * The ranking is read by the cloud OPERATOR route (routes/admin/traffic-tenants.ts), never by a
 * tenant: each tenant's own map stays scoped to its store.
 */
import { requestMeasure } from '../request-trace.js'
import { trafficStoreIds } from '../traffic-map.js'
import { registerTrafficTap, type TrafficTap, tapState, withTrafficStore } from '../traffic-taps.js'
import { MinuteSlots } from './minute-slots.js'

export const TENANT_LOAD_TAP = 'tenant-load'
const S = { req: 0, err: 1, db: 2, lat: 3, queries: 4 } as const

interface State {
  slots: MinuteSlots
}
const state = () => tapState<State>(TENANT_LOAD_TAP, () => ({ slots: new MinuteSlots(5) }))

export interface TenantLoadRow {
  /** The store id (`t:<tenantId>` in cloud mode, `default` self-hosted). */
  store: string
  /** Tenant id read off the store id; null for the self-hosted store. */
  tenant_id: string | null
  requests: number
  errors: number
  error_pct: number
  rps: number
  db_ms: number
  /** Share of all database time on this process over the window (0–100). */
  db_share_pct: number
  avg_ms: number | null
  queries: number
}

/** Rank `rows` (pure): database time first, then requests, then errors. */
export function rankTenantRows(rows: TenantLoadRow[]): TenantLoadRow[] {
  const total = rows.reduce((a, r) => a + r.db_ms, 0)
  for (const r of rows) r.db_share_pct = total > 0 ? Math.round((1000 * r.db_ms) / total) / 10 : 0
  return rows.sort((a, b) => b.db_ms - a.db_ms || b.requests - a.requests || b.errors - a.errors)
}

/** Every store's load over the window, ranked. */
export function tenantLoadRanking(windowS: number, sec: number): TenantLoadRow[] {
  const rows: TenantLoadRow[] = []
  for (const id of trafficStoreIds()) {
    const [req, err, db, lat, queries] = withTrafficStore(id, () => state().slots.sum(windowS, sec))
    if (!(req > 0)) continue
    rows.push({
      store: id,
      tenant_id: id.startsWith('t:') ? id.slice(2) : null,
      requests: req,
      errors: err,
      error_pct: Math.round((1000 * err) / req) / 10,
      rps: Math.round((100 * req) / windowS) / 100,
      db_ms: Math.round(db),
      db_share_pct: 0,
      avg_ms: Math.round((10 * lat) / req) / 10,
      queries
    })
  }
  return rankTenantRows(rows)
}

export const tenantLoadTap: TrafficTap = {
  id: TENANT_LOAD_TAP,
  onRequest(c) {
    const s = state().slots
    s.add(c.sec, S.req, 1)
    if (c.isError) s.add(c.sec, S.err, 1)
    s.add(c.sec, S.lat, Math.max(0, c.ev.latencyMs))
    const m = requestMeasure(c.ev.req)
    if (m) {
      s.add(c.sec, S.db, m.sqlMs)
      s.add(c.sec, S.queries, m.queries)
    }
  }
}

registerTrafficTap(tenantLoadTap)
