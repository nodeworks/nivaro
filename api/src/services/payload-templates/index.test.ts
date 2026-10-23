import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny in-memory stand-in for the three payload-template tables: `name as alias`,
// leftJoin, object where() (null matches IS NULL like knex), orderBy, first/select with
// `a.*` / `a.col as x` projections, insert (unique keys enforced, identity ids), update →
// affected count, transactions that roll back on a throw.
// Hooks let a test race a seed, refuse draft updates, and count reads.

type Row = Record<string, any>
const store = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  nextId: 1,
  tenant: '',
  beforeInsert: null as null | ((table: string, row: Row) => void),
  refuseDraftUpdates: false,
  reads: {} as Record<string, number>,
  /** Rows "another process" committed mid-transaction: a rollback keeps them. */
  outside: [] as Array<[string, Row]>
}))

vi.mock('../tenant-rooms.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentTenantKey: () => store.tenant
}))

vi.mock('../../db/index.js', () => {
  const UNIQUE: Record<string, string[][]> = {
    nivaro_payload_templates: [['key']],
    nivaro_payload_template_versions: [['template_id', 'version']],
    nivaro_payload_template_drafts: [['template_id']]
  }
  const builder = (spec: string) => {
    const [table, alias] = spec.split(/\s+as\s+/)
    const conds: Array<(r: Row) => boolean> = []
    let order: [string, string] | null = null
    let join: { table: string; alias: string; left: string; right: string } | null = null
    const all = (t = table) => {
      store.tables[t] ??= []
      return store.tables[t]
    }
    // Joined views are flat copies keyed `alias.col`; plain views are the stored rows.
    const view = (): Row[] => {
      if (!join) return all()
      const j = join
      return all().map((r) => {
        const out: Row = {}
        for (const [k, v] of Object.entries(r)) out[`${alias}.${k}`] = v
        const lcol = j.left.split('.')[1]
        const rcol = j.right.split('.')[1]
        const hit = all(j.table).find((x) => x[rcol] === r[lcol])
        for (const [k, v] of Object.entries(hit ?? {})) out[`${j.alias}.${k}`] = v
        return out
      })
    }
    const matched = () => {
      const rs = view().filter((r) => conds.every((c) => c(r)))
      if (order) {
        const [col, dir] = order
        rs.sort(
          (a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1)
        )
      }
      return rs
    }
    const project = (r: Row, cols: string[]): Row => {
      if (!join || !cols.length) return { ...r }
      const out: Row = {}
      for (const c of cols) {
        const [src, as] = c.split(/\s+as\s+/)
        if (src.endsWith('.*')) {
          const p = src.slice(0, -1)
          for (const [k, v] of Object.entries(r)) if (k.startsWith(p)) out[k.slice(p.length)] = v
        } else out[as ?? src.split('.')[1]] = r[src] ?? null
      }
      return out
    }
    store.reads[spec] = (store.reads[spec] ?? 0) + 1
    const b: Record<string, any> = {
      leftJoin(other: string, left: string, right: string) {
        const [t, a] = other.split(/\s+as\s+/)
        join = { table: t, alias: a, left, right }
        return b
      },
      where(a: Record<string, unknown>) {
        for (const [k, v] of Object.entries(a)) conds.push((r) => (r[k] ?? null) === (v ?? null))
        return b
      },
      orderBy(col: string, dir = 'asc') {
        order = [col, dir]
        return b
      },
      async first(...cols: string[]) {
        const r = matched()[0]
        return r ? project(r, cols) : undefined
      },
      async select(...cols: string[]) {
        return matched().map((r) => project(r, cols))
      },
      async insert(row: Row) {
        store.beforeInsert?.(table, row)
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
        if (table === 'nivaro_payload_template_drafts' && store.refuseDraftUpdates) return 0
        const rs = matched()
        for (const r of rs) Object.assign(r, patch)
        return rs.length
      }
    }
    return b
  }
  const db = Object.assign((t: string) => builder(t), {
    // A throw rolls every table back, like a real transaction.
    transaction: async (fn: (trx: unknown) => unknown) => {
      const before = structuredClone(store.tables)
      try {
        return await fn(db)
      } catch (e) {
        store.tables = before
        for (const [t, r] of store.outside) {
          store.tables[t] ??= []
          store.tables[t].push(r)
        }
        throw e
      }
    }
  })
  return { db, resolveDb: () => db }
})
vi.mock('../activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { logActivity } = await import('../activity.js')
const svc = await import('./index.js')
const {
  MODE_CHANGE_MESSAGE,
  PayloadTemplateError,
  bustPayloadTemplateCache,
  getTemplate,
  getVersion,
  hasNewerDefault,
  listTemplates,
  listVersions,
  publishDraft,
  registerPayloadTemplate,
  registeredDef,
  renderPayloadTemplate,
  resetToDefault,
  restoreVersion,
  saveDraft,
  saveDraftLookups
} = svc

const USER = '11111111-1111-1111-1111-111111111111'
const T = 'nivaro_payload_templates'
const V = 'nivaro_payload_template_versions'
const D = 'nivaro_payload_template_drafts'
const KEY = 'mwf-workflow-status'

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
  key: KEY,
  label: 'MWF workflow status',
  external_api: 'MWF',
  endpoint_path: '/update_workflow.php',
  collection: 'workflows',
  default: { mode: 'map' as const, body },
  locked_keys: ['status']
})

