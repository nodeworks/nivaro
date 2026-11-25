import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24: the template library and the template a creation installs. Runs on an
// in-memory SQLite with the real migration 571 tables.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/571_hub_app_templates.js')
const lib = await import('../../../services/hub/templates/library.js')
const choice = await import('../../../services/hub/templates/choice.js')

function blueprint(name = 'Assets', collections = ['assets', 'asset_moves']) {
  return {
    type: 'nivaro-blueprint',
    version: 1,
    name,
    exported_at: '2026-11-20T00:00:00.000Z',
    collections: collections.map((c) => ({ meta: { collection: c }, fields: [{ field: 'id' }] })),
    relations: [],
    workflows: [{ template: { id: 'w' }, states: [], transitions: [], bindings: [] }],
    layouts: [],
    queues: [],
    rules: []
  }
}

beforeAll(async () => {
  await up(db)
  await up(db) // guarded: a second run is a no-op
})
afterAll(async () => {
  await db.destroy()
})
beforeEach(async () => {
  await db(lib.TEMPLATE_INSTALLS).del()
  await db(lib.TEMPLATES).del()
})

describe('migration 571', () => {
  it('creates both tables with their columns', async () => {
    const cols = Object.keys(await db(lib.TEMPLATES).columnInfo())
    for (const c of [
      'name',
      'version',
      'description',
      'bundle',
      'digest',
      'manifest',
      'archived_at'
    ])
      expect(cols).toContain(c)
    const icols = Object.keys(await db(lib.TEMPLATE_INSTALLS).columnInfo())
    for (const c of ['app_id', 'environment_id', 'template_id', 'status', 'note', 'report'])
      expect(icols).toContain(c)
  })
})

describe('packageUpload', () => {
  it('wraps a bare blueprint with this template’s own manifest', () => {
    const p = lib.packageUpload({ bundle: blueprint(), version: '2.1.0', description: ' Hi ' })
    expect(p.name).toBe('Assets')
    expect(p.version).toBe('2.1.0')
    expect(p.pkg.type).toBe('nivaro-blueprint-package')
    expect(p.pkg.manifest).toMatchObject({
      name: 'Assets',
      version: '2.1.0',
      description: 'Hi',
      counts: { collections: 2, workflows: 1 }
    })
    expect(JSON.parse(p.json)).toEqual(p.pkg)
  })

  it('reads name / version / description from a published package when not given', () => {
    const pkg = {
      type: 'nivaro-blueprint-package',
      version: 1,
      manifest: {
        name: 'X',
        version: '0.9',
        description: 'From publish',
        nivaro_version: '0.3.210'
      },
      blueprint: blueprint('Inner')
    }
    const p = lib.packageUpload({ bundle: pkg })
    expect(p.version).toBe('0.9')
    expect(p.description).toBe('From publish')
    expect(p.pkg.manifest.nivaro_version).toBe('0.3.210')
  })

  it('refuses what is not a blueprint, an empty one and a bad version', () => {
    expect(() => lib.packageUpload({ bundle: { type: 'x' } })).toThrow(/not an App Blueprint/)
    expect(() => lib.packageUpload({ bundle: blueprint('A', []) })).toThrow(
      expect.objectContaining({ code: 'EMPTY_BUNDLE' })
    )
    expect(() => lib.packageUpload({ bundle: blueprint(), version: 'a b' })).toThrow(
      expect.objectContaining({ code: 'BAD_VERSION' })
    )
  })
})

describe('library', () => {
  it('upload → list (no bundle) → digest of the stored JSON; same name+version refused', async () => {
    const t = await lib.uploadTemplate({ bundle: blueprint(), version: '1.0.0' }, 'u1')
    expect(t).toMatchObject({ name: 'Assets', version: '1.0.0', archived: false, used: 0 })
    const listed = await lib.listTemplates()
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('bundle')
    const full = await lib.readTemplateBundle(t.id)
    expect(full?.digest).toBe(lib.templateDigest(JSON.stringify(full?.bundle)))
    await expect(
      lib.uploadTemplate({ bundle: blueprint(), version: '1.0.0' }, 'u1')
    ).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS', status: 409 })
    await expect(
      lib.uploadTemplate({ bundle: blueprint(), version: '1.1.0' }, 'u1')
    ).resolves.toMatchObject({ version: '1.1.0' })
  })

  it('archive hides it from the list; restore brings it back', async () => {
    const t = await lib.uploadTemplate({ bundle: blueprint() }, null)
    await lib.patchTemplate(t.id, { archived: true })
    expect(await lib.listTemplates()).toHaveLength(0)
    expect(await lib.listTemplates({ archived: true })).toHaveLength(1)
    await lib.patchTemplate(t.id, { archived: false, description: 'New words' })
    expect((await lib.listTemplates())[0].description).toBe('New words')
  })

  it('delete refused once a creation used it', async () => {
    const t = await lib.uploadTemplate({ bundle: blueprint() }, null)
    await choice.recordTemplateChoices(db, {
      input: { template_id: t.id },
      appId: 1,
      envIds: [10],
      by: null
    })
    await expect(lib.deleteTemplate(t.id)).rejects.toMatchObject({ code: 'TEMPLATE_IN_USE' })
    const unused = await lib.uploadTemplate({ bundle: blueprint('B') }, null)
    await lib.deleteTemplate(unused.id)
    expect(await lib.readTemplate(unused.id)).toBeNull()
  })
})

