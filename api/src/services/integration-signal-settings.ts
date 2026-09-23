import type { IntegrationSignal } from './integration-signals.js'

export interface ResolvedSettings {
  enabled: boolean
  severity: 'critical' | 'warn'
  thresholds: Record<string, number>
}

export async function resolveThresholds(s: IntegrationSignal): Promise<ResolvedSettings> {
  return {
    enabled: true,
    severity: s.severity,
    thresholds: Object.fromEntries(s.thresholds.map((t) => [t.key, t.default]))
  }
}