const noSecrets = { secretNames: async () => undefined }
const snapshot = () => JSON.stringify([store.tables[T], store.tables[D], store.tables[V]])

beforeEach(() => {
  store.tables = {}
  store.nextId = 1
  store.tenant = ''
  store.beforeInsert = null
  store.refuseDraftUpdates = false
  store.reads = {}
  store.outside = []
  bustPayloadTemplateCache()
  vi.mocked(logActivity).mockClear()
})

describe('registerPayloadTemplate', () => {
  it('register seeds once and never overwrites a published edit', async () => {
    await registerPayloadTemplate('efp-ops', def())
    expect(store.tables[T]).toHaveLength(1)
    const seeded = store.tables[T][0]
    expect(seeded.published_version).toBe(1)
    expect(seeded.owner).toBe('efp-ops')
    expect('draft_body' in seeded).toBe(false)
    expect(store.tables[D]).toEqual([
      expect.objectContaining({ template_id: seeded.id, body: seeded.published_body, rev: 1 })
    ])
    expect(store.tables[V]).toHaveLength(1)
    expect(store.tables[V][0].note).toBe('Seeded from efp-ops')

    const edited = spec('record.label')
    const saved = await saveDraft(KEY, { mode: 'map', body: edited, base_rev: 1 }, USER)
    expect(saved).toEqual({ ok: true, rev: 2 })
    expect(await publishDraft(KEY, { base_rev: 2, note: 'edit' }, USER)).toEqual({
      ok: true,
      version: 2
    })

    await registerPayloadTemplate('efp-ops', def())
    const row = await getTemplate(KEY)
    expect(store.tables[T]).toHaveLength(1)
    expect(store.tables[D]).toHaveLength(1)
    expect(row?.published_body).toBe(edited)
    expect(row?.draft_body).toBe(edited)
    expect(row?.published_version).toBe(2)
    expect(store.tables[V]).toHaveLength(2)
  })

  it('register with a changed default sets hasNewerDefault', async () => {
    await registerPayloadTemplate('efp-ops', def())
    let row = await getTemplate(KEY)
    expect(row && hasNewerDefault(row)).toBe(false)

    const newer = spec('record.status_label')
    await registerPayloadTemplate('efp-ops', def(newer))
    row = await getTemplate(KEY)
    expect(row && hasNewerDefault(row)).toBe(true)
    expect(row?.published_body).toBe(spec('record.status'))
    expect(row?.draft_body).toBe(spec('record.status'))
    expect(registeredDef(KEY)?.default.body).toBe(newer)
  })

  it('a seed race keeps the row the other process inserted', async () => {
    const theirs = spec('record.theirs')
    store.beforeInsert = (table, row) => {
      if (table !== T || row.key !== KEY) return
      store.beforeInsert = null
      const committed = { ...row, id: 99, published_body: theirs, default_hash: 'x' }
      store.outside.push([T, committed])
      store.tables[T] ??= []
      store.tables[T].push(committed)
    }
    await expect(registerPayloadTemplate('efp-ops', def())).resolves.toBeUndefined()
    expect(store.tables[T]).toHaveLength(1)
    expect(store.tables[T][0].id).toBe(99)
    expect(store.tables[T][0].published_body).toBe(theirs)
    expect(store.tables[D] ?? []).toHaveLength(0)
    expect(store.tables[V] ?? []).toHaveLength(0)
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
    expect((await getTemplate(KEY))?.locked_keys).toEqual(['status'])
    expect((await listTemplates({ external_api: 'MWF' })).map((r) => r.key)).toEqual([KEY])
    expect(await listTemplates({ external_api: 'Other' })).toEqual([])
  })
})

