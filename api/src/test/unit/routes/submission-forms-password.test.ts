import { randomBytes, scryptSync } from 'node:crypto'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// POST /submission-forms/public/:token checked the password before any
// limit, and the per-IP limit counted only successful submissions — wrong
// passwords were unlimited. Every attempt on a protected form now counts per
// form + IP first; a value that does not fit its column is a 400, not a 500
// carrying the driver's text.
//
// Security audit 2026-10-27: the record is created through the items service
// as the form's (active) creator, and the per-IP hourly cap is taken
// atomically instead of read-then-insert.

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
  created_by: 'U-ADMIN',
  password_hash: `${salt}:${scryptSync('right-one', salt, 64).toString('hex')}`
}
const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  failCreate: null as Error | null,
  creatorActive: true,
  form: {} as Record<string, unknown>,
  created: [] as Array<{ user: { id: string }; collection: string; data: Record<string, unknown> }>
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      state.ran.push(q)
      if (q.sql.includes('[nivaro_submission_forms]')) return { ...FORM, ...state.form }
      if (q.sql.includes('[nivaro_users]'))
        return state.creatorActive ? { id: 'U-ADMIN', status: 'active' } : undefined
      if (q.sql.includes('count(')) return [{ count: 0 }]
      return []
    })
  }
})
const field = (name: string, extra: Record<string, unknown> = {}) => ({
  field: name,
  type: 'string',
  special: null,
  readonly: false,
  computed_type: null,
  ...extra
})
vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async () => [
    field('id', { type: 'uuid' }),
    field('title'),
    field('status'),
    field('owner', { type: 'uuid' }),
    field('lines', { type: 'alias', special: ['o2m'] }),
    field('tags', { type: 'string' }),
    field('created_by', { special: ['user-created'] })
  ]),
  getRelations: vi.fn(async () => [
    {
      many_collection: 'intake',
      many_field: 'owner',
      one_collection: 'nivaro_users',
      one_field: null
    },
    {
      many_collection: 'intake_lines',
      many_field: 'intake',
      one_collection: 'intake',
      one_field: 'lines'
    },
    {
      many_collection: 'intake_tags',
      many_field: 'intake_id',
      one_collection: 'intake',
      one_field: 'tags'
    }
  ])
}))
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(
    async (user: { id: string }, collection: string, data: Record<string, unknown>) => {
      if (state.failCreate) throw state.failCreate
      state.created.push({ user, collection, data })
      return { id: 42, ...data }
    }
  )
}))

import { sanitizeSubmission, submissionFormsRoutes } from '../../../routes/submission-forms.js'
import { resetWindowedMemory } from '../../../services/windowed-limit.js'

async function buildApp() {
  const app = Fastify()
  await app.register(submissionFormsRoutes, { prefix: '/submission-forms' })
  await app.ready()
  return app
}

const submit = (
  app: Awaited<ReturnType<typeof buildApp>>,
  password: string,
  data: Record<string, unknown> = { title: 'Hello' }
) =>
  app.inject({
    method: 'POST',
    url: '/submission-forms/public/tok',
    payload: { password, data }
  })

beforeEach(() => {
  state.ran.length = 0
  state.created.length = 0
  state.failCreate = null
  state.creatorActive = true
  state.form = {}
  resetWindowedMemory()
})

describe('public submission password attempts', () => {
  it('stops guessing after the cap — even the right password waits out the window', async () => {
    const app = await buildApp()
    // rate_limit_per_hour 10 → max(10, 10) + 10 = 20 attempts per hour per IP
    for (let i = 0; i < 20; i++) expect((await submit(app, `guess-${i}`)).statusCode).toBe(401)
    expect((await submit(app, 'guess-21')).statusCode).toBe(429)
    expect((await submit(app, 'right-one')).statusCode).toBe(429)
    expect(state.created).toHaveLength(0)
    await app.close()
  })

  it('accepts the right password under the cap', async () => {
    const app = await buildApp()
    expect((await submit(app, 'wrong')).statusCode).toBe(401)
    const ok = await submit(app, 'right-one')
    expect(ok.statusCode).toBe(201)
    // the record through the items service, the submission row by insert
    expect(state.created).toHaveLength(1)
    expect(state.ran.filter((q) => q.method === 'insert')).toHaveLength(1)
    await app.close()
  })

  it('answers a value the column refuses with a 400 that hides the driver text', async () => {
    const app = await buildApp()
    state.failCreate = new Error('Conversion failed when converting date and/or time')
    const res = await submit(app, 'right-one')
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('Conversion failed')
    await app.close()
  })
})

