export interface SignalThreshold {
  key: string
  label: string
  default: number
  unit: string
  min?: number
  max?: number
}

export interface SignalAction {
  kind: 'retry_submission' | 'resend' | 'open' | 'explain' | 'extension'
  label: string
  /** Extension action id (kind 'extension'), submission id (retry), etc. */
  id?: string
  payload?: Record<string, unknown>
}

/** A typed "Details" reference on a signal row — see `SignalRow.drill`. */
export interface SignalDrill {
  kind: 'submission' | 'import_run'
  id: string
}

export interface SignalRow {
  /** Stable identity of the problem instance — NEVER a message or timestamp. */
  key: string
  group?: string
  group_label?: string
  title: string
  detail?: string
  since?: string
  /** Identity of THIS occurrence of the problem (a run id, a submission
   *  attempt, an obligation id). `key` names the PROBLEM and stays the same
   *  across every failure; a Dismiss hides the row until `occurrence` next
   *  changes. Unset falls back to `since`, then a masked hash of the row. */
  occurrence?: string
  api?: string
  record?: { collection: string; id: string; label?: string }
  actions: SignalAction[]
  /** What the console can open in place under this row. */
  drill?: SignalDrill
}

export interface SignalEvalContext {
  thresholds: Record<string, number>
  /** A Date `n` business days before now (core SLA schedule: days + holidays). */
  businessDaysAgo(n: number): Promise<Date>
}

/** One kind of problem on the Integrations console's Firefight list,
 *  evaluated every five minutes. */
export interface IntegrationSignal {
  id: string
  label: string
  description: string
  tab: string
  severity: 'critical' | 'warn'
  thresholds: SignalThreshold[]
  evaluate(ctx: SignalEvalContext): Promise<{ count: number; rows: SignalRow[] }>
}

/** An action a signal row may offer (kind 'extension', id = def.id). */
export interface SignalActionHandler {
  id: string
  label: string
  run(args: {
    rows: SignalRow[]
    userId: string | null
    authHeaders: Record<string, string>
  }): Promise<Array<{ key: string; ok: boolean; message: string }>>
}