describe('draft and publish', () => {
  it('publish writes a version row and bumps published_version', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const body = spec('record.label')
    await saveDraft(KEY, { mode: 'map', body, base_rev: 1 }, USER)
    const r = await publishDraft(KEY, { base_rev: 2, note: 'Use label' }, USER)
    expect(r).toEqual({ ok: true, version: 2 })

    const row = await getTemplate(KEY)
    expect(row?.published_version).toBe(2)
    expect(row?.published_body).toBe(body)
    expect(row?.published_by).toBe(USER)
    expect(row?.published_at).toBeInstanceOf(Date)
    expect(row?.draft_rev).toBe(2)

    const versions = await listVersions(KEY)
    expect(versions.map((v) => v.version)).toEqual([2, 1])
    expect(versions[0].note).toBe('Use label')
    expect('body' in versions[0]).toBe(false)
    expect((await getVersion(KEY, 2))?.body).toBe(body)
    expect(await getVersion(KEY, 9)).toBeNull()

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payload-template-publish',
        user: USER,
        collection: T,
        item: KEY
      })
    )
  })

  it('a draft save never writes the templates table', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const before = JSON.stringify(store.tables[T])
    await saveDraft(KEY, { mode: 'map', body: spec('record.a'), base_rev: 1 }, USER)
    expect(JSON.stringify(store.tables[T])).toBe(before)
    expect(store.tables[D][0]).toMatchObject({ rev: 2, updated_by: USER, body: spec('record.a') })
  })

  it('stale base_rev returns 409 and leaves the row untouched', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const first = spec('record.a')
    expect(await saveDraft(KEY, { mode: 'map', body: first, base_rev: 1 }, USER)).toEqual({
      ok: true,
      rev: 2
    })
    const before = snapshot()

    const stale = await saveDraft(
      KEY,
      { mode: 'map', body: spec('record.b'), base_rev: 1 },
      'other-user'
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error('expected stale')
    expect(stale.current.draft_rev).toBe(2)
    expect(stale.current.draft_body).toBe(first)
    expect(snapshot()).toBe(before)

    const pub = await publishDraft(KEY, { base_rev: 1, note: 'late' }, USER)
    expect(pub.ok).toBe(false)
    if (pub.ok) throw new Error('expected stale')
    expect(pub.current.draft_rev).toBe(2)
    expect(snapshot()).toBe(before)
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('base_published_version is checked inside the draft write: a publish since rolls it back', async () => {
    await registerPayloadTemplate('efp-ops', def())
    await saveDraft(KEY, { mode: 'map', body: spec('record.a'), base_rev: 1 }, USER)
    // Someone publishes v2 (draft rev 2) while this editor still holds v1.
    await publishDraft(KEY, { base_rev: 2, note: 'theirs' }, 'other-user')
    const before = snapshot()

    const stale = await saveDraft(
      KEY,
      { mode: 'map', body: spec('record.b'), base_rev: 2, base_published_version: 1 },
      USER
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error('expected stale')
    expect(stale.current.published_version).toBe(2)
    // The draft write that ran inside the transaction was rolled back.
    expect(snapshot()).toBe(before)
    const lk = await saveDraftLookups(
      KEY,
      { lookups: { a: { collection: 'x' } }, base_rev: 2, base_published_version: 1 },
      USER
    )
    expect(lk.ok).toBe(false)
    expect(snapshot()).toBe(before)

    // The version it saw → saved.
    expect(
      await saveDraft(
        KEY,
        { mode: 'map', body: spec('record.b'), base_rev: 2, base_published_version: 2 },
        USER
      )
    ).toEqual({ ok: true, rev: 3 })
  })

  it('a first draft row (base_rev 0) rolls back too when the published version moved', async () => {
    await registerPayloadTemplate('efp-ops', def())
    store.tables[D] = []
    const before = snapshot()
    const stale = await saveDraft(
      KEY,
      { mode: 'map', body: spec('record.x'), base_rev: 0, base_published_version: null },
      USER
    )
    expect(stale.ok).toBe(false)
    expect(snapshot()).toBe(before)
    expect(
      await saveDraft(
        KEY,
        { mode: 'map', body: spec('record.x'), base_rev: 0, base_published_version: 1 },
        USER
      )
    ).toEqual({ ok: true, rev: 1 })
    expect(store.tables[D]).toHaveLength(1)
    expect(store.tables[D][0].id).toEqual(expect.any(Number))
  })

  it('a template with no draft row takes base_rev 0 as its first save', async () => {
    await registerPayloadTemplate('efp-ops', def())
    store.tables[D] = []
    const row = await getTemplate(KEY)
    expect(row?.draft_rev).toBe(0)
    expect(row?.draft_body).toBe(row?.published_body)
    expect(
      await saveDraft(KEY, { mode: 'map', body: spec('record.x'), base_rev: 0 }, USER)
    ).toEqual({ ok: true, rev: 1 })
    const again = await saveDraft(KEY, { mode: 'map', body: spec('record.y'), base_rev: 0 }, USER)
    expect(again.ok).toBe(false)
    expect(store.tables[D]).toHaveLength(1)
    expect(store.tables[D][0].body).toBe(spec('record.x'))
  })

  it('saveDraft refuses a mode change; convert allows map → code only', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const liquid = '{"status": "{{ record.status }}"}'
    const err = await saveDraft(KEY, { mode: 'code', body: liquid, base_rev: 1 }, USER).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(PayloadTemplateError)
    expect(err.code).toBe('invalid')
    expect(err.message).toBe('Mode can only change through Convert to Liquid')
    expect(MODE_CHANGE_MESSAGE).toBe(err.message)
    expect(store.tables[D][0].rev).toBe(1)

    expect(
      await saveDraft(KEY, { mode: 'code', body: liquid, base_rev: 1 }, USER, { convert: true })
    ).toEqual({ ok: true, rev: 2 })
    await expect(
      saveDraft(KEY, { mode: 'map', body: spec('record.a'), base_rev: 2 }, USER, {
        convert: true
      })
    ).rejects.toMatchObject({ code: 'invalid', message: MODE_CHANGE_MESSAGE })
    expect(store.tables[D][0]).toMatchObject({ mode: 'code', rev: 2 })
  })

  it('saveDraft refuses an invalid field map', async () => {
    await registerPayloadTemplate('efp-ops', def())
    await expect(
      saveDraft(KEY, { mode: 'map', body: '{"v":2}', base_rev: 1 }, USER)
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(store.tables[D][0].rev).toBe(1)
  })

  it('a half-built draft saves; publishing it refuses with the errors', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const half = JSON.stringify({
      v: 1,
      fields: [
        {
          id: 'f1',
          key: 'status',
          type: 'text',
          include: 'always',
          value: { source: 'path', path: '' }
        },
        { id: 'f2', key: '', type: 'text', include: 'always' },
        {
          id: 'f3',
          key: 'lines',
          type: 'list',
          include: 'always',
          list: { source: '', item: 'line' },
          children: []
        }
      ]
    })
    expect(await saveDraft(KEY, { mode: 'map', body: half, base_rev: 1 }, USER)).toEqual({
      ok: true,
      rev: 2
    })
    const err = await publishDraft(KEY, { base_rev: 2, note: '' }, USER).catch((e) => e)
    expect(err).toMatchObject({ code: 'invalid' })
    expect(String(err.message)).toMatch(/path must be a path/)
    expect(String(err.message)).toMatch(/a list needs list.source/)
    expect((await getTemplate(KEY))?.published_version).toBe(1)
  })

  it('saveDraft on an unknown key throws unknown_key before checking the body', async () => {
    await expect(
      saveDraft('nope', { mode: 'map', body: '{not json', base_rev: 1 }, USER)
    ).rejects.toMatchObject({ code: 'unknown_key' })
  })
})

