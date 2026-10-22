/**
 * One hook for "an alert just fired" (#1773 / #2847). The places that fire one — Ops Console
 * log alert rules (log-ring.ts), metric alerts including the Traffic Map's (metric-alerts.ts)
 * and monitors flipping to failing (ops-monitors.ts) — call `noteAlertFired` beside their own
 * work; listeners (the chaos run recorder, drill tagging) hear every firing in this process.
 *
 * Leaf module: no imports. A listener never affects the alert (errors are swallowed) and runs
 * synchronously, so it must hand anything slow to a promise of its own.
 */

export interface AlertFired {
  /** Which engine fired it. */
  source: 'log_rule' | 'metric_alert' | 'monitor' | (string & {})
  /** Stable id within the source (rule id, monitor id). */
  key: string
  /** The name people gave it (no record data). */
  label: string
  severity?: string | null
  /** epoch ms */
  at: number
}

type Listener = (alert: AlertFired) => void

const listeners = new Set<Listener>()

export function onAlertFired(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function noteAlertFired(alert: Omit<AlertFired, 'at'> & { at?: number }): void {
  if (listeners.size === 0) return
  const a: AlertFired = { ...alert, at: alert.at ?? Date.now() }
  for (const fn of listeners) {
    try {
      fn(a)
    } catch {
      /* a listener never affects the alert */
    }
  }
}
