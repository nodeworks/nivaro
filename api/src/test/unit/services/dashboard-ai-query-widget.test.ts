import { describe, expect, it, vi } from 'vitest'

// #2738 — an ai_query widget computes through the same function every dashboard read
// uses, AS THE VIEWER; a widget with no viewer never computes.

const runs = vi.hoisted(() => [] as Array<{ user: unknown; tool: string }>)
vi.mock('../../../services/ai-chat.js', () => ({
  executeChatTool: async (user: { id: string }, tool: string) => {
    runs.push({ user, tool })
    if (user.id === 'NOREAD') throw new Error('No read access')
    return { result: [{ vendor: 'Acme', value: user.id === 'A' ? 5 : 2 }], summary: '' }
  }
}))

const { computeWidgetData, widgetSourceRefusal } = await import(
  '../../../services/dashboard-widgets.js'
)

const widget = {
  type: 'ai_query',
  collection: 'invoices',
  field: null,
  filters: JSON.stringify({
    source: {
      tool: 'aggregate',
      input: { collection: 'invoices', op: 'count', group_by: 'vendor' }
    },
    question: 'By vendor'
  })
}

describe('ai_query widgets', () => {
  it('each viewer gets their own figures', async () => {
    const a = await computeWidgetData(widget, [], { user: { id: 'A' } as never })
    const b = await computeWidgetData(widget, [], { user: { id: 'B' } as never })
    expect(a).toEqual({
      data: { chart: { type: 'bar', data: [{ label: 'Acme', value: 5 }] }, question: 'By vendor' }
    })
    expect(b).toMatchObject({ data: { chart: { data: [{ label: 'Acme', value: 2 }] } } })
    expect(runs.map((r) => (r.user as { id: string }).id)).toEqual(['A', 'B'])
  })

  it('no viewer, a refusal, or no stored query never computes figures', async () => {
    expect(await computeWidgetData(widget, [], {})).toEqual({ error: 'Forbidden', status: 403 })
    expect(await computeWidgetData(widget, [], { user: { id: 'NOREAD' } as never })).toEqual({
      error: 'Forbidden',
      status: 403
    })
    expect(
      await computeWidgetData({ ...widget, filters: null }, [], { user: { id: 'A' } as never })
    ).toEqual({ error: 'This widget has no query', status: 400 })
  })

  it('an author may add one only when the query runs for them', async () => {
    expect(await widgetSourceRefusal({ id: 'A' } as never, widget)).toBeNull()
    expect(await widgetSourceRefusal({ id: 'NOREAD' } as never, widget)).toBe('No read access')
    expect(await widgetSourceRefusal({ id: 'A' } as never, { ...widget, filters: '{}' })).toMatch(
      /needs a query/
    )
  })
})
