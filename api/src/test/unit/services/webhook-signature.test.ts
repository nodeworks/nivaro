import { describe, expect, it } from 'vitest'
import { signWebhookBody, verifyWebhookSignature } from '../../../services/webhook-signature.js'

// Webhook flow HMAC (security audit 2026-10-27): over the raw bytes, with an
// optional signed timestamp for replay protection.

const secret = 'whsec-test'
const raw = '{ "event": "paid",  "amount": 10 }'

describe('verifyWebhookSignature', () => {
  it('accepts a signature over the exact raw body', () => {
    const signature = signWebhookBody(secret, raw)
    expect(verifyWebhookSignature({ secret, rawBody: raw, signature })).toEqual({ ok: true })
  })

  it('refuses a signature over a re-serialisation of the same JSON', () => {
    const signature = signWebhookBody(secret, JSON.stringify(JSON.parse(raw)))
    expect(verifyWebhookSignature({ secret, rawBody: raw, signature }).ok).toBe(false)
  })

  it('checks a signed timestamp and its window', () => {
    const now = 1_800_000_000_000
    const ts = String(now / 1000)
    const signature = signWebhookBody(secret, raw, ts)
    expect(
      verifyWebhookSignature({ secret, rawBody: raw, signature, timestamp: ts, nowMs: now })
    ).toEqual({ ok: true })
    // replayed 10 minutes later
    expect(
      verifyWebhookSignature({
        secret,
        rawBody: raw,
        signature,
        timestamp: ts,
        nowMs: now + 600_000
      }).ok
    ).toBe(false)
    // the timestamp is part of what was signed
    expect(
      verifyWebhookSignature({
        secret,
        rawBody: raw,
        signature,
        timestamp: String(now / 1000 + 1),
        nowMs: now
      }).ok
    ).toBe(false)
  })

  it('a flow may require the timestamp', () => {
    const signature = signWebhookBody(secret, raw)
    expect(
      verifyWebhookSignature({ secret, rawBody: raw, signature, requireTimestamp: true }).ok
    ).toBe(false)
  })

  it('refuses a missing or malformed signature', () => {
    expect(verifyWebhookSignature({ secret, rawBody: raw, signature: undefined }).ok).toBe(false)
    expect(verifyWebhookSignature({ secret, rawBody: raw, signature: 'sha256=00' }).ok).toBe(false)
  })
})
