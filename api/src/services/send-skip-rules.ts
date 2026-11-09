import { db } from '../db/index.js'

/**
 * Per-integration "do not send" rules (2026-11-09: MWF answers 400 "B254 is not
 * supported" for that market's workflow ids). Stored on the external API as
 * `integration_config.skip_sends`:
 *
 *   { "skip_sends": [
 *       { "field": "workflow_id", "starts_with": "B254-",
 *         "reason": "MWF does not support market B254 yet" } ] }
 *
 * Judged against the RENDERED body, so one rule covers every transition action
 * and flow step that talks to the integration, whatever template built the
 * body. A match means the send is skipped on purpose — the obligation records
 * `skipped` with the reason, never `failed` or `overdue`.
 */
export interface SendSkipRule {
  /** Dotted path into the request body. */
  field: string
  starts_with?: string
  equals?: string
  reason?: string
}

/** Every skip_sends reason starts with this — the reconcile sweep reads it as a deliberate
 *  "never send", not a guard that may be wrong. */
export const SEND_SKIP_PREFIX = 'not sent: '

function at(body: unknown, path: string): unknown {
  let cur: unknown = body
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** The first rule the body matches, as its reason text; null = send. Case-insensitive. */
export function matchSendSkip(rules: unknown, body: unknown): string | null {
  if (!Array.isArray(rules) || body == null || typeof body !== 'object') return null
  for (const raw of rules) {
    const r = raw as SendSkipRule
    if (!r || typeof r.field !== 'string' || !r.field) continue
    const v = at(body, r.field)
    if (v == null) continue
    const s = String(v).trim().toUpperCase()
    const hit =
      (typeof r.starts_with === 'string' &&
        r.starts_with &&
        s.startsWith(r.starts_with.toUpperCase())) ||
      (typeof r.equals === 'string' && r.equals && s === r.equals.toUpperCase())
    if (hit) {
      const why = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : null
      return `${SEND_SKIP_PREFIX}${r.field} ${String(v)}${why ? ` — ${why}` : ''}`
    }
  }
  return null
}

/** The integration's skip_sends rules matched against a body (null = send). Never throws. */
export async function sendSkipReason(
  apiId: number | string,
  body: unknown
): Promise<string | null> {
  try {
    const row = (await db('nivaro_external_apis')
      .where({ id: Number(apiId) })
      .first('integration_config')) as { integration_config: unknown } | undefined
    const raw = row?.integration_config
    const cfg =
      raw == null || raw === ''
        ? null
        : typeof raw === 'string'
          ? (JSON.parse(raw) as Record<string, unknown>)
          : (raw as Record<string, unknown>)
    return matchSendSkip(cfg?.skip_sends, body)
  } catch {
    return null
  }
}