describe('draft lookups', () => {
  const LK = { wh: { collection: 'warehouses', filter: { site: '$record.site' } } }
  const LK2 = { region: { collection: 'regions' } }

  it('seeds the declared lookups as published, draft and v1', async () => {
    await registerPayloadTemplate('efp-ops', { ...def(), lookups: LK })
    const row = await getTemplate(KEY)
    expect(row?.lookups).toEqual(LK)
    expect(row?.draft_lookups).toEqual(LK)
    expect((await getVersion(KEY, 1))?.lookups).toEqual(LK)
  })

  it('lookups save to the draft under the rev guard; publish copies them live and into the version', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const stale = await saveDraftLookups(KEY, { lookups: LK, base_rev: 0 }, USER)
    expect(stale.ok).toBe(false)
    expect(await saveDraftLookups(KEY, { lookups: LK, base_rev: 1 }, USER)).toEqual({
      ok: true,
      rev: 2
    })
    let row = await getTemplate(KEY)
    expect(row?.draft_lookups).toEqual(LK)
    expect(row?.lookups).toBeNull()
    expect(row?.draft_body).toBe(spec('record.status'))
    // A body save keeps the draft lookups.
    await saveDraft(KEY, { mode: 'map', body: spec('record.label'), base_rev: 2 }, USER)
    expect((await getTemplate(KEY))?.draft_lookups).toEqual(LK)

    expect(await publishDraft(KEY, { base_rev: 3, note: 'lookups' }, USER)).toEqual({
      ok: true,
      version: 2
    })
    row = await getTemplate(KEY)
    expect(row?.lookups).toEqual(LK)
    expect((await getVersion(KEY, 2))?.lookups).toEqual(LK)
    expect((await getVersion(KEY, 1))?.lookups).toBeNull()
  })

  it('the first draft row starts from the published lookups', async () => {
    await registerPayloadTemplate('efp-ops', { ...def(), lookups: LK })
    store.tables[D] = []
    expect((await getTemplate(KEY))?.draft_rev).toBe(0)
    await saveDraft(KEY, { mode: 'map', body: spec('record.label'), base_rev: 0 }, USER)
    expect((await getTemplate(KEY))?.draft_lookups).toEqual(LK)
  })

  it('restore brings back the version lookups; reset brings back the declared ones', async () => {
    await registerPayloadTemplate('efp-ops', { ...def(), lookups: LK })
    await saveDraftLookups(KEY, { lookups: LK2, base_rev: 1 }, USER)
    await publishDraft(KEY, { base_rev: 2, note: 'v2' }, USER)
    expect((await getTemplate(KEY))?.lookups).toEqual(LK2)

    await restoreVersion(KEY, 1, USER)
    let row = await getTemplate(KEY)
    expect(row?.draft_lookups).toEqual(LK)
    expect(row?.lookups).toEqual(LK2)

    await saveDraftLookups(KEY, { lookups: null, base_rev: row?.draft_rev ?? 0 }, USER)
    await resetToDefault(KEY, USER)
    row = await getTemplate(KEY)
    expect(row?.draft_lookups).toEqual(LK)
  })

  it('registration never changes lookups a person published, nor the draft row; the banner says so', async () => {
    await registerPayloadTemplate('efp-ops', { ...def(), lookups: LK })
    await saveDraftLookups(KEY, { lookups: LK2, base_rev: 1 }, USER)
    await publishDraft(KEY, { base_rev: 2, note: 'v2' }, USER)
    await saveDraftLookups(KEY, { lookups: null, base_rev: 2 }, USER)
    const draftBefore = JSON.stringify(store.tables[D])
    const templatesBefore = JSON.stringify(store.tables[T])
    // Next boot: the registrar still declares LK.
    await registerPayloadTemplate('efp-ops', { ...def(), lookups: LK })
    const row = await getTemplate(KEY)
    expect(row?.lookups).toEqual(LK2)
    expect(row?.draft_lookups).toBeNull()
    expect(JSON.stringify(store.tables[D])).toBe(draftBefore)
    expect(JSON.stringify(store.tables[T])).toBe(templatesBefore)
    // The declared lookups differ from what is live: shown as a newer default.
    expect(hasNewerDefault(row as NonNullable<typeof row>)).toBe(true)
    // Reset to default (body + declared lookups) and publish clears it.
    const { rev } = await resetToDefault(KEY, USER)
    await publishDraft(KEY, { base_rev: rev, note: 'default' }, USER)
    const after = await getTemplate(KEY)
    expect(after?.lookups).toEqual(LK)
    expect(hasNewerDefault(after as NonNullable<typeof after>)).toBe(false)
  })

  it('registration follows changed declared lookups while the template still holds its seed', async () => {
    await registerPayloadTemplate('efp-ops', { ...def(), lookups: LK })
    // Next boot: the code now declares LK2; nobody ever published from the UI.
    await registerPayloadTemplate('efp-ops', { ...def(), lookups: LK2 })
    const row = await getTemplate(KEY)
    expect(row?.published_version).toBe(1)
    expect(row?.lookups).toEqual(LK2)
    // The draft row is never touched by registration.
    expect(row?.draft_lookups).toEqual(LK)
    expect(hasNewerDefault(row as NonNullable<typeof row>)).toBe(false)
  })
})

