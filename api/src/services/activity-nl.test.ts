import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_SEARCH_TOOL_NAME,
  type ActivitySearchCatalog,
  activitySearchTool,
  filtersFromToolInput,
  parseActivitySearch,
  toolInputOf
} from './activity-nl.js'

/** #10 natural-language activity search: words → filters through one forced tool call. */

const catalog: ActivitySearchCatalog = {
  collections: [
    { name: 'invoices', label: 'Invoices' },
    { name: 'nivaro_roles', label: null }
  ],
  actions: ['create', 'update', 'delete', 'login']
}
const NOW = new Date('2026-10-29T15:00:00.000Z')
const sam = { id: '11111111-2222-3333-4444-555555555555', name: 'Sam Lee', email: 'sam@x.io' }

function clientAnswering(res: unknown) {
  const create = vi.fn().mockResolvedValue(res)
  return { client: { messages: { create } }, create }
}

const toolUse = (input: unknown) => ({
  content: [{ type: 'tool_use', id: 't1', name: ACTIVITY_SEARCH_TOOL_NAME, input }]
})

describe('parseActivitySearch', () => {
  it('turns "deletes by Sam last week in invoices" into filters, resolving Sam server-side', async () => {
    const { client, create } = clientAnswering(
      toolUse({
        person: 'Sam',
        actions: ['delete'],
        collections: ['invoices'],
        range: 'last_week',
        from: null,
        to: null,
        item: null,
        text: null
      })
    )
    const findPeople = vi.fn().mockResolvedValue([sam])
    const r = await parseActivitySearch('deletes by Sam last week in invoices', {
      client,
      model: 'm',
      catalog,
      findPeople,
      now: NOW
    })
    expect(r.source).toBe('ai')
    expect(r.filters).toEqual({
      actions: ['delete'],
      collections: ['invoices'],
      range: 'last_week',
      user: sam.id
    })
    expect(r.user_label).toBe('Sam Lee')
    expect(findPeople).toHaveBeenCalledWith('Sam')
    // One call, forced onto the one tool, the words as the only user content.
    expect(create).toHaveBeenCalledTimes(1)
    const params = create.mock.calls[0][0]
    expect(params.tool_choice).toEqual({ type: 'auto' })
    expect(params.tools).toHaveLength(1)
    expect(params.messages).toEqual([
      { role: 'user', content: 'deletes by Sam last week in invoices' }
    ])
    expect(params.system).toContain('2026-10-29')
  })

  it('falls back to plain text search when the tool input is invalid JSON', async () => {
    const { client } = clientAnswering(toolUse('{"person": "Sam", actions: [oops'))
    const r = await parseActivitySearch('deletes by Sam', {
      client,
      model: 'm',
      catalog,
      findPeople: vi.fn()
    })
    expect(r).toMatchObject({ source: 'text', filters: { q: 'deletes by Sam' } })
    expect(r.note).toMatch(/not usable/)
  })

  it('falls back when the model answers in prose', async () => {
    const { client } = clientAnswering({ content: [{ type: 'text', text: 'Sure! Here you go.' }] })
    const r = await parseActivitySearch('who changed roles', {
      client,
      model: 'm',
      catalog,
      findPeople: vi.fn()
    })
    expect(r.source).toBe('text')
  })

  it('accepts a bare JSON object answered as text (gateway shims)', async () => {
    const { client } = clientAnswering({
      content: [{ type: 'text', text: '```json\n{"actions":["update"],"collections":[]}\n```' }]
    })
    const r = await parseActivitySearch('edits', {
      client,
      model: 'm',
      catalog,
      findPeople: vi.fn()
    })
    expect(r).toMatchObject({ source: 'ai', filters: { actions: ['update'] } })
  })

  it('searches the words when AI is off, or the call fails', async () => {
    const off = await parseActivitySearch('x', {
      client: null,
      model: 'm',
      catalog,
      findPeople: vi.fn()
    })
    expect(off).toMatchObject({ source: 'text', filters: { q: 'x' } })
    const failing = { messages: { create: vi.fn().mockRejectedValue(new Error('429 limited')) } }
    const r = await parseActivitySearch('y', {
      client: failing,
      model: 'm',
      catalog,
      findPeople: vi.fn()
    })
    expect(r).toMatchObject({ source: 'text', filters: { q: 'y' } })
    expect(r.note).toContain('429')
  })

  it('keeps an unknown person as text search and offers other candidates', async () => {
    const { client } = clientAnswering(toolUse({ person: 'Zed', actions: [], collections: [] }))
    const none = await parseActivitySearch('by Zed', {
      client,
      model: 'm',
      catalog,
      findPeople: vi.fn().mockResolvedValue([])
    })
    expect(none.filters).toEqual({ q: 'Zed' })
    expect(none.unmatched_person).toBe('Zed')

    const two = await parseActivitySearch('by Sam', {
      client,
      model: 'm',
      catalog,
      findPeople: vi.fn().mockResolvedValue([sam, { id: 'x', name: 'Samira' }])
    })
    expect(two.filters.user).toBe(sam.id)
    expect(two.person_candidates).toHaveLength(2)
  })
})

describe('filtersFromToolInput', () => {
  it('drops collections, actions and dates the catalog / validator does not know', () => {
    const { filters, person } = filtersFromToolInput(
      {
        person: '  ',
        actions: ['DELETE', 'drop table'],
        collections: ['Invoices', 'users; --'],
        range: 'fortnight',
        from: '2026-10-01',
        to: 'yesterday-ish',
        item: '42',
        text: 'refund'
      },
      catalog
    )
    expect(person).toBeNull()
    expect(filters).toEqual({
      actions: ['delete'],
      collections: ['invoices'],
      from: '2026-10-01',
      item: '42',
      q: 'refund'
    })
  })

  it('never sends both a relative range and dates', () => {
    const { filters } = filtersFromToolInput(
      { range: 'this_week', from: '2026-10-01', to: '2026-10-02' },
      catalog
    )
    expect(filters).toEqual({ range: 'this_week' })
  })
})

describe('tool schema + answer reading', () => {
  it('pins the catalog as enums and forbids extra keys', () => {
    const t = activitySearchTool(catalog)
    expect(t.input_schema.additionalProperties).toBe(false)
    expect(t.input_schema.properties.collections.items).toEqual({
      type: 'string',
      enum: ['invoices', 'nivaro_roles']
    })
    expect(t.input_schema.required).toContain('person')
  })

  it('reads tool input whether it arrives as an object or a JSON string', () => {
    expect(toolInputOf(toolUse({ a: 1 }))).toEqual({ a: 1 })
    expect(toolInputOf(toolUse('{"a":2}'))).toEqual({ a: 2 })
    expect(toolInputOf(toolUse('[1]'))).toBeNull()
    expect(toolInputOf(null)).toBeNull()
  })
})
