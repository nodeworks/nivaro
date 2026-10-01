import { describe, expect, it } from 'vitest'
import { judgeReady, timedCheck, within } from '../../../services/ready-probe.js'

describe('ready probe (#1081)', () => {
  it('a dependency that answers inside its budget passes', async () => {
    const c = await timedCheck('redis', 'Redis', 200, async () => 'PONG')
    expect(c.ok).toBe(true)
  })

  it('a slow dependency fails rather than reading as degraded', async () => {
    const c = await timedCheck('redis', 'Redis', 20, () => new Promise((r) => setTimeout(r, 200)))
    expect(c.ok).toBe(false)
    expect(c.summary).toMatch(/did not answer/)
  })

  it('a failing dependency fails', async () => {
    const c = await timedCheck('database', 'Database', 200, async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(c).toMatchObject({ ok: false, id: 'database' })
  })

  it('ready only when every check passes', () => {
    expect(judgeReady([{ id: 'boot', ok: true, summary: '' }]).ready).toBe(true)
    expect(
      judgeReady([
        { id: 'boot', ok: true, summary: '' },
        { id: 'redis', ok: false, summary: '' }
      ]).ready
    ).toBe(false)
  })

  it('within() passes through the value', async () => {
    await expect(within(Promise.resolve(7), 50)).resolves.toBe(7)
  })
})