describe('versions', () => {
  it('restore puts the version body into the draft', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const v2 = spec('record.label')
    await saveDraft(KEY, { mode: 'map', body: v2, base_rev: 1 }, USER)
    await publishDraft(KEY, { base_rev: 2, note: 'v2' }, USER)

    store.reads = {}
    expect(await restoreVersion(KEY, 1, USER)).toEqual({ rev: 3 })
    expect(store.reads[`${T} as t`]).toBe(1)
    const row = await getTemplate(KEY)
    expect(row?.draft_body).toBe(spec('record.status'))
    expect(row?.draft_rev).toBe(3)
    expect(row?.draft_updated_by).toBe(USER)
    expect(row?.published_body).toBe(v2)
    expect(row?.published_version).toBe(2)
    expect(await restoreVersion(KEY, 42, USER)).toBeNull()
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payload-template-restore' })
    )
  })

  it('reset fills the draft; the newer-default flag clears only when that default is published', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const newer = spec('record.newer')
    await registerPayloadTemplate('efp-ops', def(newer))
    expect(await resetToDefault(KEY, USER)).toEqual({ rev: 2 })
    let row = await getTemplate(KEY)
    expect(row?.draft_body).toBe(newer)
    expect(row?.published_body).toBe(spec('record.status'))
    expect(row && hasNewerDefault(row)).toBe(true)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payload-template-reset' })
    )

    await publishDraft(KEY, { base_rev: 2, note: 'take the new default' }, USER)
    row = await getTemplate(KEY)
    expect(row && hasNewerDefault(row)).toBe(false)
  })

  it('publishing a body that is not the default leaves the baseline alone', async () => {
    await registerPayloadTemplate('efp-ops', def())
    await registerPayloadTemplate('efp-ops', def(spec('record.newer')))
    await saveDraft(KEY, { mode: 'map', body: spec('record.mine'), base_rev: 1 }, USER)
    await publishDraft(KEY, { base_rev: 2, note: 'mine' }, USER)
    const row = await getTemplate(KEY)
    expect(row && hasNewerDefault(row)).toBe(true)
  })

  it('a draft that keeps changing makes restore give up with a conflict', async () => {
    await registerPayloadTemplate('efp-ops', def())
    store.refuseDraftUpdates = true
    const err = await restoreVersion(KEY, 1, USER).catch((e) => e)
    expect(err).toBeInstanceOf(PayloadTemplateError)
    expect(err.code).toBe('conflict')
    expect(logActivity).not.toHaveBeenCalled()
  })
})

