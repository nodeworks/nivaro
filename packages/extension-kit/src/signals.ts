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

/** What a declared Traffic Map node matches: external API names (case-insensitive), a path
 *  prefix or RegExp, a verb. Every given part must match. */
export interface TrafficNodeMatchSpec {
  api?: string | string[]
  path?: string | RegExp
  method?: string
}
/** The partner call a function matcher sees. */
export interface TrafficNodeCall {
  apiId: number
  apiName: string
  method: string | null
  path: string | null
}
/** A downstream node an extension declares on the Traffic Map (#1114): partner calls it
 *  matches are drawn to `x:<extension>.<id>` (first declared match wins) instead of the plain
 *  external-API node, so fan-out reads in business terms (MDSi, MWF, a warehouse). */
export interface TrafficNodeDef {
  /** Unique within the extension: [a-z0-9_-], up to 60 characters. */
  id: string
  label: string
  match: TrafficNodeMatchSpec | ((call: TrafficNodeCall) => boolean)
  description?: string
}
