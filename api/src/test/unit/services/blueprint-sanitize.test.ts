import { describe, expect, it } from 'vitest'
import {
  ALLOWED_COLUMNS,
  reviewNotes,
  sanitizeBlueprint,
  TEMPLATE_CAPS
} from '../../../services/blueprint-sanitize.js'
import type { Blueprint } from '../../../services/blueprints.js'

// Hub enhancement 24, review M3/L4: what a Hub template may carry into an app.

function bp(over: Partial<Blueprint> = {}): Blueprint {
  return {
    type: 'nivaro-blueprint',
    version: 1,
    name: 'T',
    exported_at: 'x',
    collections: [
      {
        meta: {
          id: 4,
          collection: 'assets',
          display_name: 'Assets',
          is_virtual: true,
          virtual_sql: 'SELECT 1; DROP TABLE nivaro_users',
          accountability: null,
          read_logging: 'off',
          workspace: 'w'
        },
        fields: [
          { id: 9, field: 'name', type: 'string', remote_options_config: '{"url":"http://x"}' },
          { field: 'bad name', type: 'string' }
        ]
      }
    ],
    relations: [
      { id: 1, many_collection: 'assets', many_field: 'site', one_collection: 'nivaro_users' },
      { many_collection: 'assets', many_field: 'file', one_collection: 'nivaro_files' }
    ],
    workflows: [
      {
        template: { id: 'wf1', name: 'Flow', created_at: 'x' },
        states: [{ id: 's1', key: 'a' }],
        transitions: [{ id: 't1', actions: JSON.stringify([{ type: 'webhook' }, { type: 'x' }]) }],
        bindings: [{ id: 3, collection: 'assets' }, { collection: 'nivaro_users' }]
      },
      { template: { id: 'wf2' }, states: [], transitions: [], bindings: [{ collection: 'orders' }] }
    ],
    layouts: [
      {
        layout: { id: 1, collection: 'assets', name: 'Main', pdf_template_id: 3 },
        groups: [],
        assignments: [{ id: 1, widget_id: 2, field: 'name' }]
      },
      { layout: { collection: 'NIVARO_users', name: 'x' }, groups: [], assignments: [] }
    ],
    queues: [
      {
        queue: { id: 'q1', name: 'Q', owner: 'u' },
        sources: [{ type: 'collection', collection: 'assets' }]
      },
      {
        queue: { id: 'q2', name: 'Other' },
        sources: [{ type: 'collection', collection: 'orders' }]
      }
    ],
    rules: [
      { name: 'r1', collection: 'assets', actions: '[]' },
      { name: 'r2', collection: 'nivaro_roles', actions: '[]' }
    ],
    ...over
  }
}

describe('sanitizeBlueprint', () => {
  it('keeps listed columns only: no virtual SQL, audit switches, outbound config or source ids', () => {
    const { blueprint: out, review } = sanitizeBlueprint(bp())
    const meta = out.collections[0].meta
    expect(meta).toEqual({ collection: 'assets', display_name: 'Assets' })
    expect(out.collections[0].fields).toEqual([
      { field: 'name', type: 'string', collection: 'assets' }
    ])
    expect(review.virtual_removed).toEqual(['assets'])
    expect(review.stripped).toMatchObject({
      'collections.virtual_sql': 1,
      'collections.is_virtual': 1,
      'collections.accountability': 1,
      'collections.read_logging': 1,
      'fields.remote_options_config': 1
    })
    expect(out.layouts[0].layout).toEqual({ collection: 'assets', name: 'Main' })
    expect(out.layouts[0].assignments).toEqual([{ field: 'name' }])
    expect(out.queues[0].queue).toEqual({ id: 'q1', name: 'Q' })
  })

  it('refuses every part that reaches outside the template’s own collections (any case)', () => {
    const { blueprint: out, review } = sanitizeBlueprint(bp())
    expect(out.relations).toEqual([
      { many_collection: 'assets', many_field: 'file', one_collection: 'nivaro_files' }
    ])
    expect(out.workflows.map((w) => w.template.id)).toEqual(['wf1'])
    expect(out.workflows[0].bindings).toEqual([{ collection: 'assets', template: 'wf1' }])
    expect(out.layouts).toHaveLength(1)
    expect(out.queues.map((q) => q.queue.id)).toEqual(['q1'])
    expect(out.rules.map((r) => r.name)).toEqual(['r1'])
    expect(review.refused.length).toBeGreaterThanOrEqual(6)
    expect(review.transition_actions).toBe(2)
  })

  it('a system or malformed collection name is refused, NIVARO_ spelled any way', () => {
    const { blueprint: out, review } = sanitizeBlueprint(
      bp({
        collections: [
          { meta: { collection: 'NIVARO_users' }, fields: [] },
          { meta: { collection: 'directus_x' }, fields: [] },
          { meta: { collection: 'a;b' }, fields: [] }
        ]
      })
    )
    expect(out.collections).toEqual([])
    expect(review.refused.filter((r) => r.startsWith('Collection'))).toHaveLength(3)
  })

  it('refuses a bad shape and too many parts (L4)', () => {
    expect(() => sanitizeBlueprint(bp({ relations: 'x' as never }))).toThrow(
      expect.objectContaining({ code: 'BAD_SHAPE' })
    )
    const many = Array.from({ length: TEMPLATE_CAPS.collections + 1 }, (_, i) => ({
      meta: { collection: `c${i}` },
      fields: []
    }))
    expect(() => sanitizeBlueprint(bp({ collections: many }))).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_PARTS' })
    )
  })

  it('is stable: a sanitized template passes unchanged', () => {
    const once = sanitizeBlueprint(bp()).blueprint
    const twice = sanitizeBlueprint(once)
    expect(twice.blueprint).toEqual(once)
    expect(Object.keys(twice.review.stripped)).toEqual([])
  })

  it('never keeps the dangerous columns, whatever is added to the lists later', () => {
    for (const c of ['is_virtual', 'virtual_sql', 'accountability', 'read_logging', 'workspace'])
      expect(ALLOWED_COLUMNS.collections.has(c), c).toBe(false)
    for (const c of ['remote_options_config', 'cross_record_defaults'])
      expect(ALLOWED_COLUMNS.fields.has(c), c).toBe(false)
  })

  it('reviewNotes words what was removed', () => {
    const notes = reviewNotes(sanitizeBlueprint(bp()).review)
    expect(notes[0]).toMatch(/Virtual SQL removed: assets/)
    expect(notes.join(' ')).toMatch(/Left out/)
  })
})