describe('renderPayloadTemplate', () => {
  it('renderPayloadTemplate uses published, not draft', async () => {
    await registerPayloadTemplate('efp-ops', def())
    await saveDraft(KEY, { mode: 'map', body: spec('record.label'), base_rev: 1 }, USER)
    const scope = { record: { status: 'Approved', label: 'Draft label' } }
    const pub = await renderPayloadTemplate(KEY, scope, noSecrets)
    expect(pub.body).toEqual({ status: 'Approved' })
    expect(pub.version).toBe(1)

    const draft = await renderPayloadTemplate(KEY, scope, { draft: true, ...noSecrets })
    expect(draft.body).toEqual({ status: 'Draft label' })
    expect(draft.version).toBeNull()

    const unsaved = await renderPayloadTemplate(KEY, scope, {
      draftBody: { mode: 'code', body: '{"status": "{{ record.status | upcase }}"}' },
      ...noSecrets
    })
    expect(unsaved.body).toEqual({ status: 'APPROVED' })
  })

  it('a publish replaces the cached published body', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const scope = { record: { status: 'Approved', label: 'L' } }
    expect((await renderPayloadTemplate(KEY, scope, noSecrets)).body).toEqual({
      status: 'Approved'
    })
    await saveDraft(KEY, { mode: 'map', body: spec('record.label'), base_rev: 1 }, USER)
    await publishDraft(KEY, { base_rev: 2, note: 'v2' }, USER)
    const r = await renderPayloadTemplate(KEY, scope, noSecrets)
    expect(r.body).toEqual({ status: 'L' })
    expect(r.version).toBe(2)
  })

  it('a local publish clears only this tenant; the epoch bust clears every tenant', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const scope = { record: { status: 'Approved', label: 'L' } }
    store.tenant = 'a'
    expect((await renderPayloadTemplate(KEY, scope, noSecrets)).version).toBe(1)
    store.tenant = 'b'
    expect((await renderPayloadTemplate(KEY, scope, noSecrets)).version).toBe(1)
    await saveDraft(KEY, { mode: 'map', body: spec('record.label'), base_rev: 1 }, USER)
    await publishDraft(KEY, { base_rev: 2, note: 'v2' }, USER)
    expect((await renderPayloadTemplate(KEY, scope, noSecrets)).version).toBe(2)
    store.tenant = 'a'
    expect((await renderPayloadTemplate(KEY, scope, noSecrets)).version).toBe(1)
    bustPayloadTemplateCache()
    expect((await renderPayloadTemplate(KEY, scope, noSecrets)).version).toBe(2)
  })

  it('unpublished key throws PayloadTemplateError with the exact message', async () => {
    store.tables[T] = [
      {
        id: 7,
        key: 'mwf-ir-order',
        label: 'MWF IR order',
        collection: 'inventory_request',
        published_mode: null,
        published_body: null,
        published_version: null
      }
    ]
    store.tables[D] = [{ template_id: 7, mode: 'map', body: spec('record.status'), rev: 1 }]
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
    const err = await renderPayloadTemplate(KEY, { record: {} }, noSecrets).catch((e) => e)
    expect(err).toBeInstanceOf(PayloadTemplateError)
    expect(err.code).toBe('invalid')
    expect(err.message).toContain(`Payload template '${KEY}'`)
    expect(err.problems.length).toBeGreaterThan(0)

    const draft = await renderPayloadTemplate(KEY, { record: {} }, { draft: true, ...noSecrets })
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
    const r = await renderPayloadTemplate(KEY, {}, { draft: true, secretNames: resolver })
    expect(resolver).toHaveBeenCalledWith('MWF')
    expect(r.problems.some((p) => /token/.test(p.message))).toBe(true)
  })
})