describe('public submission writes (audit 2026-10-27)', () => {
  it('creates the record as the form creator, only with the allowed fields', async () => {
    const app = await buildApp()
    const res = await submit(app, 'right-one', { title: 'Hi', status: 'approved', id: 7 })
    expect(res.statusCode).toBe(201)
    expect(state.created[0]?.user.id).toBe('U-ADMIN')
    expect(state.created[0]?.collection).toBe('intake')
    expect(state.created[0]?.data).toEqual({ title: 'Hi' })
    await app.close()
  })

  it('refuses when the creator is no longer active', async () => {
    const app = await buildApp()
    state.creatorActive = false
    const res = await submit(app, 'right-one')
    expect(res.statusCode).toBe(410)
    expect(state.created).toHaveLength(0)
    await app.close()
  })

  it('keeps a validation refusal message the submitter can act on', async () => {
    const app = await buildApp()
    state.failCreate = Object.assign(new Error('Title is required'), {
      statusCode: 422,
      violations: [{ field: 'title', message: 'Title is required' }]
    })
    const res = await submit(app, 'right-one')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Title is required')
    await app.close()
  })

  it('caps submissions per IP atomically, whatever the stored count says', async () => {
    const app = await buildApp()
    state.form = { password_hash: null, rate_limit_per_hour: 2 }
    const results = await Promise.all([1, 2, 3, 4].map(() => submit(app, '')))
    const codes = results.map((r) => r.statusCode).sort()
    expect(codes).toEqual([201, 201, 429, 429])
    expect(state.created).toHaveLength(2)
    await app.close()
  })
})

describe('sanitizeSubmission (review follow-up)', () => {
  const fields = [
    field('id', { type: 'uuid' }),
    field('title'),
    field('owner', { type: 'uuid' }),
    field('lines', { type: 'alias', special: ['o2m'] }),
    field('tags'),
    field('created_by', { special: ['user-created'] }),
    field('locked', { readonly: true }),
    field('score', { computed_type: 'write' })
  ] as never
  const relations = [
    {
      many_collection: 'intake',
      many_field: 'owner',
      one_collection: 'nivaro_users',
      one_field: null
    },
    {
      many_collection: 'intake_lines',
      many_field: 'intake',
      one_collection: 'intake',
      one_field: 'lines'
    },
    {
      many_collection: 'intake_tags',
      many_field: 'intake_id',
      one_collection: 'intake',
      one_field: 'tags'
    }
  ] as never
  const all = ['id', 'title', 'owner', 'lines', 'tags', 'created_by', 'locked', 'score', 'missing']

  it('keeps listed scalar columns, an M2O id included', () => {
    expect(
      sanitizeSubmission('intake', all, { title: 'Hi', owner: 'U-9' }, fields, relations)
    ).toEqual({ data: { title: 'Hi', owner: 'U-9' } })
  })

  it('drops alias / O2M / M2M fields, the key, audit, read-only and computed fields', () => {
    const out = sanitizeSubmission(
      'intake',
      all,
      {
        title: 'Hi',
        id: 'X',
        lines: 'x',
        tags: 'x',
        created_by: 'U-ADMIN',
        locked: true,
        score: 99,
        missing: 1
      },
      fields,
      relations
    )
    expect(out).toEqual({ data: { title: 'Hi' } })
  })

  it('refuses objects and arrays (nested writes)', () => {
    expect(
      sanitizeSubmission('intake', all, { owner: { create: { email: 'x' } } }, fields, relations)
    ).toHaveProperty('error')
    expect(sanitizeSubmission('intake', all, { title: ['a'] }, fields, relations)).toHaveProperty(
      'error'
    )
    expect(sanitizeSubmission('intake', all, ['title'], fields, relations)).toHaveProperty('error')
  })

  it('only own keys of fields the form lists', () => {
    const proto = Object.create({ title: 'inherited' })
    expect(sanitizeSubmission('intake', all, proto, fields, relations)).toEqual({ data: {} })
    expect(sanitizeSubmission('intake', ['title'], { owner: 'U-9' }, fields, relations)).toEqual({
      data: {}
    })
  })
})

describe('public submission refuses nested payloads end to end', () => {
  it('400s an object value and never reaches the items service', async () => {
    const app = await buildApp()
    state.form = { password_hash: null, fields: '["title","owner","lines"]' }
    const res = await submit(app, '', { title: 'x', lines: [{ amount: 1 }] })
    expect(res.statusCode).toBe(201) // alias field silently dropped
    expect(state.created[0]?.data).toEqual({ title: 'x' })
    const bad = await submit(app, '', { owner: { email: 'x@y' } })
    expect(bad.statusCode).toBe(400)
    expect(state.created).toHaveLength(1)
    await app.close()
  })
})
