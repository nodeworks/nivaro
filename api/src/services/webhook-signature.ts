import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-SHA256 check for inbound webhook flows (security audit 2026-10-27, Low).
 *
 * The signature is over the EXACT bytes received (req.rawBody), never a re-serialisation of
 * the parsed JSON — two different bodies that parse alike can no longer share a signature.
 *
 * Replay protection: a sender that adds `X-Signature-Timestamp: <unix seconds>` signs
 * `<timestamp>.<raw body>` (the Stripe/Slack convention) and the request is refused outside
 * a 5-minute window. A flow whose trigger options set `require_timestamp: true` refuses
 * unsigned-timestamp requests; others still accept a body-only signature (existing senders).
 *
 * Header format: `sha256=<hex>`. Leaf module.
 */

export const SIGNATURE_TOLERANCE_S = 300

function header(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

function sameSignature(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function signWebhookBody(secret: string, rawBody: string, timestamp?: string): string {
  const signed = timestamp ? `${timestamp}.${rawBody}` : rawBody
  return `sha256=${createHmac('sha256', secret).update(signed).digest('hex')}`
}

export function verifyWebhookSignature(input: {
  secret: string
  rawBody: string
  signature: string | string[] | undefined
  timestamp?: string | string[] | undefined
  requireTimestamp?: boolean
  nowMs?: number
}): { ok: true } | { ok: false; error: string } {
  const sig = header(input.signature).trim()
  const ts = header(input.timestamp).trim()
  if (!sig) return { ok: false, error: 'Invalid signature' }
  if (ts) {
    if (!/^\d{1,12}$/.test(ts)) return { ok: false, error: 'Invalid signature timestamp' }
    const now = Math.floor((input.nowMs ?? Date.now()) / 1000)
    if (Math.abs(now - Number(ts)) > SIGNATURE_TOLERANCE_S) {
      return { ok: false, error: 'Signature timestamp outside the allowed window' }
    }
    return sameSignature(sig, signWebhookBody(input.secret, input.rawBody, ts))
      ? { ok: true }
      : { ok: false, error: 'Invalid signature' }
  }
  if (input.requireTimestamp) return { ok: false, error: 'Signature timestamp required' }
  return sameSignature(sig, signWebhookBody(input.secret, input.rawBody))
    ? { ok: true }
    : { ok: false, error: 'Invalid signature' }
}
