import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// R1: both deploy routes judge the procedure name outside comments, so a decoy comment naming
// one procedure cannot get another procedure's header deployed.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: 'admin', email: 'a@x' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

const importRow: { value: Record<string, unknown> | undefined } = { value: undefined }
vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'select', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => importRow.value)
    c.update = vi.fn(async () => 1)
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited as a thenable
    c.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return c
  }
  const db = vi.fn(() => chain()) as unknown as Record<string, unknown>
  db.raw = vi.fn(async () => [])
  db.schema = { hasTable: vi.fn(async () => true) }
  return { db }
})
vi.mock('../../../services/procedure-deploy.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return { ...m, deployProcedure: vi.fn(async () => {}) }
})

import { procedureRoutes } from '../../../routes/procedures.js'
import { stagedImportRoutes } from '../../../routes/staged-imports.js'
import { deployProcedure } from '../../../services/procedure-deploy.js'

describe('deploy routes read the header outside comments (R1)', () => {
  it('the Procedures page refuses a decoy comment naming the target', async () => {
    const app = Fastify()
    await app.register(procedureRoutes, { prefix: '/procedures' })
    const decoy = '/* create procedure Foo */\nCREATE PROCEDURE Bar AS SELECT 1'
    const res = await app.inject({
      method: 'PUT',
      url: '/procedures/Foo',
      payload: { definition: decoy }
    })
    expect(res.statusCode).toBe(400)
    expect(deployProcedure).not.toHaveBeenCalled()
    const ok = await app.inject({
      method: 'PUT',
      url: '/procedures/Bar',
      payload: { definition: decoy }
    })
    expect(ok.statusCode).toBe(200)
    expect(deployProcedure).toHaveBeenCalledWith(decoy, { schema: 'dbo', name: 'Bar' })
  })

  it('an import definition deploy refuses a body whose real header is another procedure', async () => {
    vi.mocked(deployProcedure).mockClear()
    const app = Fastify()
    await app.register(stagedImportRoutes, { prefix: '/staged-imports' })
    importRow.value = {
      id: 1,
      key: 'invoices',
      procedure: 'Foo',
      procedure_body: '-- create or alter procedure Foo\nCREATE OR ALTER PROCEDURE Bar AS SELECT 1'
    }
    const res = await app.inject({ method: 'POST', url: '/staged-imports/definitions/1/deploy' })
    expect(res.statusCode).toBe(400)
    expect(deployProcedure).not.toHaveBeenCalled()
    importRow.value = {
      ...importRow.value,
      procedure_body: 'CREATE OR ALTER PROCEDURE Foo AS SELECT 1'
    }
    const ok = await app.inject({ method: 'POST', url: '/staged-imports/definitions/1/deploy' })
    expect(ok.statusCode).toBe(200)
    expect(deployProcedure).toHaveBeenCalledWith('CREATE OR ALTER PROCEDURE Foo AS SELECT 1', {
      schema: 'dbo',
      name: 'Foo'
    })
  })
})
