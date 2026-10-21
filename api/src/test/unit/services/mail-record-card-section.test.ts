import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  section: null as null | Array<{ field: string; label: string | null; format: string | null }>,
  header: [] as Array<{ field: string; label_override: string | null }>
}))

vi.mock('../../../services/app-links.js', () => ({ recordLink: async () => 'https://x/rec/1' }))
vi.mock('../../../services/queues.js', () => ({
  getLabels: async () => ({ 'tickets:1': 'Ticket 1' }),
  resolvePathValues: async (_c: string, ids: string[], segments: string[]) =>
    new Map(ids.map((id) => [id, { value: `v:${segments.join('.')}` }]))
}))
vi.mock('../../../services/layout-email-section.js', () => ({
  emailSummaryFields: async () => state.section
}))
vi.mock('../../../db/index.js', () => {
  const chain = (rows: unknown) => {
    const q: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'orderBy', 'select']) q[m] = () => q
    q.first = async () => (Array.isArray(rows) ? rows[0] : rows)
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaitable
    q.then = (res: (v: unknown) => unknown) => res(rows)
    q.catch = () => q
    return q
  }
  const db = (table: string) => {
    if (table === 'nivaro_collection_layouts') return chain({ id: 5 })
    if (table === 'nivaro_layout_field_assignments')
      return chain(
        state.header.map((h) => ({ ...h, overrides: null, is_visible: true, field: h.field }))
      )
    if (table === 'nivaro_fields') return chain([])
    return chain({ singular: 'Ticket', display_name: 'Tickets' })
  }
  return { db }
})

import { buildRecordCard } from '../../../services/mail-record-card.js'

describe('record card summary (#2725)', () => {
  beforeEach(() => {
    state.section = null
    state.header = [{ field: 'header_field', label_override: 'Header' }]
  })

  it('falls back to the header strip when the layout names no email section', async () => {
    const card = await buildRecordCard('tickets', 1)
    expect(card.fields.map((f) => f.key)).toEqual(['header_field'])
  })

  it('uses the chosen section’s fields, with its labels, instead of the header strip', async () => {
    state.section = [
      { field: 'title', label: 'Subject', format: null },
      { field: 'site.name', label: null, format: null }
    ]
    const card = await buildRecordCard('tickets', 1, { recipientUserId: 'u1' })
    expect(card.fields.map((f) => [f.key, f.label, f.value])).toEqual([
      ['title', 'Subject', 'v:title'],
      ['site.name', 'Site Name', 'v:site.name']
    ])
  })

  it('a section cut to nothing for this recipient shows no fields, not the header strip', async () => {
    state.section = []
    const card = await buildRecordCard('tickets', 1, { recipientUserId: 'u1' })
    expect(card.fields).toEqual([])
  })
})
