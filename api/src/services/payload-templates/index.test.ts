import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny in-memory stand-in for the two payload-template tables: object
// where() (null matches IS NULL like knex), orderBy, first, select, insert
// (unique key / (template_id, version) enforced), update → affected count.

type Row = Record<string, any>
const store = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, nextId: 1 }))

vi.mock('../../db/index.js', () => {
  const UNIQUE: Record<string, string[][]> = {
    nivaro_payload_templates: [['key']],
    nivaro_payload_template_versions: [['template_id', 'version']]
  }
  const builder = (table: string) => {
    const conds: Array<(r: Row) => boolean> = []
    let order: [string, string] | null = null
    const all = () => {
      store.tables[table] ??= []
      return store.tables[table]
    }
    const matched = () => {
      const rs = all().filter((r) => conds.every((c) => c(r)))
      if (order) {
        const [col, dir] = order
        rs.sort(
          (a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1)
        )
      }
      return rs
    }
    const b: Record<string, any> = {
      where(a: Record<string, unknown>) {
        for (const [k, v] of Object.entries(a)) conds.push((r) => (r[k] ?? null) === (v ?? null))
        return b
      },
      orderBy(col: string, dir = 'asc') {
        order = [col, dir]
        return b
      },
      async first() {
        const r = matched()[0]
        return r ? { ...r } : undefined
      },
      async select() {
        return matched().map((r) => ({ ...r }))
      },
      async insert(row: Row) {
        for (const cols of UNIQUE[table] ?? []) {
          if (all().some((r) => cols.every((c) => r[c] === row[c]))) {
            throw new Error(`Violation of UNIQUE KEY constraint on ${table}`)
          }
        }
        const id = store.nextId++
        all().push({ id, ...row })
        return [{ id }]
      },
      async update(patch: Row) {
        const rs = matched()
        for (const r of rs) Object.assign(r, patch)
        return rs.length
      }
    }
    return b
  }
  const db = Object.assign((t: string) => builder(t), {
    transaction: async (fn: (trx: unknown) => unknown) => fn(db)
  })
  return { db, resolveDb: () => db }
})
vi.mock('../activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { logActivity } = await import('../activity.js')
const svc = await import('./index.js')
const {
  PayloadTemplateError,
  bustPayloadTemplateCache,
  getTemplate,
  getVersion,
  hasNewerDefault,
  listVersions,
  publishDraft,
  registerPayloadTemplate,
  registeredDef,
  renderPayloadTemplate,
  resetToDefault,
  restoreVersion,
  saveDraft
} = svc

const USER = '11111111-1111-1111-1111-111111111111'
const T = 'nivaro_payload_templates'
const V = 'nivaro_payload_template_versions'

const spec = (path: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    fields: [
      {
        id: 'f1',
        key: 'status',
        type: 'text',
        include: 'always',
        value: { source: 'path', path },
        ...extra
      }
    ]
  })

const def = (body = spec('record.status')) => ({
  key: 'mwf-workflow-status',
  label: 'MWF workflow status',
  external_api: 'MWF',
  endpoint_path: '/update_workflow.php',
  collection: 'workflows',
  default: { mode: 'map' as const, body },
  locked_keys: ['status']
})

const noSecrets = { secretNames: async () => undefined }

beforeEach(() => {
  store.tables = {}
  store.nextId = 1
  bustPayloadTemplateCache()
  vi.mocked(logActivity).mockClear()
})

describe('registerPayloadTemplate', () => {
  it('register seeds once and never overwrites a published edit', async () => {
    await registerPayloadTemplate('efp-ops', def())
    expect(store.tables[T]).toHaveLength(1)
    const seeded = store.tables[T][0]
    expect(seeded.published_version).toBe(1)
    expect(seeded.draft_body).toBe(seeded.published_body)
    expect(seeded.owner).toBe('efp-ops')
    expect(store.tables[V]).toHaveLength(1)
    expect(store.tables[V][0].note).toBe('Seeded from efp-ops')

    const edited = spec('record.label')
    const saved = await saveDraft(
      'mwf-workflow-status',
      { mode: 'map', body: edited, base_rev: 1 },
      USER
    )
    expect(saved).toEqual({ ok: true, rev: 2 })
    expect(await publishDraft('mwf-workflow-status', { base_rev: 2, note: 'edit' }, USER)).toEqual({
      ok: true,
      version: 2
    })

    await registerPayloadTemplate('efp-ops', def())
    const row = await getTemplate('mwf-workflow-status')
    expect(store.tables[T]).toHaveLength(1)
    expect(row?.published_body).toBe(edited)
    expect(row?.draft_body).toBe(edited)
    expect(row?.published_version).toBe(2)
    expect(store.tables[V]).toHaveLength(2)
  })

  it('register with a changed default sets hasNewerDefault', async () => {
    await registerPayloadTemplate('efp-ops', def())
    let row = await getTemplate('mwf-workflow-status')
    expect(row && hasNewerDefault(row)).toBe(false)

    const newer = spec('record.status_label')
    await registerPayloadTemplate('efp-ops', def(newer))
    row = await getTemplate('mwf-workflow-status')
    expect(row && hasNewerDefault(row)).toBe(true)
    expect(row?.published_body).toBe(spec('record.status'))
    expect(row?.draft_body).toBe(spec('record.status'))
    expect(registeredDef('mwf-workflow-status')?.default.body).toBe(newer)
  })

  it('refuses a bad def before touching the database', async () => {
    await expect(
      registerPayloadTemplate('efp-ops', { ...def(), key: 'Bad Key' })
    ).rejects.toBeInstanceOf(PayloadTemplateError)
    await expect(registerPayloadTemplate('efp-ops', def('{not json'))).rejects.toMatchObject({
      code: 'invalid'
    })
    expect(store.tables[T] ?? []).toHaveLength(0)
    expect(registeredDef('bad-key')).toBeNull()
  })

  it('keeps locked_keys parsed on the row', async () => {
    await registerPayloadTemplate('efp-ops', def())
    expect(typeof store.tables[T][0].locked_keys).toBe('string')
    expect((await getTemplate('mwf-workflow-status'))?.locked_keys).toEqual(['status'])
  })
})

