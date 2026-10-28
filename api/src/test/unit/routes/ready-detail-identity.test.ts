import { describe, expect, it, vi } from 'vitest'

// Review A12 (2026-10-27): /api/ready's admin check is identity only — authenticate never
// touches the readiness reply (no headers, no second answer), whatever it does.

vi.mock('../../../services/dev-staleness.js', () => ({
  devStaleness: vi.fn(() => null),
  startDevStalenessScan: vi.fn()
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(),
  authenticate: vi.fn(
    async (req: { isAdmin?: boolean; headers: Record<string, string> }, reply) => {
      // what a rate-limited API key does: headers, then a refusal
      reply.header('Retry-After', '30').code(429)
      if (req.headers.authorization === 'Bearer admin') {
        req.isAdmin = true
        return
      }
      throw Object.assign(new Error('Too many'), { statusCode: 429 })
    }
  )
}))

import { readyDetailAllowed, silentReply } from '../../../routes/health.js'

const remote = (headers: Record<string, string>) =>
  ({ headers, socket: { remoteAddress: '203.0.113.9' } }) as never

describe('readyDetailAllowed', () => {
  it('answers admin / not admin without a reply of its own', async () => {
    expect(await readyDetailAllowed(remote({ authorization: 'Bearer admin' }))).toBe(true)
    expect(await readyDetailAllowed(remote({ authorization: 'Bearer limited' }))).toBe(false)
    expect(await readyDetailAllowed(remote({}))).toBe(false)
  })

  it('the stand-in reply chains and records nothing', () => {
    const r = silentReply()
    expect(r.header('a', 'b').code(500).send({})).toBe(r)
    expect(r.sent).toBe(false)
  })
})
