import { api } from '@/lib/api'

/**
 * Nivaro Hub placement (ideas 48–50): types, query keys and calls for /api/hub/placement*,
 * /regions*, /chargeback* and /federation* (routes/hub-placement.ts).
 */

// ─── hosts and regions ───────────────────────────────────────────────────────

export interface Region {
  id: number
  key: string
  name: string
  note: string | null
  cost_percent: number
  position: number
}

export interface HostEnvironment {
  env_id: number
  app_id: number
  app_key: string
  app_name: string
  env_key: string
  status: string
  stack: string | null
}

export interface Host {
  driver_id: number
  name: string
  label: string | null
  region_id: number | null
  environments: HostEnvironment[]
  shared: Array<{ id: number; key: string; name: string; status: string; apps: number }>
  figures: {
    cpu_pct: number | null
    memory_mb: number | null
    storage_bytes: number | null
    sampled_at: string | null
  }
}

export interface PlacementMap {
  regions: Array<Region & { hosts: Host[] }>
  ungrouped: Host[]
  unplaced: Array<Omit<HostEnvironment, 'stack'>>
}

export const placementKeys = {
  all: ['hub', 'placement'] as const,
  map: () => ['hub', 'placement', 'map'] as const,
  chargeback: () => ['hub', 'placement', 'chargeback'] as const,
  chargebackSettings: () => ['hub', 'placement', 'chargeback', 'settings'] as const,
  peers: () => ['hub', 'placement', 'peers'] as const,
  fleet: () => ['hub', 'placement', 'federated-fleet'] as const
}

export const fetchPlacementMap = () =>
  api.get<{ data: PlacementMap }>('/hub/placement').then((r) => r.data.data)

export const createRegion = (b: {
  key: string
  name: string
  note?: string
  cost_percent: number
}) => api.post<{ data: Region }>('/hub/regions', b).then((r) => r.data.data)

export const updateRegion = (
  id: number,
  b: Partial<{ name: string; note: string | null; cost_percent: number }>
) => api.patch<{ data: Region }>(`/hub/regions/${id}`, b).then((r) => r.data.data)

export const deleteRegion = (id: number) => api.delete(`/hub/regions/${id}`)

export const setHostRegion = (driverId: number, regionId: number | null, label: string | null) =>
  api
    .put(`/hub/placement/hosts/${driverId}`, { region_id: regionId, label })
    .then((r) => r.data.data)

export const placeEnvironment = (envId: number, driverId: number, stack: string) =>
  api
    .post<{ data: { placement_id: number } }>(`/hub/placement/environments/${envId}/place`, {
      driver_id: driverId,
      stack
    })
    .then((r) => r.data.data)

/** The app page's Move panel with a new stack on `driverId` picked (move-prefill.ts). */
export const moveToHostPath = (appId: number, envId: number, driverId: number) =>
  `/hub?app=${appId}&move=${envId}&to=new:${driverId}`

