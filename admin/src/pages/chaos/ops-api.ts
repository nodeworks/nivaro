import { api } from '@/lib/api'
import type { ChaosRun } from './api'

/**
 * Client for the operations side of chaos (#2862 settings + caps, #2829 Chaos Monkey) — mirrors
 * api/src/services/chaos/settings.ts and routes/chaos-ops.ts.
 */

export interface ChaosEnvCaps {
  allowed_faults: string[] | '*'
  max_share_pct: number | null
  max_latency_ms: number | null
  max_seconds: number | null
  max_replicas: number | null
}

export interface MonkeyHours {
  days: number[]
  start: string
  end: string
  tz: string
}

export interface MonkeySettings {
  enabled: boolean
  faults: string[]
  max_per_week: number
  hours: MonkeyHours
  max_seconds: number
  max_share_pct: number
}

export interface ChaosSettings {
  operator_roles: string[]
  environments: Record<string, ChaosEnvCaps>
  monkey: MonkeySettings
}

export interface ChaosSettingsView {
  settings: ChaosSettings
  instance: string
  effective_caps: ChaosEnvCaps
  candidates: Array<{ key: string; label: string; danger: string }>
}

export interface MonkeyView {
  monkey: MonkeySettings
  instance: string
  production: boolean
  this_week: number
  verdict: { ok: boolean; why: string; chance: number }
  runs: ChaosRun[]
}

export interface OperatorView {
  operator: boolean
  admin: boolean
  allowed: boolean
}

export const opsKeys = {
  operator: ['chaos', 'operator'] as const,
  settings: ['chaos', 'settings'] as const,
  monkey: ['chaos', 'monkey'] as const
}

export const fetchOperator = () =>
  api.get('/chaos/operator').then((r) => r.data.data as OperatorView)
export const fetchChaosSettings = () =>
  api.get('/chaos/settings').then((r) => r.data.data as ChaosSettingsView)
export const patchChaosSettings = (patch: Record<string, unknown>) =>
  api.patch('/chaos/settings', patch).then((r) => r.data.data as ChaosSettingsView)
export const fetchMonkey = () => api.get('/chaos/monkey').then((r) => r.data.data as MonkeyView)
export const tryMonkey = () =>
  api
    .post('/chaos/monkey/try', {})
    .then((r) => r.data.data as { acted: boolean; why: string; run_id?: string })

export const WEEKDAYS: Array<{ n: number; short: string; long: string }> = [
  { n: 1, short: 'Mon', long: 'Monday' },
  { n: 2, short: 'Tue', long: 'Tuesday' },
  { n: 3, short: 'Wed', long: 'Wednesday' },
  { n: 4, short: 'Thu', long: 'Thursday' },
  { n: 5, short: 'Fri', long: 'Friday' },
  { n: 6, short: 'Sat', long: 'Saturday' },
  { n: 7, short: 'Sun', long: 'Sunday' }
]

/** 'HH:MM' (24 h) → '2:00 PM'. */
export function twelveHour(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

/** America/New_York → ET; anything else as written. */
export const tzLabel = (tz: string) => (tz === 'America/New_York' ? 'ET' : tz)
