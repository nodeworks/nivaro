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
const links = vi.hoisted(() => ({ calls: [] as unknown[][] }))
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
      return { outboxId: 77 }
    }
  }
})
vi.mock('../users.js', () => ({
  getUser: async (id: string) => (id === 'U-1' ? { id, status: 'active', role: 'r' } : undefined)
}))
vi.mock('../flow-executor.js', () => ({
  resolveFlowCreator: async (flowId: string) => (flowId === 'F-1' ? 'U-1' : null)
}))

import { createIssueFromFlow, flowSource, registerTrackerFlows } from './flow-ops.js'

beforeEach(() => {
  feature.on = true
  links.calls.length = 0
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
  })

  it('registers the operation and the trigger; the handler resolves the record', async () => {
    const prev = process.env.CLOUD_META_DB_URL
    delete process.env.CLOUD_META_DB_URL
    try {
      await registerTrackerFlows({ log: {} } as never)
    } finally {
      if (prev !== undefined) process.env.CLOUD_META_DB_URL = prev
    }
    expect(registry.triggers.map((x) => x.type)).toEqual(['gitlab.issue_changed'])
    const op = registry.ops.find((o) => o.type === 'gitlab.create_issue')
    expect(op).toBeDefined()
    const res = await op?.handler(
      { connection: 1 },
      { collection: 'nivaro_tasks', item: '55' },
      { flowId: 'F-3', flowName: 'x', trigger: 't', payload: {}, log: {} }
    )
    expect(res).toMatchObject({
      status: 'resolve',
      output: { $gitlab: { outbox_id: 77, kind: 'ticket', source_id: '55' } }
    })
    feature.on = false
    const off = await op?.handler(
      { connection: 1 },
      { collection: 'orders', item: '7' },
      { flowId: 'F-3', flowName: 'x', trigger: 't', payload: {}, log: {} }
    )
    expect(off).toMatchObject({
      status: 'resolve',
      output: { $gitlab: { skipped: 'FEATURE_OFF' } }
    })
  })
})
