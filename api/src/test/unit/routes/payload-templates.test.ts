import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Route harness for /payload-templates. The template service is replaced by an
// in-memory stand-in with the same signatures (drafts move tables in a later
// round; the routes only ever go through the service). Rendering is real
// (render.ts), so preview values are the evaluator's. The routes' own reads
// (transitions, states, records, create/delete) go to a loose knex stand-in.

type Row = Record<string, unknown>

const fake = vi.hoisted(() => {
  process.env.PAYLOAD_EDIT_WARNING = 'Payload templates here are replaced every night.'
  const tables: Record<string, Row[]> = {}
  let nextId = 900
  const like = (value: unknown, pattern: string) => {
    const re = new RegExp(
      `^${pattern
        .split('%')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
      's'
    )
    return re.test(String(value ?? ''))
  }
  const reads: string[] = []
  const failInsert: { table: string | null; err: unknown } = { table: null, err: null }
  const chain = (table: string) => {
    reads.push(table)
    const preds: Array<(r: Row) => boolean> = []
    const order: Array<[string, string]> = []
    let lim: number | undefined
    const matched = () => {
      let out = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
      for (const [col, dir] of [...order].reverse()) {
        out = [...out].sort((a, b) => {
          const x = a[col] as number | string
          const y = b[col] as number | string
          const c = x < y ? -1 : x > y ? 1 : 0
          return dir === 'desc' ? -c : c
        })
      }
      return lim === undefined ? out : out.slice(0, lim)
    }
    const q: Record<string, unknown> = {}
    q.where = (a: unknown, op?: unknown, v?: unknown) => {
      if (a && typeof a === 'object') {
        preds.push((r) =>
          Object.entries(a as Row).every(([k, val]) => String(r[k]) === String(val))
        )
      } else if (v === undefined) {
        preds.push((r) => String(r[a as string]) === String(op))
      } else if (op === 'like') {
        preds.push((r) => like(r[a as string], String(v)))
      } else if (op === '=') {
        preds.push((r) => String(r[a as string]) === String(v))
      }
      return q
    }
    q.andWhere = q.where
    q.whereIn = (col: string, vals: unknown[]) => {
      const set = new Set(vals.map(String))
      preds.push((r) => set.has(String(r[col])))
      return q
    }
    q.whereNotNull = (col: string) => {
      preds.push((r) => r[col] != null)
      return q
    }
    q.orderBy = (col: string, dir = 'asc') => {
      order.push([col, dir])
      return q
    }
    q.limit = (n: number) => {
      lim = n
      return q
    }
    q.select = () => q
    q.first = async () => matched()[0]
    q.update = async (patch: Row) => {
      const rows = matched()
      for (const r of rows) Object.assign(r, patch)
      return rows.length
    }
    q.insert = async (data: Row | Row[]) => {
      if (failInsert.table === table) throw failInsert.err
      const list = (Array.isArray(data) ? data : [data]).map((d) => ({ id: nextId++, ...d }))
      tables[table] = [...(tables[table] ?? []), ...list]
      return list.map((r) => r.id)
    }
    q.delete = async () => {
      const gone = new Set(matched())
      tables[table] = (tables[table] ?? []).filter((r) => !gone.has(r))
      return gone.size
    }
    q.del = q.delete
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    q.then = (ok: (r: Row[]) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(matched()).then(ok, fail)
    return q
  }
  const db = Object.assign((table: string) => chain(table), {
    transaction: async (cb: (trx: unknown) => unknown) => cb(db),
    schema: { hasTable: async (t: string) => t in tables }
  })
  const reset = (seed: Record<string, Row[]>) => {
    reads.length = 0
    failInsert.table = null
    for (const k of Object.keys(tables)) delete tables[k]
    for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
    nextId = 900
  }
  return { db, tables, reset, reads, failInsert }
})

const auth = vi.hoisted(() => ({ admin: true }))

vi.mock('../../../db/index.js', () => ({ db: fake.db }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    if (!auth.admin) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
    }
    req.user = { id: 'admin-1', email: 'admin@x.test', first_name: 'Ada', last_name: 'Admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/config-live.js', () => ({ markConfigRead: vi.fn() }))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: vi.fn(async (_who: unknown, fn: () => Promise<unknown>) => fn())
}))
vi.mock('../../../services/liquid-dates.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  instanceTimezone: async () => 'America/New_York'
}))
vi.mock('../../../services/queues.js', () => ({
  getLabels: vi.fn(async (m: Map<string, Set<string>>) => {
    const out: Record<string, string> = {}
    for (const [col, ids] of m) for (const id of ids) out[`${col}:${id}`] = `IR-${id}`
    return out
  })
}))
// Record search goes through the items service; here it answers from the stand-in tables.
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(async (_u: unknown, collection: string, q: { filter?: Row }) => {
    const id = (q.filter?.id as { _eq?: unknown } | undefined)?._eq
    const rows = (fake.tables[collection] ?? []).filter((r) => id == null || String(r.id) === id)
    return { data: rows.map((r) => ({ id: r.id })).reverse() }
  })
}))
vi.mock('../../../services/body-secrets.js', () => ({
  bodySecretNames: vi.fn(async () => []),
  hasBodySecret: vi.fn(async () => false)
}))
// The action context machinery (buildContext) runs real queries; here each
// named context key answers with fixed rows. The gate (erpActionGate) is the real one.
vi.mock('../../../services/workflow-actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/workflow-actions.js')>()),
  buildContext: vi.fn(async (defs: Record<string, unknown> | undefined) => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(defs ?? {})) out[k] = k === 'mwf_queue' ? [{ name: 'Q-7' }] : []
    return out
  })
}))

// ── In-memory template service ───────────────────────────────────────────────
type FakeRow = {
  id: number
  key: string
  label: string
  description: string | null
  external_api: string | null
  endpoint_path: string | null
  collection: string
  owner: string | null
  draft_mode: 'map' | 'code'
  draft_body: string | null
  draft_rev: number
  published_mode: 'map' | 'code' | null
  published_body: string | null
  published_version: number | null
  locked_keys: string[]
  lookups: Record<string, unknown> | null
  draft_lookups: Record<string, unknown> | null
  default_hash: string | null
}
const svc = vi.hoisted(() => ({
  rows: new Map<string, FakeRow>(),
  registered: new Map<string, Record<string, unknown>>()
}))

vi.mock('../../../services/payload-templates/index.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/payload-templates/index.js')
  const { renderBody } = await import('../../../services/payload-templates/render.js')
  const { validateSpec } = await import('../../../services/payload-templates/evaluate.js')
  const { PayloadTemplateError } = real
  const clone = (r: FakeRow | undefined) => (r ? structuredClone(r) : null)
  const need = (key: string) => {
    const r = svc.rows.get(key)
    if (!r)
      throw new PayloadTemplateError('unknown_key', `Payload template '${key}' does not exist`)
    return r
  }
  return {
    ...real,
    bustPayloadTemplateCache: vi.fn(),
    registeredDef: (key: string) => svc.registered.get(key) ?? null,
    hasNewerDefault: (r: { key: string; default_hash: string | null }) => {
      const def = svc.registered.get(r.key) as { default: { body: string } } | undefined
      return !!def && real.hashBody(def.default.body) !== r.default_hash
    },
    getTemplate: async (key: string) => clone(svc.rows.get(key)),
    listTemplates: async (f: { external_api?: string } = {}) =>
      [...svc.rows.values()]
        .filter((r) => !f.external_api || r.external_api === f.external_api)
        .map((r) => structuredClone(r)),
    saveDraft: async (
      key: string,
      input: { mode: 'map' | 'code'; body: string; base_rev: number },
      _user: string | null,
      opts: { convert?: boolean } = {}
    ) => {
      const r = need(key)
      if (input.mode === 'map') {
        const v = validateSpec(JSON.parse(input.body))
        if (!v.ok) throw new PayloadTemplateError('invalid', v.errors.join('; '))
      }
      // Mode lock, as the service: only Convert (map → code) changes it.
      if (input.mode !== r.draft_mode && !(opts.convert && input.mode === 'code')) {
        throw new PayloadTemplateError('invalid', real.MODE_CHANGE_MESSAGE)
      }
      if (r.draft_rev !== input.base_rev) return { ok: false, current: structuredClone(r) }
      Object.assign(r, {
        draft_mode: input.mode,
        draft_body: input.body,
        draft_rev: r.draft_rev + 1
      })
      return { ok: true, rev: r.draft_rev }
    },
    saveDraftLookups: async (
      key: string,
      input: { lookups: Record<string, unknown> | null; base_rev: number }
    ) => {
      const r = need(key)
      if (r.draft_rev !== input.base_rev) return { ok: false, current: structuredClone(r) }
      Object.assign(r, { draft_lookups: input.lookups, draft_rev: r.draft_rev + 1 })
      return { ok: true, rev: r.draft_rev }
    },
    publishDraft: async (key: string, input: { base_rev: number; note: string }) => {
      const r = need(key)
      if (r.draft_rev !== input.base_rev) return { ok: false, current: structuredClone(r) }
      const version = (r.published_version ?? 0) + 1
      Object.assign(r, {
        published_mode: r.draft_mode,
        published_body: r.draft_body,
        published_version: version,
        lookups: r.draft_lookups
      })
      return { ok: true, version }
    },
    listVersions: async (key: string) => {
      const r = need(key)
      return r.published_version
        ? [{ id: 1, version: r.published_version, mode: r.published_mode, note: 'n' }]
        : []
    },
    getVersion: async (key: string, v: number) => {
      const r = need(key)
      return v === r.published_version
        ? { id: 1, version: v, mode: r.published_mode, note: 'n', body: r.published_body }
        : null
    },
    restoreVersion: async (key: string, v: number) => {
      const r = need(key)
      if (v === 7) throw new PayloadTemplateError('conflict', 'draft kept changing; try again')
      if (v !== r.published_version) return null
      r.draft_body = r.published_body
      r.draft_rev += 1
      return { rev: r.draft_rev }
    },
    resetToDefault: async (key: string) => {
      const r = need(key)
      const def = svc.registered.get(key) as { default: { body: string } } | undefined
      if (!def) throw new PayloadTemplateError('invalid', 'no default')
      r.draft_body = def.default.body
      r.draft_rev += 1
      return { rev: r.draft_rev }
    },
    renderPayloadTemplate: async (
      key: string,
      scope: Record<string, unknown>,
      opts: { draft?: boolean; draftBody?: { mode: 'map' | 'code'; body: string } } = {}
    ) => {
      const r = need(key)
      const preview = !!opts.draft || !!opts.draftBody
      const mode = opts.draftBody?.mode ?? (preview ? r.draft_mode : r.published_mode)
      const body = opts.draftBody?.body ?? (preview ? r.draft_body : r.published_body)
      const out = await renderBody(mode as 'map' | 'code', String(body), scope, {
        lockedKeys: r.locked_keys
      })
      return { ...out, version: preview ? null : r.published_version }
    }
  }
})

import { payloadTemplateRoutes } from '../../../routes/payload-templates.js'
import { logActivity } from '../../../services/activity.js'
import { markConfigRead } from '../../../services/config-live.js'
import { readItems } from '../../../services/items.js'
import { bustPayloadTemplateCache } from '../../../services/payload-templates/index.js'
import { withReadGate } from '../../../services/read-gate.js'

const SPEC = JSON.stringify({
  v: 1,
  fields: [
    {
      id: 'f1',
      key: 'workflow_id',
      type: 'text',
      value: { source: 'path', path: 'record.workflow_id' },
      include: 'always',
      rules: { required: true }
    },
    {
      id: 'f2',
      key: 'efp_state',
      type: 'text',
      value: { source: 'builtin', name: 'state.label' },
      include: 'always'
    },
    {
      id: 'f3',
      key: 'queue',
      type: 'text',
      value: { source: 'path', path: 'context.mwf_queue[0].name' },
      include: 'not_empty'
    }
  ]
})

const tpl = (over: Partial<FakeRow>): FakeRow => ({
  id: 1,
  key: 'mwf-ir-order',
  label: 'MWF IR order',
  description: null,
  external_api: 'MWF',
  endpoint_path: '/update_workflow.php',
  collection: 'inventory_request',
  owner: null,
  draft_mode: 'map',
  draft_body: SPEC,
  draft_rev: 3,
  published_mode: 'map',
  published_body: SPEC,
  published_version: 2,
  locked_keys: [],
  lookups: null,
  draft_lookups: null,
  default_hash: null,
  ...over
})

const action = (key: string, extra: Row = {}) =>
  JSON.stringify([
    { type: 'notify' },
    {
      type: 'erp_submit',
      external_api: 'MWF',
      endpoint_path: '/update_workflow.php',
      payload_template_key: key,
      context: { mwf_queue: { collection: 'mwf_queue', filter: { ir: '$id' } } },
      ...extra
    }
  ])

beforeEach(() => {
  auth.admin = true
  svc.rows.clear()
  svc.registered.clear()
  svc.rows.set('mwf-ir-order', tpl({}))
  svc.rows.set(
    'fusion-transfer-order',
    tpl({
      id: 2,
      key: 'fusion-transfer-order',
      label: 'Fusion transfer order',
      external_api: 'Fusion IIP',
      published_version: null,
      published_mode: null,
      published_body: null,
      owner: 'efp-ops'
    })
  )
  fake.reset({
    nivaro_workflow_templates: [{ id: 'T1', name: 'Inventory Request' }],
    nivaro_workflow_states: [
      { id: 'S1', template: 'T1', key: 'SUBMITTED', label: 'Submitted', external_label: null }
    ],
    nivaro_workflow_transitions: [
      {
        id: 'TR1',
        template: 'T1',
        label: 'Submit to Warehouse',
        to_state: 'S1',
        sort: 1,
        actions: action('mwf-ir-order')
      },
      {
        id: 'TR2',
        template: 'T1',
        label: 'Auto-submit',
        to_state: 'S1',
        sort: 2,
        actions: action('mwf-ir-order-x')
      }
    ],
    inventory_request: [
      { id: 11, workflow_id: 'WF-11' },
      { id: 12, workflow_id: null }
    ],
    nivaro_payload_templates: [],
    nivaro_payload_template_versions: [],
    nivaro_payload_template_drafts: [],
    nivaro_users: [
      { id: 'u1', email: 'x@y', static_token: 'secret' },
      { id: 'u-9', first_name: 'Rob', last_name: 'Lee' },
      { id: 'admin-1', first_name: 'Ada', last_name: 'Admin' }
    ],
    directus_users: [{ id: 'u1', email: 'x@y', password: 'secret' }]
  })
  vi.mocked(markConfigRead).mockClear()
  vi.mocked(withReadGate).mockClear()
  vi.mocked(bustPayloadTemplateCache).mockClear()
  vi.mocked(logActivity).mockClear()
  vi.mocked(readItems).mockClear()
})

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Row) {
  const app = Fastify({ logger: false })
  app.register(payloadTemplateRoutes, { prefix: '/payload-templates' })
  await app.ready()
  const res = await app.inject({ method, url: `/payload-templates${url}`, payload })
  await app.close()
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}

describe('payload template routes', () => {
  it('refuses a non-admin', async () => {
    auth.admin = false
    expect((await call('GET', '')).status).toBe(403)
    expect(
      (await call('PUT', '/mwf-ir-order/draft', { mode: 'map', body: SPEC, base_rev: 3 })).status
    ).toBe(403)
  })

  it('lists templates, filtered by external API, with status, usage and the edit warning', async () => {
    const all = await call('GET', '')
    expect(all.status).toBe(200)
    expect(all.body.warning).toBe('Payload templates here are replaced every night.')
    expect(all.body.data.map((r: Row) => r.key).sort()).toEqual([
      'fusion-transfer-order',
      'mwf-ir-order'
    ])
    const mwf = await call('GET', '?external_api=MWF')
    expect(mwf.body.data).toEqual([
      {
        key: 'mwf-ir-order',
        label: 'MWF IR order',
        external_api: 'MWF',
        status: 'live',
        published_version: 2,
        draft_rev: 3,
        used_by_count: 1,
        newer_default: false
      }
    ])
    const fusion = await call('GET', '?external_api=Fusion%20IIP')
    expect(fusion.body.data[0].status).toBe('unpublished')
  })

  it('shows one template with who uses it', async () => {
    svc.registered.set('mwf-ir-order', {
      key: 'mwf-ir-order',
      owner: 'efp-ops',
      default: { mode: 'map', body: SPEC },
      senders: ['efp-ops: MDSi recovery']
    })
    const res = await call('GET', '/mwf-ir-order')
    expect(res.status).toBe(200)
    expect(res.body.warning).toBe('Payload templates here are replaced every night.')
    expect(res.body.data.used_by).toEqual([
      {
        kind: 'transition',
        label: 'Inventory Request · Submit to Warehouse',
        template_id: 'T1',
        transition_id: 'TR1'
      },
      { kind: 'code', label: 'efp-ops: MDSi recovery' }
    ])
    expect(res.body.data.newer_default).toBe(true)
    expect(res.body.data.default_body).toBe(SPEC)
    expect((await call('GET', '/nope')).status).toBe(404)
  })

  it('saves a draft, refuses a stale base_rev with the current row, and refuses a bad spec', async () => {
    const edited = SPEC.replace('"queue"', '"queue_name"')
    const ok = await call('PUT', '/mwf-ir-order/draft', { mode: 'map', body: edited, base_rev: 3 })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ rev: 4 })
    const stale = await call('PUT', '/mwf-ir-order/draft', { mode: 'map', body: SPEC, base_rev: 3 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('stale')
    expect(stale.body.current.draft_rev).toBe(4)
    expect(stale.body.current.draft_body).toBe(edited)
    const bad = await call('PUT', '/mwf-ir-order/draft', {
      mode: 'map',
      body: JSON.stringify({ v: 2, fields: [] }),
      base_rev: 4
    })
    expect(bad.status).toBe(400)
    expect(bad.body.errors).toContain('v must be 1')
    const notJson = await call('PUT', '/mwf-ir-order/draft', {
      mode: 'map',
      body: '{',
      base_rev: 4
    })
    expect(notJson.status).toBe(400)
  })

  it('previews against a record with the referencing action scope, values keyed by field id', async () => {
    const res = await call('POST', '/mwf-ir-order/preview', { id: '11', which: 'draft' })
    expect(res.status).toBe(200)
    expect(markConfigRead).toHaveBeenCalled()
    expect(res.body.body).toEqual({ workflow_id: 'WF-11', efp_state: 'Submitted', queue: 'Q-7' })
    expect(res.body.values).toMatchObject({ f1: 'WF-11', f2: 'Submitted', f3: 'Q-7' })
    expect(res.body.skipped).toBeNull()
    expect(res.body.version).toBeNull()
    expect(res.body.problems).toEqual([])

    const live = await call('POST', '/mwf-ir-order/preview', { id: '11', which: 'published' })
    expect(live.body.version).toBe(2)

    // An unsaved edit renders instead of the stored draft.
    const draft = SPEC.replace('"efp_state"', '"state"')
    const unsaved = await call('POST', '/mwf-ir-order/preview', {
      id: '11',
      which: 'draft',
      draft: { mode: 'map', body: draft }
    })
    expect(unsaved.body.body).toEqual({ workflow_id: 'WF-11', state: 'Submitted', queue: 'Q-7' })

    expect(
      (await call('POST', '/mwf-ir-order/preview', { id: '999', which: 'draft' })).status
    ).toBe(404)
  })

  it('says when the referencing action would not send for the record', async () => {
    fake.tables.nivaro_workflow_transitions[0].actions = action('mwf-ir-order', {
      guard: [{ field: 'workflow_id', op: 'not_empty' }]
    })
    const res = await call('POST', '/mwf-ir-order/preview', { id: '12', which: 'draft' })
    expect(res.status).toBe(200)
    expect(res.body.skipped).toMatch(/guard unmet: workflow_id/)
  })

  it('uses the registrar scope when no transition references the template', async () => {
    svc.registered.set('fusion-transfer-order', {
      key: 'fusion-transfer-order',
      owner: 'efp-ops',
      default: { mode: 'map', body: SPEC },
      scope: async (id: string) => ({ record: { workflow_id: `REG-${id}` }, state: { label: 'X' } })
    })
    const res = await call('POST', '/fusion-transfer-order/preview', { id: '5', which: 'draft' })
    expect(res.status).toBe(200)
    expect(res.body.body).toEqual({ workflow_id: 'REG-5', efp_state: 'X' })
  })

  it('checks recent records through the read gate, one result per record', async () => {
    const res = await call('POST', '/mwf-ir-order/check', { which: 'draft', limit: 500 })
    expect(res.status).toBe(200)
    expect(markConfigRead).toHaveBeenCalled()
    expect(withReadGate).toHaveBeenCalledTimes(1)
    expect(res.body.results).toHaveLength(2)
    const [first, second] = res.body.results
    expect(first).toMatchObject({ id: '12', label: 'IR-12', ok: false, skipped: null })
    expect(first.problems.some((p: Row) => p.field_id === 'f1')).toBe(true)
    expect(second).toMatchObject({ id: '11', label: 'IR-11', ok: true, problems: [] })
  })

  it('publishes, then the list shows the template live; a stale publish is refused', async () => {
    await call('PUT', '/mwf-ir-order/draft', {
      mode: 'map',
      body: SPEC.replace('"queue"', '"q"'),
      base_rev: 3
    })
    const listed = await call('GET', '?external_api=MWF')
    expect(listed.body.data[0].status).toBe('draft')
    expect((await call('POST', '/mwf-ir-order/publish', { base_rev: 3, note: 'x' })).status).toBe(
      409
    )
    expect((await call('POST', '/mwf-ir-order/publish', { base_rev: 4, note: '' })).status).toBe(
      400
    )
    const pub = await call('POST', '/mwf-ir-order/publish', { base_rev: 4, note: 'Rename queue' })
    expect(pub.status).toBe(200)
    expect(pub.body).toEqual({ version: 3 })
    const after = await call('GET', '?external_api=MWF')
    expect(after.body.data[0]).toMatchObject({ status: 'live', published_version: 3 })
  })

  it('lists, reads and restores versions; resets to the shipped default', async () => {
    expect((await call('GET', '/mwf-ir-order/versions')).body.data).toHaveLength(1)
    expect((await call('GET', '/mwf-ir-order/versions/2')).body.data.body).toBe(SPEC)
    expect((await call('GET', '/mwf-ir-order/versions/9')).status).toBe(404)
    expect((await call('POST', '/mwf-ir-order/versions/2/restore')).body).toEqual({ rev: 4 })
    expect((await call('POST', '/mwf-ir-order/versions/9/restore')).status).toBe(404)
    const conflict = await call('POST', '/mwf-ir-order/versions/7/restore')
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toBe('conflict')
    expect((await call('POST', '/mwf-ir-order/reset-default')).status).toBe(400)
  })

  it('creates a template and busts the published cache', async () => {
    const res = await call('POST', '', {
      key: 'new-payload',
      label: 'New payload',
      external_api: 'MWF',
      collection: 'inventory_request'
    })
    expect(res.status).toBe(201)
    expect(bustPayloadTemplateCache).toHaveBeenCalled()
    const row = fake.tables.nivaro_payload_templates.find((r) => r.key === 'new-payload')
    expect(row).toMatchObject({ label: 'New payload', external_api: 'MWF', owner: null })
    expect(row).not.toHaveProperty('draft_body')
    expect(fake.tables.nivaro_payload_template_drafts).toEqual([
      expect.objectContaining({
        template_id: row?.id,
        mode: 'map',
        body: '{"v":1,"fields":[]}',
        rev: 1,
        updated_by: 'admin-1'
      })
    ])
    for (const collection of ['nivaro_users', 'directus_users', 'Bad Name']) {
      const refused = await call('POST', '', { key: 'sys', label: 'x', collection })
      expect(refused.status).toBe(400)
    }
    expect((await call('POST', '', { key: 'Bad Key', label: 'x', collection: 'a' })).status).toBe(
      400
    )
    expect(
      (await call('POST', '', { key: 'mwf-ir-order', label: 'x', collection: 'inventory_request' }))
        .status
    ).toBe(409)
  })

  it('refuses to delete a referenced or registrar-owned template', async () => {
    const referenced = await call('DELETE', '/mwf-ir-order')
    expect(referenced.status).toBe(409)
    expect(referenced.body.error).toBe('referenced')
    const owned = await call('DELETE', '/fusion-transfer-order')
    expect(owned.status).toBe(409)
    expect(owned.body.error).toBe('registered')

    fake.tables.nivaro_payload_templates.push({ id: 77, key: 'loose' })
    fake.tables.nivaro_payload_template_versions.push({ id: 1, template_id: 77, version: 1 })
    fake.tables.nivaro_payload_template_drafts.push({ template_id: 77, rev: 2 })
    svc.rows.set('loose', tpl({ id: 77, key: 'loose' }))
    const ok = await call('DELETE', '/loose')
    expect(ok.status).toBe(200)
    expect(fake.tables.nivaro_payload_templates.some((r) => r.key === 'loose')).toBe(false)
    expect(fake.tables.nivaro_payload_template_versions).toHaveLength(0)
    expect(fake.tables.nivaro_payload_template_drafts).toHaveLength(0)
    expect(bustPayloadTemplateCache).toHaveBeenCalled()
  })

  it('answers record search with display labels', async () => {
    const res = await call('GET', '/mwf-ir-order/record-search?q=WF')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([
      { id: '12', label: 'IR-12' },
      { id: '11', label: 'IR-11' }
    ])
  })

  it('converts the map draft to Liquid over the recent records, as a convert save', async () => {
    const res = await call('POST', '/mwf-ir-order/convert', { base_rev: 3 })
    expect(res.status).toBe(200)
    expect(res.body.rev).toBe(4)
    expect(typeof res.body.liquid).toBe('string')
    const row = svc.rows.get('mwf-ir-order')
    expect(row).toMatchObject({ draft_mode: 'code', draft_body: res.body.liquid, draft_rev: 4 })
    // The converted Liquid renders what the map rendered.
    const preview = await call('POST', '/mwf-ir-order/preview', { id: '11', which: 'draft' })
    expect(preview.body.body).toEqual({
      workflow_id: 'WF-11',
      efp_state: 'Submitted',
      queue: 'Q-7'
    })
    // Only a map converts; a stale base_rev is refused.
    expect((await call('POST', '/mwf-ir-order/convert', { base_rev: 4 })).status).toBe(400)
  })

  it('refuses convert with the differences when it cannot prove the output', async () => {
    fake.tables.inventory_request = []
    const res = await call('POST', '/mwf-ir-order/convert', { base_rev: 3 })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('not_equal')
    expect(res.body.diffs[0]).toMatchObject({ index: -1 })
    expect(svc.rows.get('mwf-ir-order')?.draft_mode).toBe('map')
    const modeLock = await call('PUT', '/mwf-ir-order/draft', {
      mode: 'code',
      body: '{}',
      base_rev: 3
    })
    expect(modeLock.status).toBe(400)
  })

  it('answers unpublished with 409 and the message', async () => {
    const res = await call('POST', '/fusion-transfer-order/preview', {
      id: '11',
      which: 'published'
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('unpublished')
    expect(res.body.message).toMatch(/not published/)
  })

  it('never reads a system collection, whatever the stored row says', async () => {
    for (const collection of ['nivaro_users', 'directus_users']) {
      svc.rows.set('sys', tpl({ id: 50, key: 'sys', collection }))
      vi.mocked(readItems).mockClear()
      vi.mocked(withReadGate).mockClear()
      fake.reads.length = 0
      const preview = await call('POST', '/sys/preview', { id: 'u1', which: 'draft' })
      expect(preview.status).toBe(400)
      expect(preview.body.error).toBe('collection_refused')
      expect(preview.body.body).toBeUndefined()
      const check = await call('POST', '/sys/check', { which: 'draft' })
      expect(check.status).toBe(400)
      expect(check.body.results).toBeUndefined()
      const search = await call('GET', '/sys/record-search?q=u1')
      expect(search.status).toBe(400)
      expect(search.body.data).toBeUndefined()
      const convert = await call('POST', '/sys/convert', { base_rev: 3 })
      expect(convert.status).toBe(400)
      expect(fake.reads).not.toContain(collection)
      expect(readItems).not.toHaveBeenCalled()
      expect(withReadGate).not.toHaveBeenCalled()
    }
  })

  it('builds the plain-record scope with the template lookups when nothing else applies', async () => {
    fake.tables.nivaro_workflow_transitions = []
    const row = svc.rows.get('mwf-ir-order') as FakeRow
    // A draft preview reads the draft's lookups.
    row.draft_lookups = { mwf_queue: { collection: 'mwf_queue', filter: { ir: '$id' } } }
    const res = await call('POST', '/mwf-ir-order/preview', { id: '11', which: 'draft' })
    expect(res.status).toBe(200)
    // Raw row, lookups as context, no state.
    expect(res.body.body).toEqual({ workflow_id: 'WF-11', efp_state: null, queue: 'Q-7' })
    expect(fake.reads).toContain('inventory_request')
  })

  it('refuses a draft save when someone published since the editor loaded, with names', async () => {
    const row = svc.rows.get('mwf-ir-order') as FakeRow
    Object.assign(row, { published_by: 'u-9', draft_updated_by: 'admin-1' })
    const stale = await call('PUT', '/mwf-ir-order/draft', {
      mode: 'map',
      body: SPEC,
      base_rev: 3,
      base_published_version: 1
    })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('stale')
    expect(stale.body.current).toMatchObject({
      published_version: 2,
      published_by_name: 'Rob Lee',
      draft_updated_by_name: 'Ada Admin'
    })
    expect(row.draft_rev).toBe(3)
    const ok = await call('PUT', '/mwf-ir-order/draft', {
      mode: 'map',
      body: SPEC,
      base_rev: 3,
      base_published_version: 2
    })
    expect(ok.body).toEqual({ rev: 4 })
    const one = await call('GET', '/mwf-ir-order')
    expect(one.body.data).toMatchObject({
      published_by_name: 'Rob Lee',
      has_default: false
    })
  })

  it('needs base_rev to convert and reports records whose registrar scope failed', async () => {
    expect((await call('POST', '/mwf-ir-order/convert', {})).status).toBe(400)
    svc.registered.set('fusion-transfer-order', {
      key: 'fusion-transfer-order',
      owner: 'efp-ops',
      default: { mode: 'map', body: SPEC },
      recent: async () => ['5', '6'],
      scope: async (id: string) => {
        if (id === '6') throw new Error('workflow 6 has no lines')
        return { record: { workflow_id: `REG-${id}` }, state: { label: 'X' } }
      }
    })
    const res = await call('POST', '/fusion-transfer-order/convert', { base_rev: 3 })
    expect(res.status).toBe(200)
    expect(res.body.skipped).toEqual([{ id: '6', message: 'workflow 6 has no lines' }])
    const one = await call('GET', '/fusion-transfer-order')
    expect(one.body.data).toMatchObject({ has_default: true, default_mode: 'map' })
  })

  it('maps a duplicate key raced past the check to 409 exists', async () => {
    fake.failInsert.table = 'nivaro_payload_templates'
    fake.failInsert.err = Object.assign(new Error('Violation of UNIQUE KEY'), { number: 2627 })
    const res = await call('POST', '', {
      key: 'race-key',
      label: 'Race',
      external_api: 'MWF',
      collection: 'inventory_request',
      mode: 'code',
      body: '{"a": 1}'
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('exists')
  })

  it('answers a failed record search with its error', async () => {
    vi.mocked(readItems).mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { statusCode: 403 })
    )
    const res = await call('GET', '/mwf-ir-order/record-search?q=WF')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'search_failed', message: 'Forbidden' })
  })

  it('answers the recent-records set and checks exactly the ids given', async () => {
    const recent = await call('GET', '/mwf-ir-order/recent?limit=20')
    expect(recent.status).toBe(200)
    expect(recent.body).toEqual({ ids: ['12', '11'] })
    expect((await call('GET', '/mwf-ir-order/recent?limit=1')).body).toEqual({ ids: ['12'] })

    const one = await call('POST', '/mwf-ir-order/check', { which: 'draft', ids: ['11'] })
    expect(one.status).toBe(200)
    expect(one.body.results).toEqual([
      expect.objectContaining({ id: '11', label: 'IR-11', ok: true })
    ])
    expect(withReadGate).toHaveBeenCalledTimes(1)

    const tooMany = await call('POST', '/mwf-ir-order/check', {
      which: 'draft',
      ids: Array.from({ length: 51 }, (_, i) => String(i))
    })
    expect(tooMany.status).toBe(400)
    expect((await call('POST', '/mwf-ir-order/check', { ids: [{}] })).status).toBe(400)
  })

  it('never answers recent ids for a system collection', async () => {
    svc.rows.set('sys', tpl({ id: 50, key: 'sys', collection: 'nivaro_users' }))
    fake.reads.length = 0
    const res = await call('GET', '/sys/recent')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('collection_refused')
    expect(fake.reads).not.toContain('nivaro_users')
  })

  it('saves lookups to the draft under the revision guard; publish makes them live', async () => {
    const lookups = {
      lines: {
        collection: 'materials',
        filter: { workflow: '$id' },
        sort: '-id',
        limit: 50,
        expand: { item: { collection: 'items', fields: ['code'] } }
      }
    }
    const row = svc.rows.get('mwf-ir-order') as FakeRow
    const ok = await call('PUT', '/mwf-ir-order/lookups', { lookups, base_rev: 3 })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ rev: 4, data: { lookups } })
    // Only the draft moved: pushes still read the published (none).
    expect(row.draft_lookups).toEqual(lookups)
    expect(row.lookups).toBeNull()
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payload-template-lookups', item: 'mwf-ir-order' })
    )
    // Different lookups = something to publish, even with the same body.
    const listed = await call('GET', '?external_api=MWF')
    expect(listed.body.data.find((t: Row) => t.key === 'mwf-ir-order').status).toBe('draft')

    const stale = await call('PUT', '/mwf-ir-order/lookups', { lookups: null, base_rev: 3 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('stale')
    expect(stale.body.current.draft_rev).toBe(4)
    expect(row.draft_lookups).toEqual(lookups)

    const published = await call('POST', '/mwf-ir-order/publish', { base_rev: 4, note: 'lines' })
    expect(published.status).toBe(200)
    expect(row.lookups).toEqual(lookups)
    const after = await call('GET', '?external_api=MWF')
    expect(after.body.data.find((t: Row) => t.key === 'mwf-ir-order').status).toBe('live')
  })

  it('previews the draft with its lookups, the published version with the published ones', async () => {
    fake.tables.nivaro_workflow_transitions = []
    const row = svc.rows.get('mwf-ir-order') as FakeRow
    row.draft_lookups = { mwf_queue: { collection: 'mwf_queue', filter: { ir: '$id' } } }
    const draft = await call('POST', '/mwf-ir-order/preview', { id: '11', which: 'draft' })
    expect(draft.body.body.queue).toBe('Q-7')
    const live = await call('POST', '/mwf-ir-order/preview', { id: '11', which: 'published' })
    expect(live.body.body.queue).toBeUndefined()
    // Lookups sent with a preview are checked like saved ones.
    const sys = await call('POST', '/mwf-ir-order/preview', {
      id: '11',
      which: 'draft',
      draft: { mode: 'map', body: SPEC, lookups: { a: { collection: 'nivaro_users' } } }
    })
    expect(sys.status).toBe(400)
    const sent = await call('POST', '/mwf-ir-order/preview', {
      id: '11',
      which: 'draft',
      draft: { mode: 'map', body: SPEC, lookups: null }
    })
    expect(sent.body.body.queue).toBeUndefined()
  })

  it('refuses bad lookups, system collections and a registrar’s lookups', async () => {
    const bad = await call('PUT', '/mwf-ir-order/lookups', {
      base_rev: 3,
      lookups: {
        a: { collection: 'nivaro_users' },
        b: { collection: 'items', expand: { u: { collection: 'directus_users', fields: ['x'] } } },
        c: { collection: 'items', limit: 0, sort: 'id; drop', extra: 1 },
        '1x': { collection: 'items' }
      }
    })
    expect(bad.status).toBe(400)
    expect(bad.body.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^a\.collection: 'nivaro_users' is a system collection/),
        expect.stringMatching(/^b\.expand\.u\.collection: 'directus_users' is a system/),
        'c.extra is not a lookup setting',
        expect.stringMatching(/^c\.limit/),
        expect.stringMatching(/^c\.sort/),
        expect.stringMatching(/^'1x'/)
      ])
    )
    expect((svc.rows.get('mwf-ir-order') as FakeRow).draft_lookups).toBeNull()
    expect((await call('PUT', '/mwf-ir-order/lookups', {})).status).toBe(400)
    expect((await call('PUT', '/mwf-ir-order/lookups', { lookups: null })).status).toBe(400)

    const owned = await call('PUT', '/fusion-transfer-order/lookups', {
      lookups: null,
      base_rev: 3
    })
    expect(owned.status).toBe(409)
    expect(owned.body.error).toBe('registered')
    expect((await call('PUT', '/nope/lookups', { lookups: null, base_rev: 1 })).status).toBe(404)
  })
})
