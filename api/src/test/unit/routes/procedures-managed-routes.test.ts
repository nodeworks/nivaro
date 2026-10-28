import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Procedures page through config: every write is a managed version, then a deploy.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: 'admin', email: 'a@x' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))

/** What SQL Server holds: lowercased name → definition ('' = encrypted, text unreadable). */
const live = vi.hoisted(() => ({ defs: new Map<string, string>() }))

vi.mock('../../../db/index.js', async () => {
  const { fakeDb, fakeStore } = await import('../services/managed-procedures/fake-store.js')
  // The route's own catalog reads (list, read one, parameters), answered from `live`.
  fakeDb.raw = async (sql: string, bindings: unknown[] = []) => {
    fakeStore.raw.push({ sql, bindings })
    const when = new Date('2026-10-01T00:00:00Z')
    if (sql.includes('sys.parameters pa') && sql.includes('JOIN sys.types')) return []
    if (sql.includes('param_count')) {
      return [...live.defs].map(([name, def]) => ({
        name,
        create_date: when,
        modify_date: when,
        bytes: def.length,
        param_count: 0
      }))
    }
    if (sql.includes('m.definition') && sql.includes('p.name = ?')) {
      const name = String(bindings[0]).toLowerCase()
      if (!live.defs.has(name)) return []
      const def = live.defs.get(name) as string
      return [{ name, create_date: when, modify_date: when, definition: def || null }]
    }
    throw new Error(`unexpected raw SQL: ${sql.slice(0, 80)}`)
  }
  return { db: fakeDb }
})

vi.mock('../../../services/procedure-deploy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/procedure-deploy.js')>()
  return {
    ...real,
    deployProcedure: vi.fn(async (definition: string, t: { name: string }) => {
      live.defs.set(t.name.toLowerCase(), real.toCreateOrAlter(definition))
    }),
    dropProcedure: vi.fn(async (t: { name: string }) => {
      live.defs.delete(t.name.toLowerCase())
    }),
    liveProcedureDefinition: vi.fn(
      async (_schema: string | null, name: string) => live.defs.get(name.toLowerCase()) || null
    ),
    liveProcedureDefinitions: vi.fn(async (names?: string[]) => {
      if (!names) return new Map(live.defs)
      const want = new Set(names.map((n) => n.toLowerCase()))
      return new Map([...live.defs].filter(([n]) => want.has(n)))
    })
  }
})

import { procedureRoutes } from '../../../routes/procedures.js'
import { logActivity } from '../../../services/activity.js'
import { procBodyHash } from '../../../services/managed-procedures/normalize.js'
import { MANAGED_TABLE, VERSIONS_TABLE } from '../../../services/managed-procedures/owners.js'
import { deployProcedure, dropProcedure } from '../../../services/procedure-deploy.js'
import { registerReadinessCheck } from '../../../services/readiness.js'
import { resetFakeStore, rowsOf, seedRow } from '../services/managed-procedures/fake-store.js'

const IMPORTS = 'nivaro_import_definitions'
const V1 = 'CREATE PROCEDURE spend_totals AS SELECT 1'
const V2 = 'CREATE OR ALTER PROCEDURE spend_totals AS SELECT 2'

let app: FastifyInstance

async function build() {
  const a = Fastify()
  await a.register(procedureRoutes, { prefix: '/procedures' })
  return a
}

