import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /collection-layouts/:id/generate-and-attach on a workflow locked after approval
// (edit_lock.admin_only). L-5 (0.3.167) made the attach clear the record's update gates; the
// post-approval lock is the one tier it passes again, by name (`allowWhenLocked: 'pdf-attach'`):
// Workflow Approvers attach the approved form after approval. Reading the record (null = 404),
// may-update-this-record and the approval tier still judge it. The real edit-lock service runs
// here against the table rows below.

const t = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  hidden: false,
  updatable: true
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-APPROVER', role: 'R-WORKFLOW-APPROVERS', first_name: 'Ann' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../db/index.js', () => {
  // Per table (alias dropped): every read answers the table's rows; whereNull is honoured (an
  // open run vs the latest one). Inserts are recorded.
  const db = (table: string) => {
    const name = table.split(' ')[0]
    const nulls: string[] = []
    const rows = () =>
      (t.tables[name] ?? []).filter((r) => nulls.every((c) => r[c.split('.').pop()!] == null))
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotNull', 'join', 'select', 'orderBy'])
      chain[m] = () => chain
    chain.whereNull = (c: string) => {
      nulls.push(c)
      return chain
    }
    chain.first = () => Promise.resolve(rows()[0])
    chain.insert = async (row: Record<string, unknown>) => {
      t.inserts.push({ table: name, row })
      return [1]
    }
    chain.update = async () => 1
    chain.del = async () => 1
    // biome-ignore lint/suspicious/noThenProperty: a knex query builder is a thenable
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
    chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(rows()).catch(fn)
    return chain
  }
  return { db: Object.assign(db, { transaction: async (cb: (x: unknown) => unknown) => cb(db) }) }
})
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/items.js')>()),
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    t.hidden ? null : { id, title: 'CM26-1' }
  ),
  canUpdateItem: vi.fn(async () => t.updatable)
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permissions.js')>()),
  can: vi.fn(async () => true),
  isAdminRole: vi.fn(async () => false)
}))
// The approver neither created the workflow nor owns its step, and is offered no move.
vi.mock('../../../services/record-access.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/record-access.js')>()),
  recordCreators: async (_c: string, ids: string[]) => new Map(ids.map((id) => [id, 'U-CREATOR'])),
  sameUser: (a: unknown, b: unknown) => String(a).toUpperCase() === String(b).toUpperCase(),
  ownsStep: () => false
}))
vi.mock('../../../services/pipeline-engine.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/pipeline-engine.js')>()),
  resolveStateOwnersBatch: async () => new Map([['x', []]])
}))
vi.mock('../../../services/item-lock-guard.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/item-lock-guard.js')>()),
  editLockRefusal: async () => null
}))
vi.mock('../../../services/pdf-layout.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/pdf-layout.js')>()),
  generatePdfFromLayout: vi.fn(async () => Buffer.from('%PDF-1.4')),
  pdfTextContext: vi.fn(async () => ({}))
}))
vi.mock('../../../services/storage/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/storage/index.js')>()),
  getStorage: () => ({ put: vi.fn(async () => {}) }),
  getStorageProviderName: () => 'local'
}))
vi.mock('../../../services/related-announce.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/related-announce.js')>()),
  queueForeignAspect: vi.fn()
}))

import { collectionLayoutsRoutes } from '../../../routes/collection-layouts.js'
import { logActivity } from '../../../services/activity.js'
import { assertNotEditLocked, forgetEditLockPlan } from '../../../services/edit-lock.js'
import { generatePdfFromLayout } from '../../../services/pdf-layout.js'

const RULES = {
  edit_lock: {
    states: ['waiting_l1'],
    admin_only: { states: ['completed'], open_fields: ['is_on_hold'] }
  }
}

function seed(run: Record<string, unknown>) {
  t.tables = {
    nivaro_collection_layouts: [{ id: 12, collection: 'workflows', name: 'Workflow form' }],
    nivaro_collections: [
      {
        collection: 'workflows',
        display_name: 'Workflows',
        summary_mode_rules: JSON.stringify(RULES)
      }
    ],
    nivaro_relations: [
      {
        many_collection: 'workflows_files',
        many_field: 'workflows_id',
        one_collection: 'workflows',
        one_field: 'files',
        junction_field: 'directus_files_id'
      },
      {
        many_collection: 'workflows_files',
        many_field: 'directus_files_id',
        one_collection: 'nivaro_files',
        one_field: null,
        junction_field: 'workflows_id'
      }
    ],
    nivaro_workflow_instances: [run]
  }
  t.inserts = []
  t.hidden = false
  t.updatable = true
  forgetEditLockPlan()
}

const COMPLETED = {
  id: 'i9',
  collection: 'workflows',
  item: '100',
  current_state: 's9',
  key: 'completed',
  label: 'Completed',
  completed_at: '2026-11-10T00:00:00Z'
}

function attach() {
  const app = Fastify({ logger: false })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  return app.inject({
    method: 'POST',
    url: '/collection-layouts/12/generate-and-attach',
    payload: { collection: 'workflows', item_id: 100, attach_field: 'files' }
  })
}

const reqAs = (id: string) =>
  ({ user: { id, role: 'R' }, isAdmin: false, headers: {} }) as unknown as Parameters<
    typeof assertNotEditLocked
  >[3]

beforeEach(() => {
  vi.clearAllMocks()
  seed(COMPLETED)
})

describe('generate-and-attach on a workflow locked after approval', () => {
  it('a non-admin approver attaches the PDF: file row + files link written, activity logged', async () => {
    const res = await attach()
    expect(res.statusCode).toBe(200)
    expect(res.json().data.attached).toBe(true)
    expect(t.inserts.map((i) => i.table)).toEqual(['nivaro_files', 'workflows_files'])
    expect(t.inserts[1].row).toMatchObject({ workflows_id: 100 })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pdf-generate-attach',
        collection: 'workflows',
        item: '100'
      })
    )
  })

  it('the same approver editing a field of the locked workflow is still refused', async () => {
    await expect(
      assertNotEditLocked(
        { id: 'U-APPROVER', role: 'R' } as never,
        'workflows',
        { ids: ['100'], payload: { project: 5 } },
        reqAs('U-APPROVER')
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'EDIT_LOCKED' })
  })

  it('a run still waiting on approval keeps the approval tier: no attach for a non-owner', async () => {
    seed({ ...COMPLETED, id: 'i1', key: 'waiting_l1', label: 'Level 1', completed_at: null })
    const res = await attach()
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('EDIT_LOCKED')
    expect(t.inserts).toEqual([])
  })

  it('a caller who cannot read the record gets 404 and nothing is rendered or written', async () => {
    t.hidden = true
    const res = await attach()
    expect(res.statusCode).toBe(404)
    expect(generatePdfFromLayout).not.toHaveBeenCalled()
    expect(t.inserts).toEqual([])
  })

  it('a caller who may not update this record is still refused (L-5)', async () => {
    t.updatable = false
    const res = await attach()
    expect(res.statusCode).toBe(403)
    expect(t.inserts).toEqual([])
  })
})
