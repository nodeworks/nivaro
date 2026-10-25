import knex from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army v3 (fix-reads-b): the read gates added to share links' neighbours —
// notification subscriptions, staged imports, report snapshots, anomaly log,
// record templates, page widgets, trees, team pages, direct notices, presence.
// Each gate: one refused caller, one allowed caller.

const m = vi.hoisted(() => ({
  can: true,
  allowed: null as string[] | null,
  visible: new Set<string>(),
  authUser: null as Record<string, unknown> | null
}))

vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => m.can),
  getAllowedFields: vi.fn(async () => m.allowed)
}))
vi.mock('../../../services/sla-visibility.js', () => ({
  visibleRecordIds: vi.fn(
    async (_u: unknown, _c: string, ids: string[]) => new Set(ids.filter((id) => m.visible.has(id)))
  ),
  canSeeRecord: vi.fn(async (_u: unknown, _c: string, id: string) => m.visible.has(String(id)))
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown }) => {
    if (!m.authUser) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = m.authUser
  }),
  requireAuth: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {})
}))

import { recipientView } from '../../../hooks/notification-subscriptions.js'
import { parseMaxDepth } from '../../../lib/tree.js'
import { ownAnomalyRules } from '../../../routes/metric-alerts.js'
import { collectionSubscriptionRefusal } from '../../../routes/notification-subscriptions.js'
import { directNoticeAllowed, personCategory } from '../../../routes/notifications.js'
import { widgetFilter } from '../../../routes/pages.js'
import { pingIdentity } from '../../../routes/presence.js'
import { visibleTemplates } from '../../../routes/record-templates.js'
import { snapshotsVisibleTo } from '../../../routes/report-studio.js'
import { ownRuns } from '../../../routes/staged-imports.js'
import { asViewer } from '../../../routes/tree.js'
import { visibleRows } from '../../../routes/user-groups.js'

const k = knex({ client: 'mssql' })
const sqlOf = (table: string, mod: (qb: never) => void) =>
  k(table)
    .select('*')
    .modify(mod as never)
    .toString()

const person = { id: 'U1', role: 'r-creator' }
const asReq = (isAdmin: boolean, user: Record<string, unknown> = person) =>
  ({ isAdmin, user }) as never

beforeEach(() => {
  m.can = true
  m.allowed = null
  m.visible = new Set()
  m.authUser = null
})

describe('notification subscriptions are a standing read', () => {
  it('refuses a collection the role cannot read', async () => {
    m.can = false
    expect(await collectionSubscriptionRefusal(asReq(false), 'budgets', [])).toMatchObject({
      code: 403
    })
  })
  it('refuses a filter on a field the policy hides, allows readable ones', async () => {
    m.allowed = ['id', 'name']
    expect(
      await collectionSubscriptionRefusal(asReq(false), 'workflows', ['amount'])
    ).toMatchObject({ code: 403 })
    expect(await collectionSubscriptionRefusal(asReq(false), 'workflows', ['name', 'id'])).toBe(
      null
    )
  })
  it('refuses system collections to non-admins, never to admins', async () => {
    expect(await collectionSubscriptionRefusal(asReq(false), 'nivaro_users', [])).toMatchObject({
      code: 403
    })
    expect(await collectionSubscriptionRefusal(asReq(true), 'nivaro_users', ['x'])).toBe(null)
  })
})

describe('subscription delivery reads as the recipient', () => {
  const deps = (o: {
    see?: boolean
    read?: boolean
    fields?: Record<string, string[] | null>
  }) => ({
    loadUser: async (id: string) => ({ id, role: 'r' }) as never,
    canRead: async () => o.read ?? true,
    canSee: async () => o.see ?? true,
    allowedFields: async (_u: unknown, c: string) => o.fields?.[c] ?? null
  })
  it('tells nothing about a record the recipient cannot see', async () => {
    expect(await recipientView('U2', 'workflows', '7', 'update', deps({ see: false }))).toBe(null)
    expect(await recipientView('U2', 'workflows', '7', 'delete', deps({ read: false }))).toBe(null)
  })
  it('keeps only change lines on fields the recipient may read (per collection)', async () => {
    const view = await recipientView(
      'U2',
      'workflows',
      '7',
      'update',
      deps({ fields: { workflows: ['name'], lines: ['qty'] } })
    )
    expect(view).not.toBe(null)
    const lines = await view!.changes([
      { field: 'name', label: 'Name', old: 'a', new: 'b' },
      { field: 'amount', label: 'Amount', old: '1', new: '2' },
      { field: 'qty', label: 'Qty · Line 1', old: '1', new: '2', of: 'lines' },
      { field: 'price', label: 'Price · Line 1', old: '1', new: '2', of: 'lines' },
      { field: '__create__:lines:9', label: 'lines 9', old: '', new: 'added', of: 'lines' }
    ])
    expect(lines.map((l) => l.field)).toEqual(['name', 'qty', '__create__:lines:9'])
    expect(await view!.row({ id: 7, name: 'x', amount: 5 })).toEqual({ id: 7, name: 'x' })
  })
})

describe('staged import runs', () => {
  it('non-admins see only runs they queued; admins every run', () => {
    expect(sqlOf('nivaro_import_queue as q', ownRuns(asReq(false)))).toContain(
      "where [q].[created_by] = 'U1'"
    )
    expect(sqlOf('nivaro_import_queue as q', ownRuns(asReq(true)))).not.toContain('where')
  })
})

