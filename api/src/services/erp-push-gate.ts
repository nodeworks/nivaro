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
    return createHash('sha256')
      .update(JSON.stringify(canonical(body)))
      .digest('hex')
      .slice(0, 64)
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

// ─── What the next push would change (#615) ─────────────────────────────────

export interface PayloadChange {
  /** Dotted path into the payload: `po_number`, `lines[2].quantity`. */
  path: string
  /** The top-level key the path sits under — what the summary names. */
  top: string
  from: unknown
  to: unknown
}

const MAX_DIFF_DEPTH = 6

function flattenPayload(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
  depth: number
): void {
  if (depth > MAX_DIFF_DEPTH || value === null || typeof value !== 'object') {
    out.set(prefix, value)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, [])
    value.forEach((v, i) => flattenPayload(v, `${prefix}[${i}]`, out, depth + 1))
    return
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) out.set(prefix, {})
  for (const [k, v] of entries) flattenPayload(v, prefix ? `${prefix}.${k}` : k, out, depth + 1)
}

function sameLeaf(a: unknown, b: unknown): boolean {
  // Absent and null reach the receiver the same way; 2 and "2" too.
  const na = a === undefined || a === null ? null : a
  const nb = b === undefined || b === null ? null : b
  if (na === null || nb === null) return na === nb
  if (typeof na === 'object' || typeof nb === 'object')
    return JSON.stringify(na) === JSON.stringify(nb)
  return String(na) === String(nb)
}

/**
 * Leaf-level differences between the payload a partner last received and the
 * one the next push would send. `previous` null = nothing has landed yet,
 * which reads as every leaf being new. Capped — a payload with a hundred
 * changed lines needs a count, not a wall.
 */
export function diffPayloads(previous: unknown, next: unknown, cap = 60): PayloadChange[] {
  const a = new Map<string, unknown>()
  const b = new Map<string, unknown>()
  if (previous !== null && previous !== undefined) flattenPayload(previous, '', a, 0)
  if (next !== null && next !== undefined) flattenPayload(next, '', b, 0)
  const paths = [...new Set([...b.keys(), ...a.keys()])]
  const out: PayloadChange[] = []
  for (const path of paths) {
    const from = a.get(path)
    const to = b.get(path)
    if (sameLeaf(from, to)) continue
    const top = path.split(/[.[]/)[0] || path
    out.push({ path, top, from: from ?? null, to: to ?? null })
    if (out.length >= cap) break
  }
  return out
}

const ACRONYMS = new Set(['id', 'po', 'req', 'url', 'sku', 'uom', 'erp', 'api', 'ids'])

/** `po_number` → "PO number", `requisitionId` → "Requisition ID". */
export function humanizePayloadKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  if (words.length === 0) return key
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w)) return w === 'ids' ? 'IDs' : w.toUpperCase()
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}

/** The top-level keys a change list touches, in first-seen order, humanized. */
export function summarizePayloadChanges(changes: PayloadChange[]): string[] {
  const seen: string[] = []
  for (const c of changes) if (!seen.includes(c.top)) seen.push(c.top)
  return seen.map(humanizePayloadKey)
}

/** A person's reading of a push_when config: when the push actually goes. */
export function describePushWhen(pushWhen: PushWhen | null | undefined): string {
  // A transition IS a state change, so a state-change push always goes.
  if (pushWhen?.state_change !== false) return 'Sent every time this transition runs'
  const fields = pushWhen.fields ?? []
  const parts: string[] = []
  if (pushWhen.payload === true) parts.push('when what it would send has changed')
  if (fields.length > 0) parts.push(`when ${fields.map(humanizePayloadKey).join(', ')} changed`)
  if (parts.length === 0) return 'Never sent (push_when watches nothing)'
  return `Sent ${parts.join(', or ')}`
}
