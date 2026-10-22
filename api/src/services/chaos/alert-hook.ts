/**
 * One seam for "an alert just fired" (#2847, shared with the run recorder): the alert paths
 * (Ops Console log alert rules and request-log rules, ops monitors, metric alerts, integration
 * signal alerts) call `alertFired` at the moment they fire; chaos listens to tag the alert as a
 * drill and to stamp the run's time to detect. Synchronous, never throws, zero cost with no
 * listener — safe on the log write path.
 */

export interface FiredAlert {
  /** Which alert path fired: 'log-rule' | 'request-rule' | 'ops-monitor' | 'metric-alert' | 'integration-signal' | … */
  source: string
  /** Stable id within the source (rule id, monitor id, signal id). */
  key: string
  /** What people call it (the rule or monitor name). */
  label: string
  severity?: string | null
  /** When it fired (ms); now when absent. */
  at?: number
}

type Listener = (a: FiredAlert & { at: number }) => void

const listeners = new Set<Listener>()

export function onAlertFired(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function alertFired(a: FiredAlert): void {
  if (!listeners.size) return
  const ev = {
    ...a,
    source: String(a.source).slice(0, 40),
    key: String(a.key).slice(0, 200),
    label: String(a.label ?? '').slice(0, 200),
    at: a.at ?? Date.now()
  }
  for (const fn of listeners) {
    try {
      fn(ev)
    } catch {
      /* a listener never breaks the alert path */
    }
  }
}

/** Tests only. */
export function _resetAlertHookForTests(): void {
  listeners.clear()
}
