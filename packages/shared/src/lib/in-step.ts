import { countdownText } from './deadline-ticker'

/**
 * Time in the current step (realtime round 8, item 9): "Finance · 3 d 4 h" in a list's
 * optional In step column, "for 3 d 4 h" beside the step on a record. Counted on the shared
 * page clock (deadline-ticker `useDeadlineNow`, server time, one beat for the whole page) from
 * the instant the record entered its step — the newest history row into that step, else the
 * instance start (the same moment the Aging column and `$aging` count from). A move resets it
 * because the step and its entry instant arrive with the list's / panel's live refetch.
 */

/** Sort key the items API orders by (api services/record-state.ts IN_STEP_SORT). */
export const IN_STEP_SORT = '$in_step'
/** The collection browser's column key for it (a display column like `__f:` formula keys). */
export const IN_STEP_COLUMN = '__in_step__'
/** The queue worklist's column key; it sorts as `aging_hours` on the server. */
export const QUEUE_IN_STEP_COLUMN = 'in_step'

function ms(v: string | number | Date | null | undefined): number | null {
  if (v == null || v === '') return null
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/** "3 d 4 h" since `enteredAt`; null without one. A clock a little ahead never reads negative. */
export function inStepSpan(
  enteredAt: string | number | Date | null | undefined,
  now: number
): string | null {
  const t = ms(enteredAt)
  if (t == null) return null
  return countdownText(Math.max(0, now - t))
}

/** "Finance · 3 d 4 h" (or just the span when the step has no label). */
export function inStepText(
  stepLabel: string | null | undefined,
  enteredAt: string | number | Date | null | undefined,
  now: number
): string | null {
  const span = inStepSpan(enteredAt, now)
  if (span == null) return null
  const label = String(stepLabel ?? '').trim()
  return label ? `${label} · ${span}` : span
}

/** "for 3 d 4 h" — the record header's line beside the step chip. */
export function forStepText(
  enteredAt: string | number | Date | null | undefined,
  now: number
): string | null {
  const span = inStepSpan(enteredAt, now)
  return span == null ? null : `for ${span}`
}

/**
 * When a record entered its current step, from the history a record page already holds:
 * the newest row into that step, else the instance start. Null when neither says.
 */
export function enteredAtFromHistory(
  currentState: string | null | undefined,
  history: ReadonlyArray<{ to_state: string; timestamp: string }> | null | undefined,
  startedAt?: string | null
): string | null {
  if (!currentState) return null
  const cur = String(currentState).toUpperCase()
  let best: number | null = null
  let bestIso: string | null = null
  for (const h of history ?? []) {
    if (String(h.to_state ?? '').toUpperCase() !== cur) continue
    const t = ms(h.timestamp)
    if (t != null && (best == null || t > best)) {
      best = t
      bestIso = h.timestamp
    }
  }
  return bestIso ?? (startedAt && ms(startedAt) != null ? startedAt : null)
}

/** The queue's server sort: In step is Aging (shortest first = least aged). */
export function queueServerSort(sort: string): string {
  if (sort === 'state_entered') return '-aging_hours'
  if (sort === '-state_entered') return 'aging_hours'
  if (sort === QUEUE_IN_STEP_COLUMN) return 'aging_hours'
  if (sort === `-${QUEUE_IN_STEP_COLUMN}`) return '-aging_hours'
  return sort
}
