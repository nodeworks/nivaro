import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// /api/field-defaults — a person's own defaults under /mine; administrators
// manage anyone's under /users/:userId, validated AS that person.

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user']
      if (!who)
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401, code: 'NOT_SIGNED_IN' })
      req.user = { id: who, role: who === 'admin' ? 'role-admin' : 'role-buyer' }
      req.isAdmin = who === 'admin'
    }
  )
  return {
    authenticate,
    requireAuth: authenticate,
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }, reply: unknown) => {
      await authenticate(req as never)
      if (!req.isAdmin)
        throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
      void reply
    })
  }
})

vi.mock('../../../services/field-defaults.js', async () => {
  class FieldDefaultRefusal extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    FieldDefaultRefusal,
    listDefaults: vi.fn(async () => []),
    saveDefault: vi.fn(async (_t: unknown, _a: unknown, input: Record<string, unknown>) => ({
      id: 1,
      ...input,
      updated_at: '2026-10-28T00:00:00.000Z',
      updated_by: null
    })),
    deleteDefault: vi.fn(async () => true),
    withFormState: vi.fn(async (_u: unknown, rows: unknown[]) =>
      rows.map((r) => ({ ...(r as object), on_layout: true }))
    ),
    hasAllowedField: vi.fn(async () => true),
    allowedForPerson: vi.fn(async () => [
      { collection: 'orders', label: 'Orders', fields: ['ship_to'] }
    ])
  }
})

const TARGET = '0b9f3a52-1111-4222-8333-444455556666'
vi.mock('../../../services/users.js', () => ({
  getUser: vi.fn(async (id: string) =>
    id === '0b9f3a52-1111-4222-8333-444455556666' ? { id, role: 'role-buyer' } : undefined
  )
}))

import { fieldDefaultsRoutes } from '../../../routes/field-defaults.js'
import {
  allowedForPerson,
  deleteDefault,
  FieldDefaultRefusal,
  hasAllowedField,
  listDefaults,
  saveDefault,
  withFormState
} from '../../../services/field-defaults.js'

async function buildApp() {
  const app = Fastify()
  await app.register(fieldDefaultsRoutes, { prefix: '/field-defaults' })
  return app
}

const BODY = { collection: 'orders', field: 'ship_to', value: 7, context: { zone: 2 } }

beforeEach(() => vi.clearAllMocks())

describe('/field-defaults/mine', () => {
  it('lists the caller own defaults, filtered by collection', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/field-defaults/mine?collection=orders',
      headers: { 'x-test-user': 'bob' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
    expect(listDefaults).toHaveBeenCalledWith('bob', 'orders')
  })

  it('adds on_layout only when asked (?on_layout=1), judged as the caller', async () => {
    vi.mocked(listDefaults).mockResolvedValue([{ id: 3 } as never])
    const app = await buildApp()
    const plain = await app.inject({
      method: 'GET',
      url: '/field-defaults/mine',
      headers: { 'x-test-user': 'bob' }
    })
    expect(plain.json()).toEqual({ data: [{ id: 3 }] })
    expect(withFormState).not.toHaveBeenCalled()
    const res = await app.inject({
      method: 'GET',
      url: '/field-defaults/mine?on_layout=1',
      headers: { 'x-test-user': 'bob' }
    })
    expect(res.json()).toEqual({ data: [{ id: 3, on_layout: true }] })
    expect((vi.mocked(withFormState).mock.calls[0][0] as { id: string }).id).toBe('bob')
    vi.mocked(listDefaults).mockResolvedValue([])
  })

  it('lists the fields the caller may keep a default for', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/field-defaults/mine/allowed',
      headers: { 'x-test-user': 'bob' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0].fields).toEqual(['ship_to'])
    expect((vi.mocked(allowedForPerson).mock.calls[0][0] as { id: string }).id).toBe('bob')
  })

  it('answers only "is there anything" for ?any=1, without the full list', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/field-defaults/mine/allowed?any=1',
      headers: { 'x-test-user': 'bob' }
    })
    expect(res.json()).toEqual({ data: { any: true } })
    expect(allowedForPerson).not.toHaveBeenCalled()
    expect((vi.mocked(hasAllowedField).mock.calls[0][0] as { id: string }).id).toBe('bob')
  })

  it('saves as the caller, for the caller', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/field-defaults/mine',
      headers: { 'x-test-user': 'bob' },
      payload: BODY
    })
    expect(res.statusCode).toBe(200)
    const [target, actor, input] = vi.mocked(saveDefault).mock.calls[0]
    expect((target as { id: string }).id).toBe('bob')
    expect((actor as { id: string }).id).toBe('bob')
    expect(input).toEqual(BODY)
    expect(res.json().data.id).toBe(1)
  })

  it('answers a refusal with its status and code', async () => {
    vi.mocked(saveDefault).mockRejectedValueOnce(
      new FieldDefaultRefusal(403, 'NO_CREATE', 'You cannot create orders')
    )
    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/field-defaults/mine',
      headers: { 'x-test-user': 'bob' },
      payload: BODY
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'NO_CREATE' })
  })

  it('rejects a body without collection / field', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/field-defaults/mine',
      headers: { 'x-test-user': 'bob' },
      payload: { value: 1 }
    })
    expect(res.statusCode).toBe(400)
    expect(saveDefault).not.toHaveBeenCalled()
  })

  it('deletes only the caller own row; 404 when nothing matched', async () => {
    const app = await buildApp()
    const ok = await app.inject({
      method: 'DELETE',
      url: '/field-defaults/mine/5',
      headers: { 'x-test-user': 'bob' }
    })
    expect(ok.statusCode).toBe(200)
    expect(deleteDefault).toHaveBeenCalledWith('bob', 5)
    vi.mocked(deleteDefault).mockResolvedValueOnce(false)
    const miss = await app.inject({
      method: 'DELETE',
      url: '/field-defaults/mine/6',
      headers: { 'x-test-user': 'bob' }
    })
    expect(miss.statusCode).toBe(404)
    expect(miss.json().code).toBe('DEFAULT_NOT_FOUND')
  })
})