describe('installTemplateDraft (blueprint install)', () => {
  const bundle = (body = spec('record.label'), extra: Record<string, unknown> = {}) => ({
    key: KEY,
    label: 'MWF workflow status',
    description: null,
    external_api: 'MWF',
    endpoint_path: '/update_workflow.php',
    collection: 'workflows',
    mode: 'map' as const,
    body,
    locked_keys: ['status'],
    lookups: { wh: { collection: 'warehouses' } },
    ...extra
  })

  it('creates a missing template unpublished, with the body as its draft', async () => {
    const out = await svc.installTemplateDraft(bundle(), USER, 'Draft installed from blueprint X')
    expect(out).toBe('created')
    const row = await getTemplate(KEY)
    expect(row?.published_version).toBeNull()
    expect(row?.published_body).toBeNull()
    expect(row?.draft_body).toBe(spec('record.label'))
    expect(row?.draft_rev).toBe(1)
    expect(row?.owner).toBeNull()
    expect(row?.locked_keys).toEqual(['status'])
    // Nothing is published, lookups included: the bundle's lookups are the draft's.
    expect(row?.lookups).toBeNull()
    expect(row?.draft_lookups).toEqual({ wh: { collection: 'warehouses' } })
    expect(store.tables[V] ?? []).toHaveLength(0)
    // Senders refuse it until someone publishes it here.
    await expect(renderPayloadTemplate(KEY, { record: {} }, noSecrets)).rejects.toThrow(
      "Payload template 'mwf-workflow-status' has no published version"
    )
  })

  it('never overwrites a published template: only its draft changes', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const before = await getTemplate(KEY)
    const out = await svc.installTemplateDraft(bundle(spec('record.other')), USER)
    expect(out).toBe('drafted')
    const row = await getTemplate(KEY)
    expect(row?.published_body).toBe(before?.published_body)
    expect(row?.published_version).toBe(1)
    expect(row?.draft_body).toBe(spec('record.other'))
    expect(row?.draft_rev).toBe((before?.draft_rev ?? 0) + 1)
    expect(row?.owner).toBe('efp-ops')
    expect(store.tables[V]).toHaveLength(1)
    // Installing the same body again writes nothing.
    expect(await svc.installTemplateDraft(bundle(spec('record.other')), USER)).toBe('unchanged')
    expect((await getTemplate(KEY))?.draft_rev).toBe(row?.draft_rev)
  })

  it('keeps the mode lock: map → code allowed, code → map refused', async () => {
    await registerPayloadTemplate('efp-ops', def())
    const code = '{"status":"{{ record.status }}"}'
    expect(await svc.installTemplateDraft(bundle(code, { mode: 'code' }), USER)).toBe('drafted')
    await expect(svc.installTemplateDraft(bundle(), USER)).rejects.toThrow(MODE_CHANGE_MESSAGE)
  })

  it('refuses an invalid bundle before touching the database', async () => {
    await expect(svc.installTemplateDraft(bundle('{"v":1,"fields":"no"}'), USER)).rejects.toThrow(
      PayloadTemplateError
    )
    await expect(
      svc.installTemplateDraft(bundle(undefined, { key: 'Bad Key' }), USER)
    ).rejects.toThrow(/key must be/)
    await expect(
      svc.installTemplateDraft(bundle(undefined, { collection: 'orders; drop' }), USER)
    ).rejects.toThrow(/collection must be/)
    expect(store.tables[T] ?? []).toHaveLength(0)
  })

  it('a failed activity log after the create still reports created', async () => {
    vi.mocked(logActivity).mockRejectedValueOnce(new Error('activity down'))
    await expect(svc.installTemplateDraft(bundle(), USER)).resolves.toBe('created')
    expect(store.tables[T]).toHaveLength(1)
  })
})