/** A stack name for an environment placed on a host: `<app>-<env>`, cut to the stack rule. */
export function stackNameFor(appKey: string, envKey: string): string {
  const raw = `${appKey}-${envKey}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const name = raw
    .replace(/^[^a-z]+/, '')
    .slice(0, 41)
    .replace(/-+$/, '')
  return name.length >= 2 ? name : `app-${name || 'env'}`
}

export const STACK_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

// ─── chargeback ──────────────────────────────────────────────────────────────

export interface ChargebackRates {
  cpu_core_month: number
  memory_gb_month: number
  storage_gb_month: number
  database_gb_month: number
  environment_month: number
}

export interface ChargebackSettings {
  currency: string
  rates: ChargebackRates
  window_days: number
}

export const RATE_FIELDS: Array<{ key: keyof ChargebackRates; label: string; unit: string }> = [
  { key: 'cpu_core_month', label: 'CPU', unit: 'per core, per month' },
  { key: 'memory_gb_month', label: 'Memory', unit: 'per GB, per month' },
  { key: 'storage_gb_month', label: 'File storage', unit: 'per GB, per month' },
  { key: 'database_gb_month', label: 'Database', unit: 'per GB, per month' },
  { key: 'environment_month', label: 'Each environment', unit: 'flat, per month' }
]

export interface EnvCost {
  env_id: number
  env_key: string
  runs_on: string
  region: string | null
  usage: {
    cpu_cores: number | null
    memory_gb: number | null
    storage_gb: number | null
    database_gb: number | null
  }
  cost: {
    cpu: number
    memory: number
    storage: number
    database: number
    environment: number
    subtotal: number
    factor_percent: number
    total: number
  }
  gaps: string[]
}

export interface AppCost {
  app_id: number
  app_key: string
  app_name: string
  department: string | null
  cost_center: string | null
  owners: Array<{ user_id: string; name: string }>
  environments: EnvCost[]
  total: number
}

export interface GroupCost {
  key: string
  label: string
  apps: number
  total: number
}

export interface ChargebackReport {
  generated_at: string
  window_days: number
  currency: string
  rates: ChargebackRates
  apps: AppCost[]
  departments: GroupCost[]
  owners: GroupCost[]
  total: number
  unrated: boolean
}

export const fetchChargeback = () =>
  api.get<{ data: ChargebackReport }>('/hub/chargeback').then((r) => r.data.data)

export const fetchChargebackSettings = () =>
  api.get<{ data: ChargebackSettings }>('/hub/chargeback/settings').then((r) => r.data.data)

export const saveChargebackSettings = (s: ChargebackSettings) =>
  api.put<{ data: ChargebackSettings }>('/hub/chargeback/settings', s).then((r) => r.data.data)

export const saveCostCenter = (appId: number, b: { department: string; cost_center: string }) =>
  api.put(`/hub/chargeback/apps/${appId}`, b).then((r) => r.data.data)

/** The CSV as a download (the API logs it). */
export async function downloadChargebackCsv(): Promise<void> {
  const r = await api.get<Blob>('/hub/chargeback.csv', { responseType: 'blob' })
  const url = URL.createObjectURL(r.data)
  const a = document.createElement('a')
  a.href = url
  a.download = 'hub-chargeback.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** An amount in the report's currency (falls back to the plain number for an odd code). */
export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

// ─── federation ──────────────────────────────────────────────────────────────

export interface Peer {
  id: number
  name: string
  base_url: string
  token: string | null
  enabled: boolean
  last_ok_at: string | null
  last_tried_at: string | null
  last_error: string | null
  last_count: number | null
}

export interface FederatedRow {
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  env_key: string
  env_status: string | null
  host: string | null
  placement: 'dedicated' | 'shared' | 'none' | null
  version: string | null
  behind: number | null
  state: string | null
  up: boolean | null
  uptime_30d: number | null
  open_issues: number | null
  alerts: number
  checked_at: string | null
  deployed_at: string | null
  path: string
}

export interface PeerFleet {
  peer_id: number
  name: string
  base_url: string
  ok: boolean
  error: string | null
  error_text: string | null
  stale: boolean
  fetched_at: string | null
  version: string | null
  newest: string | null
  rows: FederatedRow[]
}

export const fetchPeers = () =>
  api.get<{ data: Peer[] }>('/hub/federation/peers').then((r) => r.data.data)

export const fetchFederatedFleet = (fresh = false) =>
  api
    .get<{ data: PeerFleet[] }>(`/hub/federation/fleet${fresh ? '?fresh=1' : ''}`)
    .then((r) => r.data.data)

export const createPeer = (b: { name: string; base_url: string; token: string }) =>
  api.post<{ data: Peer }>('/hub/federation/peers', b).then((r) => r.data.data)

export const updatePeer = (
  id: number,
  b: Partial<{ name: string; base_url: string; token: string; enabled: boolean }>
) => api.patch<{ data: Peer }>(`/hub/federation/peers/${id}`, b).then((r) => r.data.data)

export const deletePeer = (id: number) => api.delete(`/hub/federation/peers/${id}`)

export const checkPeer = (id: number) =>
  api
    .post<{ data: { fleet: PeerFleet } }>(`/hub/federation/peers/${id}/check`, {})
    .then((r) => r.data.data)

/**
 * The one link a remote row gets: the peer's own stored origin + a path the server built
 * (`/hub?app=<integer>`). Anything else (a path that is not plain host-relative) gets no link.
 */
export function peerLink(baseUrl: string, path: string): string | null {
  if (!/^\/hub\?app=\d{1,10}$/.test(path)) return null
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}${path}`
  } catch {
    return null
  }
}
