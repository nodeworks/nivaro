import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// R1: both deploy routes judge the procedure name outside comments, so a decoy comment naming
// one procedure cannot get another procedure's header deployed.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: 'admin', email: 'a@x' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

// The config store and import definitions in memory (the Procedures page writes through config).
vi.mock('../../../db/index.js', async () => {
  const { fakeDb } = await import('../services/managed-procedures/fake-store.js')
  fakeDb.raw = async () => []
  return { db: fakeDb }
})
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/procedure-deploy.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return {
    ...m,
    deployProcedure: vi.fn(async () => {}),
    liveProcedureDefinitions: vi.fn(async () => new Map())
  }
})

import { procedureRoutes } from '../../../routes/procedures.js'
import { stagedImportRoutes } from '../../../routes/staged-imports.js'
import { deployProcedure, toCreateOrAlter } from '../../../services/procedure-deploy.js'
import { resetFakeStore, seedRow } from '../services/managed-procedures/fake-store.js'

const IMPORTS = 'nivaro_import_definitions'

beforeEach(() => {
  resetFakeStore()
  vi.mocked(deployProcedure).mockClear()
})

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
    expect(deployProcedure).toHaveBeenCalledWith(toCreateOrAlter(decoy), {
      schema: 'dbo',
      name: 'Bar'
    })
  })

  it('an import definition deploy refuses a body whose real header is another procedure', async () => {
    const app = Fastify()
    await app.register(stagedImportRoutes, { prefix: '/staged-imports' })
    // The route reads the id from the URL (a string; SQL Server converts it for the compare).
    const row = seedRow(IMPORTS, {
      id: '1',
      key: 'invoices',
      procedure: 'Foo',
      procedure_body: '-- create or alter procedure Foo\nCREATE OR ALTER PROCEDURE Bar AS SELECT 1'
    })
    const res = await app.inject({ method: 'POST', url: '/staged-imports/definitions/1/deploy' })
    expect(res.statusCode).toBe(400)
    expect(deployProcedure).not.toHaveBeenCalled()
    row.procedure_body = 'CREATE OR ALTER PROCEDURE Foo AS SELECT 1'
    const ok = await app.inject({ method: 'POST', url: '/staged-imports/definitions/1/deploy' })
    expect(ok.statusCode).toBe(200)
    expect(deployProcedure).toHaveBeenCalledWith('CREATE OR ALTER PROCEDURE Foo AS SELECT 1', {
      schema: 'dbo',
      name: 'Foo'
    })
  })
})

describe('the Procedures page never writes an app-managed procedure', () => {
  it('refuses to deploy over or drop a procedure an import definition owns', async () => {
    const app = Fastify()
    await app.register(procedureRoutes, { prefix: '/procedures' })
    seedRow(IMPORTS, {
      key: 'invoices',
      procedure: 'import_invoices',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 1'
    })
    const put = await app.inject({
      method: 'PUT',
      url: '/procedures/import_invoices',
      payload: { definition: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 1' }
    })
    expect(put.statusCode).toBe(409)
    expect(put.json()).toMatchObject({ code: 'APP_MANAGED', definition: 'invoices' })
    expect(deployProcedure).not.toHaveBeenCalled()
  })
})