describe('template choice', () => {
  it('templateIdOf: none, a valid id, a bad one', () => {
    expect(choice.templateIdOf({})).toBeNull()
    expect(choice.templateIdOf({ template_id: null })).toBeNull()
    expect(choice.templateIdOf({ template_id: 4 })).toBe(4)
    expect(choice.templateIdOf({ template_id: '7' })).toBe(7)
    expect(choice.templateIdOf({ template_id: 'x' })).toBe(-1)
  })

  it('plan notes: none picked → nothing; unknown / archived → blocker', async () => {
    expect(await choice.templatePlanNotes({ version: '0.3.215' })).toEqual({
      blockers: [],
      lines: [],
      warnings: []
    })
    const unknown = await choice.templatePlanNotes({ template_id: 999, version: '0.3.215' })
    expect(unknown.blockers[0].code).toBe('TEMPLATE_UNKNOWN')
    const t = await lib.uploadTemplate({ bundle: blueprint() }, null)
    await lib.patchTemplate(t.id, { archived: true })
    const archived = await choice.templatePlanNotes({ template_id: t.id, version: '0.3.215' })
    expect(archived.blockers[0].code).toBe('TEMPLATE_UNKNOWN')
  })

  it('plan notes: an app version before 0.3.215 is refused; the line names the template', async () => {
    const t = await lib.uploadTemplate({ bundle: blueprint(), version: '3' }, null)
    const old = await choice.templatePlanNotes({ template_id: t.id, version: '0.3.214' })
    expect(old.blockers.map((b) => b.code)).toEqual(['TEMPLATE_APP_TOO_OLD'])
    const ok = await choice.templatePlanNotes({ template_id: t.id, version: '0.3.215' })
    expect(ok.blockers).toEqual([])
    expect(ok.lines[0]).toMatch(/Assets 3 into every environment/)
  })

  it('withTemplateNotes folds blockers into the plan (ok goes false)', () => {
    const plan = { ok: true, blockers: [], lines: ['a'], warnings: [] as string[] }
    const out = choice.withTemplateNotes(plan, {
      blockers: [{ code: 'TEMPLATE_UNKNOWN', text: 'x' }],
      lines: [],
      warnings: ['w']
    })
    expect(out).toMatchObject({ ok: false, lines: ['a'], warnings: ['w'] })
    expect(out.blockers).toHaveLength(1)
    expect(choice.withTemplateNotes(plan, { blockers: [], lines: [], warnings: [] })).toBe(plan)
  })

  it('recordTemplateChoices: one pending row per environment; an archived template refuses', async () => {
    const t = await lib.uploadTemplate({ bundle: blueprint() }, null)
    await choice.recordTemplateChoices(db, {
      input: { template_id: t.id },
      appId: 3,
      envIds: [31, 32],
      by: 'u'
    })
    expect(await choice.readTemplateInstall(31)).toMatchObject({
      app_id: 3,
      template_id: t.id,
      status: 'pending'
    })
    await choice.setTemplateInstall(32, { status: 'done', note: 'ok', report: { a: 1 } })
    expect(await choice.readTemplateInstall(32)).toMatchObject({
      status: 'done',
      note: 'ok',
      report: { a: 1 }
    })
    await choice.recordTemplateChoices(db, { input: {}, appId: 4, envIds: [41], by: null })
    expect(await choice.readTemplateInstall(41)).toBeNull()
    await lib.patchTemplate(t.id, { archived: true })
    await expect(
      choice.recordTemplateChoices(db, {
        input: { template_id: t.id },
        appId: 5,
        envIds: [51],
        by: null
      })
    ).rejects.toMatchObject({ code: 'TEMPLATE_UNKNOWN' })
  })
})
