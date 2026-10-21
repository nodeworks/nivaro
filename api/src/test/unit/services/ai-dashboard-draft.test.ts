import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2736 — a drafted dashboard is a proposal built AS THE REQUESTER: only what they
// can read, laid out on the grid, previewed as them, saved only when they run it.

const state = vi.hoisted(() => ({
  refusals: new Map<string, string>(),
  checked: [] as Array<{ user: unknown; widget: Record<string, unknown> }>,
  plan: null as Record<string, unknown> | null,
  computed: [] as Array<{ user: unknown; type: string }>
}))

vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const q: Record<string, unknown> = {}
    for (const k of ['where', 'whereNot', 'whereIn', 'orderBy']) q[k] = () => q
    q.select = () =>
      Promise.resolve([{ field: 'amount' }, { field: 'vendor' }, { field: 'status' }])
    return q
  }
  return { db: Object.assign(() => chain(), { raw: () => '' }) }
})
vi.mock('../../../services/permissions.js', () => ({
  can: async (u: { id: string }, _a: string, c: string) => !(u.id === 'LIMITED' && c === 'payroll')
}))
vi.mock('../../../services/dashboard-widgets.js', () => ({
  widgetSourceRefusal: async (user: unknown, widget: Record<string, unknown>) => {
    state.checked.push({ user, widget })
    return state.refusals.get(String(widget.field ?? widget.type)) ?? null
  },
  computeWidgetData: async (w: { type: string }, _x: unknown, ctx: { user: unknown }) => {
    state.computed.push({ user: ctx.user, type: w.type })
    return { data: { value: 3 } }
  }
}))
vi.mock('../../../services/ai-plans.js', () => ({
  loadPlan: async () => ({ row: { id: 'P', user: 'U1', status: 'proposed' }, doc: state.plan }),
  assertOwner: (row: { user: string }, user: { id: string }) => {
    if (row.user !== user.id)
      throw Object.assign(new Error('Only the person who asked can run this plan'), {
        statusCode: 403
      })
  }
}))

const { buildAction } = await import('../../../services/ai-actions.js')
const { parseDraft, previewDraft } = await import('../../../services/ai-dashboard-draft.js')

const me = { id: 'U1' } as never

beforeEach(() => {
  state.refusals.clear()
  state.checked = []
  state.computed = []
})

describe('create_dashboard with ai_query widgets', () => {
  it('validates every widget as the requester and places them on the grid in order', async () => {
    const built = await buildAction(me, {
      action_type: 'create_dashboard',
      dashboard: {
        name: 'Invoice review',
        widgets: [
          { type: 'count', title: 'Waiting', collection: 'invoices' },
          { type: 'sum', title: 'Value', collection: 'invoices', field: 'amount' },
          {
            type: 'ai_query',
            title: 'Waiting by vendor',
            chart: 'bar',
            query: {
              tool: 'aggregate',
              input: { collection: 'invoices', op: 'count', group_by: 'vendor' }
            }
          }
        ]
      }
    })
    const widgets = built.payload.widgets as Array<Record<string, unknown>>
    expect(widgets.map((w) => [w.type, w.col, w.row, w.width, w.height])).toEqual([
      ['count', 0, 0, 1, 1],
      ['sum', 1, 0, 1, 1],
      ['ai_query', 2, 0, 2, 2]
    ])
    // The query is stored, not an answer: the widget recomputes as each viewer.
    expect(JSON.parse(String(widgets[2].filters))).toEqual({
      source: {
        tool: 'aggregate',
        input: { collection: 'invoices', op: 'count', group_by: 'vendor' }
      },
      chart: 'bar',
      question: 'Waiting by vendor'
    })
    expect(widgets[2].collection).toBe('invoices')
    expect(state.checked.every((c) => c.user === me)).toBe(true)
    expect(state.checked).toHaveLength(3)
  })

  it('a widget over a field the requester cannot read refuses with its reason', async () => {
    state.refusals.set('amount', 'You do not have access to the field "amount"')
    await expect(
      buildAction(me, {
        action_type: 'create_dashboard',
        dashboard: {
          name: 'x',
          widgets: [{ type: 'sum', title: 'Value', collection: 'invoices', field: 'amount' }]
        }
      })
    ).rejects.toThrow(/access to the field "amount"/)
    await expect(
      buildAction({ id: 'LIMITED' } as never, {
        action_type: 'create_dashboard',
        dashboard: { name: 'x', widgets: [{ type: 'count', title: 'n', collection: 'payroll' }] }
      })
    ).rejects.toThrow(/cannot read payroll/)
    await expect(
      buildAction(me, {
        action_type: 'create_dashboard',
        dashboard: {
          name: 'x',
          widgets: [{ type: 'ai_query', title: 'q', query: { tool: 'propose_plan' } }]
        }
      })
    ).rejects.toThrow(/needs query/)
  })
})

describe('parseDraft', () => {
  it('reads the JSON out of the reply and caps the widgets', () => {
    const d = parseDraft(
      `Here you go:\n{"name":"Reviewers","widgets":[${Array.from({ length: 15 }, () => '{"type":"count"}').join(',')}]}`
    )
    expect(d?.name).toBe('Reviewers')
    expect(d?.widgets).toHaveLength(12)
    expect(parseDraft('no json')).toBeNull()
    expect(parseDraft('{"name":"x","widgets":[]}')).toBeNull()
  })
})

describe('previewDraft', () => {
  it('computes each widget AS THE REQUESTER, and only for the person who asked', async () => {
    state.plan = {
      title: 'Dashboard: x',
      source: { kind: 'dashboard-draft' },
      steps: [
        {
          kind: 'create_dashboard',
          payload: {
            name: 'x',
            widgets: [
              {
                type: 'count',
                title: 'n',
                collection: 'invoices',
                field: null,
                filters: null,
                col: 0,
                row: 0,
                width: 1,
                height: 1
              }
            ]
          }
        }
      ],
      state: []
    }
    const out = await previewDraft(me, 'P')
    expect(out.widgets[0]).toMatchObject({ type: 'count', data: { value: 3 } })
    expect(state.computed).toEqual([{ user: me, type: 'count' }])
    await expect(previewDraft({ id: 'OTHER' } as never, 'P')).rejects.toThrow(/Only the person/)
  })

  it('refuses a plan that is not a dashboard draft', async () => {
    state.plan = {
      title: 'p',
      source: null,
      steps: [{ kind: 'bulk_update', payload: {} }],
      state: []
    }
    await expect(previewDraft(me, 'P')).rejects.toThrow('Not a dashboard draft')
  })
})