describe('draft and publish', () => {
  it('publish writes a version row and bumps published_version', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const body = spec('record.label')
    await saveDraft('mwf-workflow-status', { mode: 'map', body, base_rev: 1 }, USER)
    const r = await publishDraft('mwf-workflow-status', { base_rev: 2, note: 'Use label' }, USER)
    expect(r).toEqual({ ok: true, version: 2 })

    const row = await getTemplate('mwf-workflow-status')
    expect(row?.published_version).toBe(2)
    expect(row?.published_body).toBe(body)
    expect(row?.published_by).toBe(USER)
    expect(row?.published_at).toBeInstanceOf(Date)
    expect(row?.draft_rev).toBe(2)

    const versions = await listVersions('mwf-workflow-status')
    expect(versions.map((v) => v.version)).toEqual([2, 1])
    expect(versions[0].note).toBe('Use label')
    expect('body' in versions[0]).toBe(false)
    expect((await getVersion('mwf-workflow-status', 2))?.body).toBe(body)
    expect(await getVersion('mwf-workflow-status', 9)).toBeNull()

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payload-template-publish',
        user: USER,
        collection: T,
        item: 'mwf-workflow-status'
      })
    )
  })

  it('stale base_rev returns 409 and leaves the row untouched', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const first = spec('record.a')
    expect(
      await saveDraft('mwf-workflow-status', { mode: 'map', body: first, base_rev: 1 }, USER)
    ).toEqual({ ok: true, rev: 2 })
    const before = JSON.stringify(store.tables[T][0])

    const stale = await saveDraft(
      'mwf-workflow-status',
      { mode: 'map', body: spec('record.b'), base_rev: 1 },
      'other-user'
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error('expected stale')
    expect(stale.current.draft_rev).toBe(2)
    expect(stale.current.draft_body).toBe(first)
    expect(JSON.stringify(store.tables[T][0])).toBe(before)

    const pub = await publishDraft('mwf-workflow-status', { base_rev: 1, note: 'late' }, USER)
    expect(pub.ok).toBe(false)
    if (pub.ok) throw new Error('expected stale')
    expect(pub.current.draft_rev).toBe(2)
    expect(JSON.stringify(store.tables[T][0])).toBe(before)
    expect(store.tables[V]).toHaveLength(1)
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('saveDraft refuses an invalid field map', async () => {
    await registerPayloadTemplate('efp-ops', def())
    await expect(
      saveDraft('mwf-workflow-status', { mode: 'map', body: '{"v":2}', base_rev: 1 }, USER)
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(store.tables[T][0].draft_rev).toBe(1)
  })

  it('saveDraft on an unknown key throws unknown_key', async () => {
    await expect(
      saveDraft('nope', { mode: 'map', body: spec('record.a'), base_rev: 1 }, USER)
    ).rejects.toMatchObject({ code: 'unknown_key' })
  })
})

describe('versions', () => {
  it('restore puts the version body into the draft', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const v2 = spec('record.label')
    await saveDraft('mwf-workflow-status', { mode: 'map', body: v2, base_rev: 1 }, USER)
    await publishDraft('mwf-workflow-status', { base_rev: 2, note: 'v2' }, USER)

    expect(await restoreVersion('mwf-workflow-status', 1, USER)).toEqual({ rev: 3 })
    const row = await getTemplate('mwf-workflow-status')
    expect(row?.draft_body).toBe(spec('record.status'))
    expect(row?.draft_rev).toBe(3)
    expect(row?.draft_updated_by).toBe(USER)
    expect(row?.published_body).toBe(v2)
    expect(row?.published_version).toBe(2)
    expect(await restoreVersion('mwf-workflow-status', 42, USER)).toBeNull()
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payload-template-restore' })
    )
  })

  it('reset puts the registered default into the draft and clears the newer-default flag', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const newer = spec('record.newer')
    await registerPayloadTemplate('efp-ops', def(newer))
    expect(await resetToDefault('mwf-workflow-status', USER)).toEqual({ rev: 2 })
    const row = await getTemplate('mwf-workflow-status')
    expect(row?.draft_body).toBe(newer)
    expect(row?.published_body).toBe(spec('record.status'))
    expect(row && hasNewerDefault(row)).toBe(false)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payload-template-reset' })
    )
  })
})

