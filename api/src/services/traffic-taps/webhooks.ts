// api/src/services/traffic-taps/webhooks.ts
/**
 * Topology tap `webhooks` (#1144): each outgoing webhook as a downstream node — delivery rate,
 * failures and slow receivers — fed from writeDelivery() (every attempt logged to
 * nivaro_webhook_deliveries). Labels name the webhook, or its receiver's host — never the full
 * URL (a query string can carry a secret).
 */
import { noteDown } from '../traffic-map.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { noteSourceDown } from './sources.js'
import { currentEntityKey, MinuteTotals } from './util.js'

export const WEBHOOKS_TAP = 'webhooks'
/** A delivery slower than this counts as slow (the dispatch timeout is 15 s). */
export const WEBHOOK_SLOW_MS = 5000

function state(): { counts: MinuteTotals } {
  return tapState(WEBHOOKS_TAP, () => ({ counts: new MinuteTotals(200) }))
}

export function webhookNodeId(id: number | string): string {
  return `webhook:${String(id).slice(0, 40)}`
}

/** "Webhook · Order sync", else "Webhook · hooks.example.com". */
export function webhookLabel(w: {
  id: number | string
  url?: string | null
  name?: unknown
}): string {
  const name = typeof w.name === 'string' && w.name.trim() ? w.name.trim().slice(0, 60) : null
  if (name) return `Webhook · ${name}`
  try {
    return `Webhook · ${new URL(String(w.url)).hostname}`
  } catch {
    return `Webhook ${w.id}`
  }
}

export function noteWebhookDelivery(d: {
  webhook: { id: number | string; url?: string | null; name?: unknown }
  status: number | null
  ms: number
  success: boolean
}): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    const at = Date.now()
    const sec = Math.floor(at / 1000)
    const id = webhookNodeId(d.webhook.id)
    const c = state().counts
    if (!d.success) c.add(`${id}|failed`, sec)
    if (d.ms >= WEBHOOK_SLOW_MS) c.add(`${id}|slow`, sec)
    c.add(`${id}|s${d.status ?? 'network'}`, sec)
    noteDown({
      id,
      label: webhookLabel(d.webhook),
      kind: 'webhook',
      ok: d.success,
      ms: d.ms,
      at,
      entityKey: currentEntityKey()
    })
    noteSourceDown(id, at)
  } catch {
    /* never */
  }
}

registerTrafficTap({
  id: WEBHOOKS_TAP,
  snapshot(windowS, sec) {
    const out: Record<string, { failed: number; slow: number; codes: Record<string, number> }> = {}
    for (const [k, n] of state().counts.entries(windowS, sec)) {
      const cut = k.lastIndexOf('|')
      const id = k.slice(0, cut)
      const what = k.slice(cut + 1)
      const row = out[id] ?? { failed: 0, slow: 0, codes: {} }
      if (what === 'failed') row.failed = n
      else if (what === 'slow') row.slow = n
      else if (what.startsWith('s')) row.codes[what.slice(1)] = n
      out[id] = row
    }
    return Object.keys(out).length ? { slow_ms: WEBHOOK_SLOW_MS, webhooks: out } : undefined
  },
  sweep(sec) {
    state().counts.sweep(sec)
  }
})
