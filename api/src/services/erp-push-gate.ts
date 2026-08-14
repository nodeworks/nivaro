import { createHash } from 'node:crypto'

/**
 * Decides whether a transition action should actually push to an external
 * system, so an integration is told about changes it cares about instead of
 * every transition that happens to occur.
 *
 * Configured per action (`push_when`):
 *   - `state_change: true` (the default) — a transition IS a state change, so
 *     this fires every time, which is the historical behaviour.
 *   - `state_change: false` with `fields: [...]` — fire only when one of those
 *     record values differs from the last successful push. This is what stops
 *     an unrelated approval hop from re-sending an identical payload.
 *   - both — fire on the state change, or on a field change.
 *
 * The comparison is against the newest SUCCESSFUL submission for the same
 * record and endpoint. A failed push must not count as "already sent", or a
 * transient outage would suppress the retry that fixes it.
 */
export interface PushWhen {
  state_change?: boolean
  fields?: string[]
  /**
   * Compare the RENDERED payload instead of naming record fields. This is what
   * you want when the thing that changed is not a column: a linked purchase
   * order lives in a junction and reaches the payload through a context query,
   * so no record field moves when it is attached. The payload is also the
   * honest definition of "they already know this" — if the bytes are the same,
   * the receiver learns nothing from being told again.
   */
  payload?: boolean
}

/** Stable fingerprint of a rendered payload: key order must not matter. */
export function payloadSignature(body: unknown): string | null {
  if (body === null || body === undefined) return null
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canonical(val)])
      )
    }
    return v
  }
  try {
    return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex').slice(0, 64)
  } catch {
    return null
  }
}

/** Stable fingerprint of the watched values. Order-independent, null-safe. */
export function changeSignature(
  record: Record<string, unknown>,
  fields: string[] | undefined
): string | null {
  if (!fields || fields.length === 0) return null
  const parts = [...fields].sort().map((f) => {
    const value = f.split('.').reduce<unknown>((acc, seg) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[seg]
      return undefined
    }, record)
    // Undefined and null are the same absence for this purpose; a value that
    // stringifies identically has not changed as far as the receiver is
    // concerned (2 and "2" reach them the same way).
    return `${f}=${value === null || value === undefined ? '' : String(value)}`
  })
  return createHash('sha256').update(parts.join('')).digest('hex').slice(0, 64)
}

export function shouldPush(args: {
  pushWhen: PushWhen | undefined
  stateChanged: boolean
  signature: string | null
  lastSignature: string | null | undefined
}): boolean {
  const { pushWhen, stateChanged, signature, lastSignature } = args
  // Unconfigured: unchanged behaviour — every transition pushes.
  if (!pushWhen) return true

  const onState = pushWhen.state_change !== false
  if (onState && stateChanged) return true

  const watchesPayload = pushWhen.payload === true
  const fields = pushWhen.fields ?? []
  if (fields.length === 0 && !watchesPayload) return onState ? stateChanged : false

  // Nothing to compare against (first push, or history predates the column):
  // send it. Suppressing here would mean an integration never hears about a
  // record until its second change.
  if (signature === null) return true
  if (lastSignature === null || lastSignature === undefined) return true
  return signature !== lastSignature
}
