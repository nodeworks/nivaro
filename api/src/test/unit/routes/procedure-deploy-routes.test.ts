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
import { resetFakeStore, rowsOf, seedRow } from '../services/managed-procedures/fake-store.js'

const IMPORTS = 'nivaro_import_definitions'
const MANAGED = 'nivaro_managed_procedures'

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

describe('import definitions never take an app-managed procedure', () => {
  const MSG =
    'spend_totals is an app-managed procedure (Developer → Procedures). Give this import its own procedure, or drop it there first.'
  const BODY = 'CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1'
  const imports = async () => {
    const app = Fastify()
    await app.register(stagedImportRoutes, { prefix: '/staged-imports' })
    return app
  }

  it('PATCH an import definition body onto a managed procedure is 409 MANAGED_PROCEDURE', async () => {
    const app = await imports()
    seedRow(MANAGED, { name: 'spend_totals', body: BODY, body_hash: 'h', version: 1 })
    const row = seedRow(IMPORTS, {
      id: '1',
      key: 'spend',
      procedure: 'spend_totals',
      procedure_body: null
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/staged-imports/definitions/1',
      payload: { procedure_body: BODY }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'MANAGED_PROCEDURE', error: MSG })
    expect(row.procedure_body).toBeNull()
  })

  it('PATCH a body whose header names a managed procedure is refused whatever the row names', async () => {
    const app = await imports()
    seedRow(MANAGED, { name: 'spend_totals', body: BODY, body_hash: 'h', version: 1 })
    seedRow(IMPORTS, { id: '1', key: 'spend', procedure: 'import_spend', procedure_body: null })
    const res = await app.inject({
      method: 'PATCH',
      url: '/staged-imports/definitions/1',
      payload: { procedure_body: BODY }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'MANAGED_PROCEDURE' })
  })

  it('PATCH pointing a definition that has a body at a managed procedure is refused', async () => {
    const app = await imports()
    seedRow(MANAGED, { name: 'spend_totals', body: BODY, body_hash: 'h', version: 1 })
    const row = seedRow(IMPORTS, {
      id: '1',
      key: 'spend',
      procedure: 'import_spend',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_spend AS SELECT 1'
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/staged-imports/definitions/1',
      payload: { procedure: 'Spend_Totals' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'MANAGED_PROCEDURE' })
    expect(row.procedure).toBe('import_spend')
  })

  it('a dropped managed row does not block an import body', async () => {
    const app = await imports()
    seedRow(MANAGED, {
      name: 'spend_totals',
      body: BODY,
      body_hash: 'h',
      version: 2,
      dropped_at: new Date()
    })
    const row = seedRow(IMPORTS, {
      id: '1',
      key: 'spend',
      procedure: 'spend_totals',
      procedure_body: null
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/staged-imports/definitions/1',
      payload: { procedure_body: BODY }
    })
    expect(res.json()).not.toMatchObject({ code: 'MANAGED_PROCEDURE' })
    expect(row.procedure_body).toBe(BODY)
  })

  it('POST a new definition with a body onto a managed procedure is 409 MANAGED_PROCEDURE', async () => {
    const app = await imports()
    seedRow(MANAGED, { name: 'spend_totals', body: BODY, body_hash: 'h', version: 1 })
    const res = await app.inject({
      method: 'POST',
      url: '/staged-imports/definitions',
      payload: { key: 'spend', procedure: 'spend_totals', procedure_body: BODY }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'MANAGED_PROCEDURE', error: MSG })
    expect(rowsOf(IMPORTS)).toHaveLength(0)
  })

  it('restoring a version whose body takes a managed procedure is refused', async () => {
    const app = await imports()
    seedRow(MANAGED, { name: 'spend_totals', body: BODY, body_hash: 'h', version: 1 })
    const row = seedRow(IMPORTS, {
      id: '1',
      key: 'spend',
      procedure: 'import_spend',
      procedure_body: null
    })
    seedRow('nivaro_import_definition_versions', {
      id: '5',
      definition: '1',
      version: 2,
      snapshot: JSON.stringify({ procedure: 'spend_totals', procedure_body: BODY })
    })
    const res = await app.inject({
      method: 'POST',
      url: '/staged-imports/definitions/1/versions/5/restore'
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'MANAGED_PROCEDURE' })
    expect(row.procedure).toBe('import_spend')
  })

  it('deploying one of two import definitions that name the same procedure is 409', async () => {
    const app = await imports()
    seedRow(IMPORTS, {
      id: '1',
      key: 'spend_a',
      procedure: 'import_spend',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_spend AS SELECT 1'
    })
    seedRow(IMPORTS, {
      id: '2',
      key: 'spend_b',
      procedure: 'import_spend',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_spend AS SELECT 2'
    })
    const res = await app.inject({ method: 'POST', url: '/staged-imports/definitions/1/deploy' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'IMPORT_PROC_CONFLICT',
      definitions: ['spend_a', 'spend_b']
    })
    expect(deployProcedure).not.toHaveBeenCalled()
  })
})