describe('report snapshots are shown to whoever took them', () => {
  const report = { owner: 'OWNER' } as never
  it('a reader sees only their own snapshots', () => {
    expect(sqlOf('nivaro_report_snapshots', snapshotsVisibleTo(report, asReq(false)))).toContain(
      "where [created_by] = 'U1'"
    )
  })
  it('the owner also sees scheduled ones; admins all', () => {
    const owner = asReq(false, { id: 'OWNER' })
    expect(sqlOf('nivaro_report_snapshots', snapshotsVisibleTo(report, owner))).toContain(
      "([created_by] = 'OWNER' or [created_by] is null)"
    )
    expect(sqlOf('nivaro_report_snapshots', snapshotsVisibleTo(report, asReq(true)))).not.toContain(
      'where'
    )
  })
})

describe('anomaly log', () => {
  it('non-admins see only findings of their own rules; admins all', () => {
    expect(sqlOf('nivaro_anomaly_log as l', ownAnomalyRules(asReq(false)))).toContain(
      "where [r].[created_by] = 'U1'"
    )
    expect(sqlOf('nivaro_anomaly_log as l', ownAnomalyRules(asReq(true)))).not.toContain('where')
  })
})

describe('record templates', () => {
  it('an unshared role-less template is its creator’s alone', () => {
    const sql = sqlOf('nivaro_record_templates', visibleTemplates('U1', 'R1'))
    // The old form (`… or role_id is null`) made every unshared, role-less template public.
    expect(sql).toContain(
      "where [created_by] = 'U1' or ([is_shared] = 1 and ([role_id] is null or ([role_id] = 'R1'))) or ([role_id] = 'R1')"
    )
  })
})

describe('page widgets compute as the viewer', () => {
  it('turns stored filters into an items filter and names every tested field', () => {
    expect(
      widgetFilter([
        { field: 'amount', op: 'gt', value: 5 },
        { field: 'vendor', op: 'null' }
      ])
    ).toEqual({
      filter: { _and: [{ amount: { _gt: 5 } }, { vendor: { _null: true } }] },
      fields: ['amount', 'vendor']
    })
    expect(widgetFilter({ status: 'open' })).toEqual({
      filter: { _and: [{ status: { _eq: 'open' } }] },
      fields: ['status']
    })
  })
})

describe('tree reads', () => {
  const config = {
    id: 1,
    collection: 'divisions',
    parent_field: 'parent',
    label_field: 'name',
    order_field: null
  }
  const nodes = [
    { id: 1, depth: 0, label: 'A', name: 'A', parent: null, budget: 9 },
    { id: 2, depth: 1, label: 'B', name: 'B', parent: 1, budget: 3 }
  ]
  it('a non-admin gets only visible nodes and readable fields', async () => {
    m.visible = new Set(['2'])
    m.allowed = ['name', 'parent']
    const out = await asViewer(asReq(false), config, nodes as never)
    expect(out).toEqual([{ id: 2, depth: 1, label: 'B', name: 'B', parent: 1 }])
  })
  it('admins get the tree as stored', async () => {
    expect(await asViewer(asReq(true), config, nodes as never)).toBe(nodes)
  })
  it('a depth cap is a whole number, never raw text in SQL', () => {
    expect(() => parseMaxDepth('abc')).toThrow(/maxDepth/)
    expect(parseMaxDepth('3')).toBe(3)
    expect(parseMaxDepth(undefined)).toBeUndefined()
  })
})

describe('team pages count only records the viewer can see', () => {
  const rows = [
    { collection: 'workflows', item: '1' },
    { collection: 'workflows', item: '2' }
  ]
  it('drops hidden records for a non-admin', async () => {
    m.visible = new Set(['2'])
    expect(await visibleRows(person as never, false, rows)).toEqual([rows[1]])
  })
  it('admins see every record', async () => {
    expect(await visibleRows(person as never, true, rows)).toBe(rows)
  })
})

describe('direct notices', () => {
  it('a person cannot send a system-looking category', () => {
    expect(personCategory('system')).toBe('other')
    expect(personCategory('alerts')).toBe('other')
    expect(personCategory('mentions')).toBe('mentions')
    expect(personCategory('workflow')).toBe('workflow')
  })
  it('a sender is rate-limited', () => {
    const now = 1_000_000
    for (let i = 0; i < 30; i++) expect(directNoticeAllowed('SENDER-A', now + i)).toBe(true)
    expect(directNoticeAllowed('SENDER-A', now + 31)).toBe(false)
    expect(directNoticeAllowed('SENDER-B', now + 31)).toBe(true)
  })
})

describe('presence pings name only their own credential', () => {
  const reply = {} as never
  it('an anonymous ping names nobody, whatever the body says', async () => {
    expect(await pingIdentity({ headers: {} } as never, reply)).toBe(null)
    expect(await pingIdentity({ headers: { cookie: 'sid=x' } } as never, reply)).toBe(null)
  })
  it('a signed-in ping is that person', async () => {
    m.authUser = { id: 'U9', email: 'a@b.c' }
    const req = { headers: { cookie: 'sid=x' } } as { headers: object; user?: unknown }
    expect(await pingIdentity(req as never, reply)).toEqual({ id: 'U9', email: 'a@b.c' })
  })
})
