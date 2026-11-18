import { beforeEach, describe, expect, it, vi } from 'vitest'

/** GitLab in Flows: the gitlab.create_issue operation and the gitlab.issue_changed trigger. */

const feature = vi.hoisted(() => ({ on: true }))
vi.mock('./feature.js', () => ({ trackersEnabled: async () => feature.on }))
const registry = vi.hoisted(() => ({
  ops: [] as Array<Record<string, any>>,
  triggers: [] as Array<Record<string, any>>
}))
vi.mock('../../flows/registry.js', () => ({
  registerOp: (op: Record<string, any>) => registry.ops.push(op),
  registerTrigger: (tr: Record<string, any>) => registry.triggers.push(tr),
  emitTrigger: () => {}
}))
vi.mock('../flow-template-render.js', () => ({
  resolveTemplate: (tpl: string, data: Record<string, unknown>) =>
    tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(data[k] ?? ''))
}))
const links = vi.hoisted(() => ({ calls: [] as unknown[][], previews: [] as unknown[][] }))
vi.mock('./links.js', () => {
  class LinkError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string
    ) {
      super(message)
    }
  }
  return {
    LinkError,
    requestSourceCreate: async (...a: unknown[]) => {
      links.calls.push(a)
      if (a[1] === 'orders:404') throw new LinkError('Record not found', 404, 'NOT_FOUND')
      if (a[1] === 'orders:8') throw new LinkError('Already', 409, 'ALREADY_LINKED')
      return { outboxId: 77 }
    },
    previewSourceCreate: async (...a: unknown[]) => {
      links.previews.push(a)
      return { connection: 1, project_id: 7, title: 'Order 7', labels: ['ops'] }
    }
  }
})
// U-1 a person, A-1 an administrator
vi.mock('../users.js', () => ({
  getUser: async (id: string) =>
    id === 'U-1' || id === 'A-1'
      ? { id, status: 'active', role: id === 'A-1' ? 'admin' : 'r' }
      : undefined
}))
vi.mock('../user-scopes.js', () => ({ isAdminRole: async (role: string) => role === 'admin' }))
vi.mock('../flow-executor.js', () => ({
  resolveFlowCreator: async (flowId: string) =>
    flowId === 'F-1' ? 'U-1' : flowId === 'F-ADMIN' ? 'A-1' : null
}))
const tickets = vi.hoisted(() => ({ canSee: true }))
vi.mock('./sources/index.js', () => ({
  sourceFor: () => ({ canRead: async () => tickets.canSee })
}))
const claims = vi.hoisted(() => ({
  ok: true,
  claimed: [] as unknown[][],
  settled: [] as unknown[][],
  released: [] as unknown[][]
}))
vi.mock('./engine.js', () => ({
  claimFlowFire: async (...a: unknown[]) => {
    claims.claimed.push(a)
    return claims.ok
      ? { ok: true, id: 5 }
      : { ok: false, detail: 'Connection already sent 30 in the last hour (limit 30)' }
  },
  settleClaim: async (...a: unknown[]) => claims.settled.push(a),
  releaseClaim: async (...a: unknown[]) => claims.released.push(a)
}))

import { createIssueFromFlow, flowSource, registerTrackerFlows } from './flow-ops.js'

const ctxOf = (flowId: string, extra: Record<string, unknown> = {}) => ({
  flowId,
  flowName: 'x',
  trigger: 't',
  payload: {},
  log: {},
  ...extra
})

beforeEach(() => {
  feature.on = true
  tickets.canSee = true
  claims.ok = true
  links.calls.length = 0
  links.previews.length = 0
  claims.claimed.length = 0
  claims.settled.length = 0
  claims.released.length = 0
})