describe('/field-defaults/users/:userId (admin)', () => {
  it('refuses a non-admin with 403', async () => {
    const app = await buildApp()
    for (const [method, url] of [
      ['GET', `/field-defaults/users/${TARGET}`],
      ['PUT', `/field-defaults/users/${TARGET}`],
      ['DELETE', `/field-defaults/users/${TARGET}/5`],
      ['GET', `/field-defaults/users/${TARGET}/allowed`]
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { 'x-test-user': 'bob' },
        payload: method === 'PUT' ? BODY : undefined
      })
      expect(res.statusCode).toBe(403)
    }
    expect(saveDefault).not.toHaveBeenCalled()
    expect(deleteDefault).not.toHaveBeenCalled()
    expect(listDefaults).not.toHaveBeenCalled()
  })

  it('saves as the target, logged as the admin', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: `/field-defaults/users/${TARGET}`,
      headers: { 'x-test-user': 'admin' },
      payload: BODY
    })
    expect(res.statusCode).toBe(200)
    const [target, actor] = vi.mocked(saveDefault).mock.calls[0]
    expect((target as { id: string }).id).toBe(TARGET)
    expect((actor as { id: string }).id).toBe('admin')
  })

  it("answers the target's allowed fields and form state, judged as the target", async () => {
    const app = await buildApp()
    const allowed = await app.inject({
      method: 'GET',
      url: `/field-defaults/users/${TARGET}/allowed`,
      headers: { 'x-test-user': 'admin' }
    })
    expect(allowed.statusCode).toBe(200)
    expect((vi.mocked(allowedForPerson).mock.calls[0][0] as { id: string }).id).toBe(TARGET)
    const list = await app.inject({
      method: 'GET',
      url: `/field-defaults/users/${TARGET}?on_layout=1`,
      headers: { 'x-test-user': 'admin' }
    })
    expect(list.statusCode).toBe(200)
    expect((vi.mocked(withFormState).mock.calls[0][0] as { id: string }).id).toBe(TARGET)
  })

  it('404s an unknown person', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/field-defaults/users/0b9f3a52-0000-4222-8333-444455556666',
      headers: { 'x-test-user': 'admin' }
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('USER_NOT_FOUND')
  })

  it('clears for the target with the admin as actor', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'DELETE',
      url: `/field-defaults/users/${TARGET}/5`,
      headers: { 'x-test-user': 'admin' }
    })
    expect(res.statusCode).toBe(200)
    const [userId, id, actor] = vi.mocked(deleteDefault).mock.calls[0]
    expect(userId).toBe(TARGET)
    expect(id).toBe(5)
    expect((actor as unknown as { id: string }).id).toBe('admin')
  })
})