const put = (name: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/procedures/${name}`, payload })

const actions = () => vi.mocked(logActivity).mock.calls.map((c) => c[0])

beforeEach(async () => {
  resetFakeStore()
  live.defs = new Map()
  vi.mocked(deployProcedure).mockClear()
  vi.mocked(dropProcedure).mockClear()
  vi.mocked(logActivity).mockClear()
  app = await build()
})

describe('PUT /:name', () => {
  it('PUT a new name creates a managed proc: version 1, deployed', async () => {
    const res = await put('new_report', {
      definition: 'CREATE OR ALTER PROCEDURE new_report AS SELECT 1',
      create: true
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ok: true,
      created: true,
      version: 1,
      deployed: { action: 'created' }
    })
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(1)
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({ name: 'new_report', version: 1 })
    expect(rowsOf(MANAGED_TABLE)[0].deployed_hash).toBe(rowsOf(MANAGED_TABLE)[0].body_hash)
    expect(live.defs.get('new_report')).toBe('CREATE OR ALTER PROCEDURE new_report AS SELECT 1')
    expect(actions()).toEqual([
      expect.objectContaining({
        action: 'procedure-create',
        collection: 'sys.procedures',
        item: 'new_report',
        comment: expect.stringMatching(/^v1 · /)
      })
    ])
  })

  it('PUT create:true on an existing name is 409 PROC_EXISTS', async () => {
    live.defs.set('spend_totals', V1)
    const res = await put('spend_totals', { definition: V2, create: true })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'PROC_EXISTS' })
    // A config-only (not live) name too.
    seedRow(MANAGED_TABLE, { name: 'only_config', body: 'x', body_hash: 'h', version: 1 })
    const res2 = await put('only_config', {
      definition: 'CREATE PROCEDURE only_config AS SELECT 1',
      create: true
    })
    expect(res2.statusCode).toBe(409)
    expect(res2.json()).toMatchObject({ code: 'PROC_EXISTS' })
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(0)
  })

  it('PUT on an unmanaged live proc adopts it as v1 and saves the edit as v2', async () => {
    live.defs.set('spend_totals', V1)
    const res = await put('spend_totals', { definition: V2 })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ok: true,
      created: false,
      version: 2,
      deployed: { action: 'altered' }
    })
    const versions = rowsOf(VERSIONS_TABLE)
    expect(versions.map((v) => [v.version, v.note])).toEqual([
      [1, 'Adopted from the live database before an edit'],
      [2, 'Edited in the Procedures page']
    ])
    expect(versions[0].body).toBe('CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1')
    expect(live.defs.get('spend_totals')).toBe(V2)
    expect(actions().map((a) => a.action)).toEqual(['procedure-adopt', 'procedure-update'])
  })

  it('PUT with a stale base_hash is 409 PROC_STALE and deploys nothing', async () => {
    await put('spend_totals', { definition: V1, create: true })
    vi.mocked(deployProcedure).mockClear()
    const res = await put('spend_totals', { definition: V2, base_hash: 'not-the-hash' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'PROC_STALE', current: { version: 1 } })
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
  })

  it('PUT with a stale base_version is 409 PROC_STALE (R3)', async () => {
    await put('spend_totals', { definition: V1, create: true })
    const hash = rowsOf(MANAGED_TABLE)[0].body_hash
    const res = await put('spend_totals', { definition: V2, base_hash: hash, base_version: 7 })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'PROC_STALE' })
    const ok = await put('spend_totals', { definition: V2, base_hash: hash, base_version: 1 })
    expect(ok.json()).toMatchObject({ version: 2 })
  })

  it('PUT on an unmanaged proc whose live text changed since it was read is 409 and writes nothing', async () => {
    live.defs.set('spend_totals', V1)
    const res = await put('spend_totals', { definition: V2, base_hash: procBodyHash('other') })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'PROC_STALE' })
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(0)
    // A caller that thought the name was new (null base) or had a config version is stale too.
    for (const base of [{ base_hash: null }, { base_version: 1 }]) {
      const r = await put('spend_totals', { definition: V2, ...base })
      expect(r.statusCode).toBe(409)
    }
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(0)
    // The live hash GET /:name gave passes.
    const ok = await put('spend_totals', { definition: V2, base_hash: procBodyHash(V1) })
    expect(ok.json()).toMatchObject({ version: 2 })
  })

  it('PUT keeps refusing a decoy header (400) and an import-owned name (409 APP_MANAGED)', async () => {
    const decoy = '/* create procedure Foo */\nCREATE PROCEDURE Bar AS SELECT 1'
    const bad = await put('Foo', { definition: decoy })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe(
      'The definition must be a CREATE [OR ALTER] PROCEDURE for "Foo" — the statement\'s name doesn\'t match.'
    )
    seedRow(IMPORTS, {
      key: 'invoices',
      procedure: 'import_invoices',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 1'
    })
    const owned = await put('import_invoices', {
      definition: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 2'
    })
    expect(owned.statusCode).toBe(409)
    expect(owned.json()).toMatchObject({ code: 'APP_MANAGED', definition: 'invoices' })
    expect(owned.json().error).toMatch(/managed by the import definition "invoices"/)
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(0)
  })

  it('a failed deploy answers 400 DEPLOY_FAILED and keeps no new version', async () => {
    await put('spend_totals', { definition: V1, create: true })
    vi.mocked(deployProcedure).mockRejectedValueOnce(new Error("Invalid column name 'x'"))
    const res = await put('spend_totals', { definition: V2 })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'DEPLOY_FAILED', error: "Invalid column name 'x'" })
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({ version: 1 })
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
  })

  it('an unchanged body with a new description updates it without a version (R1)', async () => {
    await put('spend_totals', { definition: V1, create: true })
    const res = await put('spend_totals', { definition: V1, description: 'Totals' })
    expect(res.json()).toMatchObject({ version: 1, unchanged: true })
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({ description: 'Totals', version: 1 })
  })
})

describe('DELETE /:name', () => {
  it('DELETE marks dropped and drops live; versions stay', async () => {
    await put('spend_totals', { definition: V1, create: true })
    vi.mocked(logActivity).mockClear()
    const res = await app.inject({ method: 'DELETE', url: '/procedures/spend_totals' })
    expect(res.statusCode).toBe(204)
    expect(dropProcedure).toHaveBeenCalledWith({ schema: 'dbo', name: 'spend_totals' })
    expect(live.defs.has('spend_totals')).toBe(false)
    expect(rowsOf(MANAGED_TABLE)[0].dropped_at).toBeInstanceOf(Date)
    expect(rowsOf(MANAGED_TABLE)[0].deployed_hash).toBeNull()
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
    expect(actions()).toEqual([
      expect.objectContaining({ action: 'procedure-drop', item: 'spend_totals' })
    ])
  })

  it('DELETE of an unmanaged live proc adopts it first, so the drop travels', async () => {
    live.defs.set('spend_totals', V1)
    const res = await app.inject({ method: 'DELETE', url: '/procedures/spend_totals' })
    expect(res.statusCode).toBe(204)
    expect(rowsOf(VERSIONS_TABLE).map((v) => v.version)).toEqual([1])
    expect(rowsOf(MANAGED_TABLE)[0].dropped_at).toBeInstanceOf(Date)
    expect(live.defs.has('spend_totals')).toBe(false)
    expect(actions().map((a) => a.action)).toEqual(['procedure-adopt', 'procedure-drop'])
  })

  it('DELETE of a name neither live nor in config is 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/procedures/nothing_here' })
    expect(res.statusCode).toBe(404)
  })

  it('a drop the database refused leaves config as it was (400 DROP_FAILED)', async () => {
    await put('spend_totals', { definition: V1, create: true })
    vi.mocked(dropProcedure).mockRejectedValueOnce(
      new Error('Lock request time out period exceeded.')
    )
    const res = await app.inject({ method: 'DELETE', url: '/procedures/spend_totals' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'DROP_FAILED' })
    expect(rowsOf(MANAGED_TABLE)[0].dropped_at).toBeNull()
    expect(live.defs.has('spend_totals')).toBe(true)
  })
})

describe('versions and restore', () => {
  it('restore of version 1 after a drop brings it back and deploys', async () => {
    await put('spend_totals', { definition: V1, create: true })
    await put('spend_totals', { definition: V2 })
    await app.inject({ method: 'DELETE', url: '/procedures/spend_totals' })
    expect(live.defs.has('spend_totals')).toBe(false)
    vi.mocked(logActivity).mockClear()

    const list = await app.inject({ method: 'GET', url: '/procedures/spend_totals/versions' })
    expect(list.json().data.map((v: { version: number }) => v.version)).toEqual([2, 1])
    const one = await app.inject({ method: 'GET', url: '/procedures/spend_totals/versions/1' })
    expect(one.json().data).toMatchObject({
      version: 1,
      body: 'CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1'
    })

    const res = await app.inject({
      method: 'POST',
      url: '/procedures/spend_totals/versions/1/restore',
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { version: 3, deployed: { action: 'created' } } })
    expect(live.defs.get('spend_totals')).toBe('CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1')
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({ version: 3, dropped_at: null })
    expect(rowsOf(VERSIONS_TABLE).find((v) => v.version === 3)?.note).toBe('Restored version 1')
    expect(actions()).toEqual([
      expect.objectContaining({
        action: 'procedure-restore',
        comment: 'v3 · Restored version 1'
      })
    ])
  })

  it('restore with a stale base_hash is 409 and deploys nothing', async () => {
    await put('spend_totals', { definition: V1, create: true })
    await put('spend_totals', { definition: V2 })
    vi.mocked(deployProcedure).mockClear()
    const res = await app.inject({
      method: 'POST',
      url: '/procedures/spend_totals/versions/1/restore',
      payload: { base_hash: procBodyHash(V1) }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'PROC_STALE' })
    expect(deployProcedure).not.toHaveBeenCalled()
  })

  it('an unknown version is 404 and a bad one 400', async () => {
    await put('spend_totals', { definition: V1, create: true })
    expect(
      (await app.inject({ method: 'GET', url: '/procedures/spend_totals/versions/9' })).statusCode
    ).toBe(404)
    expect(
      (await app.inject({ method: 'GET', url: '/procedures/spend_totals/versions/x' })).statusCode
    ).toBe(400)
  })
})

describe('adopt and deploy', () => {
  it('adopt stores the live text as version 1', async () => {
    live.defs.set('spend_totals', V1)
    const res = await app.inject({
      method: 'POST',
      url: '/procedures/spend_totals/adopt',
      payload: { note: 'Taking it over' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { version: 1, unchanged: false } })
    expect(rowsOf(VERSIONS_TABLE)[0]).toMatchObject({ note: 'Taking it over' })
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(actions()).toEqual([
      expect.objectContaining({ action: 'procedure-adopt', comment: 'v1 · Taking it over' })
    ])
  })

  it('adopt of a managed proc is 409 PROC_ALREADY_MANAGED unless keep_live=1 (R2)', async () => {
    await put('spend_totals', { definition: V1, create: true })
    live.defs.set('spend_totals', V2) // someone changed it in the database
    const refused = await app.inject({ method: 'POST', url: '/procedures/spend_totals/adopt' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'PROC_ALREADY_MANAGED' })
    const kept = await app.inject({
      method: 'POST',
      url: '/procedures/spend_totals/adopt?keep_live=1'
    })
    expect(kept.statusCode).toBe(200)
    expect(kept.json()).toEqual({ data: { version: 2, unchanged: false } })
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({ body: V2, version: 2 })
    expect(rowsOf(MANAGED_TABLE)[0].deployed_hash).toBe(procBodyHash(V2))
  })

  it('deploy puts the config body back over a drifted live proc', async () => {
    await put('spend_totals', { definition: V1, create: true })
    live.defs.set('spend_totals', V2)
    vi.mocked(logActivity).mockClear()
    const res = await app.inject({ method: 'POST', url: '/procedures/spend_totals/deploy' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { name: 'spend_totals', action: 'altered' } })
    expect(live.defs.get('spend_totals')).toBe('CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1')
    expect(actions()).toEqual([
      expect.objectContaining({ action: 'procedure-deploy-config', comment: 'v1 · altered' })
    ])
  })

  it('deploy of a name config does not hold is 404', async () => {
    live.defs.set('spend_totals', V1)
    const res = await app.inject({ method: 'POST', url: '/procedures/spend_totals/deploy' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'PROC_NOT_FOUND' })
  })

  it('adopt, deploy, versions and restore all refuse an import-owned name with 409', async () => {
    seedRow(IMPORTS, {
      key: 'invoices',
      procedure: 'import_invoices',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 1'
    })
    live.defs.set('import_invoices', 'CREATE PROCEDURE import_invoices AS SELECT 1')
    const calls = [
      { method: 'POST' as const, url: '/procedures/import_invoices/adopt' },
      { method: 'POST' as const, url: '/procedures/import_invoices/deploy' },
      { method: 'DELETE' as const, url: '/procedures/import_invoices' },
      { method: 'GET' as const, url: '/procedures/import_invoices/versions' },
      { method: 'GET' as const, url: '/procedures/import_invoices/versions/1' },
      { method: 'POST' as const, url: '/procedures/import_invoices/versions/1/restore' }
    ]
    for (const c of calls) {
      const res = await app.inject({ ...c, payload: c.method === 'POST' ? {} : undefined })
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(409)
      expect(res.json()).toMatchObject({ code: 'APP_MANAGED', definition: 'invoices' })
    }
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(dropProcedure).not.toHaveBeenCalled()
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(0)
  })
})

describe('reads', () => {
  it('GET / lists a config-only dropped proc with live:false and status dropped', async () => {
    await put('spend_totals', { definition: V1, create: true })
    await app.inject({ method: 'DELETE', url: '/procedures/spend_totals' })
    live.defs.set('legacy_proc', 'CREATE PROCEDURE legacy_proc AS SELECT 1')
    seedRow(IMPORTS, {
      key: 'invoices',
      procedure: 'import_invoices',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 1'
    })
    live.defs.set('import_invoices', 'CREATE PROCEDURE import_invoices AS SELECT 1')
    await put('drifty', { definition: 'CREATE PROCEDURE drifty AS SELECT 1', create: true })
    live.defs.set('drifty', 'CREATE PROCEDURE drifty AS SELECT 99')

    const res = await app.inject({ method: 'GET', url: '/procedures' })
    expect(res.statusCode).toBe(200)
    const rows = res.json().data as Array<Record<string, any>>
    expect(rows.map((r) => r.name)).toEqual([
      'drifty',
      'import_invoices',
      'legacy_proc',
      'spend_totals'
    ])
    const by = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(by.spend_totals).toMatchObject({
      live: false,
      created: null,
      modified: null,
      bytes: 0,
      param_count: 0,
      managed: { kind: 'managed', status: 'dropped', version: 1, owner: null }
    })
    expect(by.legacy_proc).toMatchObject({ live: true, managed: null })
    expect(by.import_invoices).toMatchObject({
      live: true,
      managed: { kind: 'import', key: 'invoices' }
    })
    expect(by.drifty.managed).toMatchObject({ kind: 'managed', status: 'drifted' })
  })

  it('GET /:name answers a not-deployed managed proc from config (definition null, config set)', async () => {
    seedRow(MANAGED_TABLE, {
      name: 'spend_totals',
      body: 'CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1',
      body_hash: procBodyHash(V1),
      version: 4,
      deployed_hash: null,
      deployed_at: null,
      deployed_by: null,
      description: 'Totals',
      owner: 'efp-ops',
      updated_at: new Date('2026-10-02T00:00:00Z'),
      updated_by: 'u1',
      dropped_at: null
    })
    const res = await app.inject({ method: 'GET', url: '/procedures/spend_totals' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      name: 'spend_totals',
      created: null,
      modified: null,
      definition: null,
      live_hash: null,
      params: [],
      managed: { kind: 'managed', status: 'not-deployed', version: 4, owner: 'efp-ops' },
      config: {
        body: 'CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1',
        body_hash: procBodyHash(V1),
        version: 4,
        deployed_hash: null,
        dropped_at: null,
        owner: 'efp-ops',
        description: 'Totals',
        updated_by: 'u1'
      }
    })
  })

  it('GET /:name of an unmanaged live proc gives its live hash and no config', async () => {
    live.defs.set('legacy_proc', 'CREATE PROCEDURE legacy_proc AS SELECT 1')
    const res = await app.inject({ method: 'GET', url: '/procedures/legacy_proc' })
    expect(res.json().data).toMatchObject({
      definition: 'CREATE PROCEDURE legacy_proc AS SELECT 1',
      live_hash: procBodyHash('CREATE PROCEDURE legacy_proc AS SELECT 1'),
      managed: null,
      config: null
    })
    expect((await app.inject({ method: 'GET', url: '/procedures/nothing' })).statusCode).toBe(404)
  })

  it('registers the drift readiness check once', async () => {
    await build()
    expect(vi.mocked(registerReadinessCheck).mock.calls.length).toBe(1)
  })
})