describe('gitlab.create_issue', () => {
  it("master switch off: flow op is a no-op returning {skipped:'FEATURE_OFF'}", async () => {
    feature.on = false
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'orders', item: '7' },
        { flowId: 'F-1' }
      )
    ).toEqual({ skipped: 'FEATURE_OFF' })
    expect(links.calls).toHaveLength(0)
    expect(claims.claimed).toHaveLength(0)
  })

  it('maps the flow record to its source', () => {
    expect(flowSource('nivaro_issues', '5')).toEqual({ kind: 'issue', id: '5' })
    expect(flowSource('nivaro_tasks', '55')).toEqual({ kind: 'ticket', id: '55' })
    expect(flowSource('orders', '7')).toEqual({ kind: 'record', id: 'orders:7' })
  })

  it("reads a record as the flow's author when no person set the flow off", async () => {
    const out = await createIssueFromFlow(
      { connection: 1, collection: 'orders', item: '7', project_id: 9, labels: 'a,b' },
      { flowId: 'F-1' }
    )
    expect(out).toEqual({ outbox_id: 77, kind: 'record', source_id: 'orders:7' })
    const [kind, id, opts] = links.calls[0] as [string, string, Record<string, any>]
    expect([kind, id]).toEqual(['record', 'orders:7'])
    expect(opts).toMatchObject({ connection: 1, project_id: 9, via: 'rule' })
    expect(opts.asUser).toMatchObject({ id: 'U-1' })
    expect(opts.action).toMatchObject({ connection: 1, project_id: 9, labels: ['a', 'b'] })
    expect(opts.action.title_template).toBe('{{ label }}')
    // the claimed cap slot names what it did ("Flow")
    expect(claims.claimed).toEqual([[1, 0]])
    expect(claims.settled[0]).toEqual([5, 'Flow: queued a new GitLab issue for record orders:7'])
  })

  it('a test run renders and checks but queues nothing', async () => {
    const out = await createIssueFromFlow(
      { connection: 1, collection: 'orders', item: '7' },
      { userId: 'U-1', flowId: 'F-1', dryRun: true }
    )
    expect(out).toEqual({
      preview: { connection: 1, project: 7, title: 'Order 7', labels: ['ops'] }
    })
    expect(links.calls).toHaveLength(0)
    expect(claims.claimed).toHaveLength(0)
    await registerFlows()
    const op = registry.ops.find((o) => o.type === 'gitlab.create_issue')
    const res = await op?.handler(
      { connection: 1 },
      { collection: 'orders', item: '7' },
      ctxOf('F-1', { userId: 'U-1', dryRun: true })
    )
    expect(res).toEqual({
      status: 'resolve',
      output: {
        collection: 'orders',
        item: '7',
        $preview_gitlab: { connection: 1, project: 7, title: 'Order 7', labels: ['ops'] }
      }
    })
    expect(links.calls).toHaveLength(0)
  })

  it("acts with the flow person's access: issues need an admin, tickets need to be seen", async () => {
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'nivaro_issues', item: '5' },
        { userId: 'U-1', flowId: 'F-1' }
      )
    ).toMatchObject({ code: 'FORBIDDEN' })
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'nivaro_issues', item: '5' },
        { flowId: 'F-ADMIN' }
      )
    ).toMatchObject({ outbox_id: 77, kind: 'issue' })
    tickets.canSee = false
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'nivaro_tasks', item: '55' },
        { userId: 'U-1', flowId: 'F-1' }
      )
    ).toMatchObject({ code: 'FORBIDDEN' })
    tickets.canSee = true
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'nivaro_tasks', item: '55' },
        { userId: 'U-1', flowId: 'F-1' }
      )
    ).toMatchObject({ outbox_id: 77, kind: 'ticket' })
    // nobody to act as
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'nivaro_tasks', item: '55' },
        {
          flowId: 'F-NONE'
        }
      )
    ).toMatchObject({ code: 'NO_READER' })
    expect(links.calls).toHaveLength(2)
  })

  it('a capped flow step says so and queues nothing', async () => {
    claims.ok = false
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'orders', item: '7' },
        { userId: 'U-1', flowId: 'F-1' }
      )
    ).toEqual({
      skipped: 'CAP',
      detail: 'Connection already sent 30 in the last hour (limit 30)'
    })
    expect(links.calls).toHaveLength(0)
    claims.ok = true
    // already linked after claiming: the slot is given back (not a fire)
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'orders', item: '8' },
        { userId: 'U-1', flowId: 'F-1' }
      )
    ).toEqual({ skipped: 'ALREADY_LINKED' })
    expect(claims.released[0]).toEqual([5, 'linked', 'Flow: ALREADY_LINKED (record orders:8)'])
  })

  it('bad options and refusals come back as errors, never throws', async () => {
    expect(
      await createIssueFromFlow({ connection: 'x', collection: 'orders', item: '7' }, {})
    ).toMatchObject({ code: 'INVALID_OPTIONS' })
    expect(
      await createIssueFromFlow({ connection: 1, collection: '', item: '' }, {})
    ).toMatchObject({ code: 'NO_RECORD' })
    expect(
      await createIssueFromFlow({ connection: 1, collection: 'nivaro_users', item: '1' }, {})
    ).toMatchObject({ code: 'BAD_RECORD' })
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'orders', item: '404' },
        { userId: 'U-1', flowId: 'F-2' }
      )
    ).toEqual({ error: 'Record not found', code: 'NOT_FOUND' })
    expect(claims.released[0]).toEqual([5, 'error', 'Flow: Record not found (record orders:404)'])
  })

  it('registers the operation and the trigger; the handler resolves the record', async () => {
    await registerFlows()
    expect(registry.triggers.map((x) => x.type)).toEqual(['gitlab.issue_changed'])
    const op = registry.ops.find((o) => o.type === 'gitlab.create_issue')
    expect(op).toBeDefined()
    const res = await op?.handler(
      { connection: 1 },
      { collection: 'nivaro_tasks', item: '55' },
      ctxOf('F-1')
    )
    expect(res).toMatchObject({
      status: 'resolve',
      output: { $gitlab: { outbox_id: 77, kind: 'ticket', source_id: '55' } }
    })
    claims.ok = false
    const capped = await op?.handler(
      { connection: 1 },
      { collection: 'orders', item: '7' },
      ctxOf('F-1')
    )
    expect(capped).toMatchObject({ status: 'resolve', output: { $gitlab: { skipped: 'CAP' } } })
    feature.on = false
    const off = await op?.handler(
      { connection: 1 },
      { collection: 'orders', item: '7' },
      ctxOf('F-1')
    )
    expect(off).toMatchObject({
      status: 'resolve',
      output: { $gitlab: { skipped: 'FEATURE_OFF' } }
    })
  })
})

async function registerFlows() {
  const prev = process.env.CLOUD_META_DB_URL
  delete process.env.CLOUD_META_DB_URL
  try {
    await registerTrackerFlows({ log: {} } as never)
  } finally {
    if (prev !== undefined) process.env.CLOUD_META_DB_URL = prev
  }
}
