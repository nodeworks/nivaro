import { randomBytes, scryptSync } from 'node:crypto'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// POST /submission-forms/public/:token checked the password before any
// limit, and the per-IP limit counted only successful submissions — wrong
// passwords were unlimited. Every attempt on a protected form now counts per
// form + IP first; a value that does not fit its column is a 400, not a 500
// carrying the driver's text.

vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

const salt = randomBytes(16).toString('hex')
const FORM = {
  id: 'F1',
  token: 'tok',
  name: 'Intake',
  collection: 'intake',
  fields: '["title"]',
  is_active: 1,
  expires_at: null,
  layout_id: null,
  rate_limit_per_hour: 10,
  success_message: null,
  password_hash: `${salt}:${scryptSync('right-one', salt, 64).toString('hex')}`
}
const state = vi.hoisted(() => ({ ran: [] as FakeQuery[], failInsert: false }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      state.ran.push(q)
      if (q.sql.includes('[nivaro_submission_forms]')) return { ...FORM }
      if (q.sql.includes('count(')) return [{ count: 0 }]
      if (q.method === 'insert' && q.sql.includes('[intake]') && state.failInsert)
        throw new Error('Conversion failed when converting date and/or time')
      return []
    })
  }
})

import { submissionFormsRoutes } from '../../../routes/submission-forms.js'
import { resetWindowedMemory } from '../../../services/windowed-limit.js'

async function buildApp() {
  const app = Fastify()
  await app.register(submissionFormsRoutes, { prefix: '/submission-forms' })
  await app.ready()
  return app
}

const submit = (app: Awaited<ReturnType<typeof buildApp>>, password: string) =>
  app.inject({
    method: 'POST',
    url: '/submission-forms/public/tok',
    payload: { password, data: { title: 'Hello' } }
  })

beforeEach(() => {
  state.ran.length = 0
  state.failInsert = false
  resetWindowedMemory()
})

describe('public submission password attempts', () => {
  it('stops guessing after the cap — even the right password waits out the window', async () => {
    const app = await buildApp()
    // rate_limit_per_hour 10 → max(10, 10) + 10 = 20 attempts per hour per IP
    for (let i = 0; i < 20; i++) expect((await submit(app, `guess-${i}`)).statusCode).toBe(401)
    expect((await submit(app, 'guess-21')).statusCode).toBe(429)
    expect((await submit(app, 'right-one')).statusCode).toBe(429)
    expect(state.ran.some((q) => q.method === 'insert')).toBe(false)
    await app.close()
  })

  it('accepts the right password under the cap', async () => {
    const app = await buildApp()
    expect((await submit(app, 'wrong')).statusCode).toBe(401)
    const ok = await submit(app, 'right-one')
    expect(ok.statusCode).toBe(201)
    expect(state.ran.filter((q) => q.method === 'insert')).toHaveLength(2)
    await app.close()
  })

  it('answers a value the column refuses with a 400 that hides the driver text', async () => {
    const app = await buildApp()
    state.failInsert = true
    const res = await submit(app, 'right-one')
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('Conversion failed')
    await app.close()
  })
})