describe('renderPayloadTemplate', () => {
  it('renderPayloadTemplate uses published, not draft', async () => {
    await registerPayloadTemplate('efp-ops', def())
    await saveDraft(
      'mwf-workflow-status',
      { mode: 'map', body: spec('record.label'), base_rev: 1 },
      USER
    )
    const scope = { record: { status: 'Approved', label: 'Draft label' } }
    const pub = await renderPayloadTemplate('mwf-workflow-status', scope, noSecrets)
    expect(pub.body).toEqual({ status: 'Approved' })
    expect(pub.version).toBe(1)

    const draft = await renderPayloadTemplate('mwf-workflow-status', scope, {
      draft: true,
      ...noSecrets
    })
    expect(draft.body).toEqual({ status: 'Draft label' })
    expect(draft.version).toBeNull()

    const unsaved = await renderPayloadTemplate('mwf-workflow-status', scope, {
      draftBody: { mode: 'code', body: '{"status": "{{ record.status | upcase }}"}' },
      ...noSecrets
    })
    expect(unsaved.body).toEqual({ status: 'APPROVED' })
  })

  it('a publish replaces the cached published body', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const scope = { record: { status: 'Approved', label: 'L' } }
    expect((await renderPayloadTemplate('mwf-workflow-status', scope, noSecrets)).body).toEqual({
      status: 'Approved'
    })
    await saveDraft(
      'mwf-workflow-status',
      { mode: 'map', body: spec('record.label'), base_rev: 1 },
      USER
    )
    await publishDraft('mwf-workflow-status', { base_rev: 2, note: 'v2' }, USER)
    const r = await renderPayloadTemplate('mwf-workflow-status', scope, noSecrets)
    expect(r.body).toEqual({ status: 'L' })
    expect(r.version).toBe(2)
  })

  it('unpublished key throws PayloadTemplateError with the exact message', async () => {
    store.tables[T] = [
      {
        id: 7,
        key: 'mwf-ir-order',
        label: 'MWF IR order',
        collection: 'inventory_request',
        draft_mode: 'map',
        draft_body: spec('record.status'),
        draft_rev: 1,
        published_mode: null,
        published_body: null,
        published_version: null
      }
    ]
    const err = await renderPayloadTemplate('mwf-ir-order', {}, noSecrets).catch((e) => e)
    expect(err).toBeInstanceOf(PayloadTemplateError)
    expect(err.code).toBe('unpublished')
    expect(err.message).toBe("Payload template 'mwf-ir-order' has no published version")
    expect(err.problems).toEqual([])
  })

  it('unknown key throws unknown_key', async () => {
    const err = await renderPayloadTemplate('missing', {}, noSecrets).catch((e) => e)
    expect(err).toBeInstanceOf(PayloadTemplateError)
    expect(err.code).toBe('unknown_key')
    expect(err.message).toBe("Payload template 'missing' does not exist")
  })

  it('blocking problems on a published render throw with the problems; a draft render returns them', async () => {
    await registerPayloadTemplate(
      'efp-ops',
      def(spec('record.status', { rules: { required: true } }))
    )
    const err = await renderPayloadTemplate('mwf-workflow-status', { record: {} }, noSecrets).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(PayloadTemplateError)
    expect(err.code).toBe('invalid')
    expect(err.message).toContain("Payload template 'mwf-workflow-status'")
    expect(err.problems.length).toBeGreaterThan(0)

    const draft = await renderPayloadTemplate(
      'mwf-workflow-status',
      { record: {} },
      { draft: true, ...noSecrets }
    )
    expect(draft.problems.some((p) => p.severity === 'error')).toBe(true)
  })

  it('asks the secret resolver for the template API and passes the names on', async () => {
    const body = JSON.stringify({
      v: 1,
      fields: [
        {
          id: 't',
          key: 'token',
          type: 'text',
          include: 'always',
          value: { source: 'secret', name: 'token' }
        }
      ]
    })
    await registerPayloadTemplate('efp-ops', { ...def(body), locked_keys: [] })
    const resolver = vi.fn(async () => [] as string[])
    const r = await renderPayloadTemplate(
      'mwf-workflow-status',
      {},
      {
        draft: true,
        secretNames: resolver
      }
    )
    expect(resolver).toHaveBeenCalledWith('MWF')
    expect(r.problems.some((p) => /token/.test(p.message))).toBe(true)
  })
})
