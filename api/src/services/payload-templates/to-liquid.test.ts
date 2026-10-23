import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { payloadLiquid } from '../payload-filters.js'
import { evaluateMap, neutralizeSecretMarkers, SECRET_PLACEHOLDER } from './evaluate.js'
import { convertIfEqual, convertTemplate, specToLiquid } from './to-liquid.js'
import type { Field, MapSpec, Transform } from './types.js'

// The database is mocked globally (src/test/setup.ts): the instance zone falls
// back to Eastern and there are no blackout dates.

const spec = (fields: Field[]): MapSpec => ({ v: 1, fields })
const f = (over: Partial<Field> & Pick<Field, 'id' | 'key'>): Field => ({
  type: 'text',
  include: 'always',
  ...over
})

const SECRETS = { token: SECRET_PLACEHOLDER('token') }

/** Render the generated Liquid the way the test brief says: parseAndRender → JSON.parse. */
async function renderLiquid(liquid: string, scope: Record<string, unknown>): Promise<unknown> {
  const text = await payloadLiquid().parseAndRender(liquid, {
    ...(neutralizeSecretMarkers(scope) as Record<string, unknown>),
    secrets: SECRETS
  })
  return JSON.parse(text)
}

/** Converts, and independently proves byte-equal output over every scope. */
async function expectConverts(s: MapSpec, scopes: Record<string, unknown>[]): Promise<string> {
  const res = await convertIfEqual(s, scopes)
  if (!res.ok) throw new Error(`not converted: ${JSON.stringify(res.diffs, null, 2)}`)
  for (const scope of scopes) {
    const { body } = await evaluateMap(s, scope)
    const out = await renderLiquid(res.liquid, scope)
    expect(JSON.stringify(out)).toBe(JSON.stringify(body))
  }
  return res.liquid
}

// ─── Seed-shaped fixtures ────────────────────────────────────────────────────

/** fusion-transfer-order: header + order lines (where, number_as, nested objects). */
const transferOrder = spec([
  f({
    id: 'h1',
    key: 'orderNumber',
    value: {
      source: 'path',
      path: 'record.request_number',
      transforms: [{ op: 'pad_start', n: 9, char: '0' }]
    }
  }),
  f({
    id: 'h2',
    key: 'needByDate',
    type: 'date',
    value: {
      source: 'path',
      path: 'record.need_by',
      transforms: [{ op: 'at_least_days_out', n: 3 }]
    }
  }),
  f({
    id: 'h3',
    key: 'requester',
    value: {
      source: 'builtin',
      name: 'acting_user.name',
      fallbacks: [{ source: 'builtin', name: 'acting_user.email' }]
    }
  }),
  f({ id: 'h4', key: 'today', type: 'date', value: { source: 'builtin', name: 'today' } }),
  f({
    id: 'h5',
    key: 'shipTo',
    type: 'object',
    children: [
      f({
        id: 'h5a',
        key: 'site',
        value: { source: 'path', path: 'record.site.code', transforms: [{ op: 'upper' }] }
      }),
      f({
        id: 'h5b',
        key: 'zip',
        type: 'number',
        value: { source: 'path', path: 'record.site.zip' }
      })
    ]
  }),
  f({
    id: 'l',
    key: 'orderLines',
    type: 'list',
    list: {
      source: 'context.materials',
      item: 'line',
      number_as: 'n',
      where: [{ field: 'quantity', op: 'gt', value: 0 }]
    },
    children: [
      f({
        id: 'l1',
        key: 'lineNumber',
        type: 'number',
        value: { source: 'builtin', name: 'list.number' }
      }),
      f({
        id: 'l2',
        key: 'itemNumber',
        value: {
          source: 'path',
          path: 'item_number',
          transforms: [{ op: 'pad_start', n: 9, char: '0' }]
        }
      }),
      f({
        id: 'l3',
        key: 'quantity',
        type: 'number',
        value: { source: 'path', path: 'line.quantity' }
      }),
      f({ id: 'l4', key: 'uom', value: { source: 'fixed', value: 'EA' } }),
      f({
        id: 'l5',
        key: 'description',
        value: {
          source: 'path',
          path: 'line.description',
          transforms: [{ op: 'trim' }, { op: 'truncate', n: 10 }]
        }
      }),
      f({
        id: 'l6',
        key: 'cifa',
        include: 'not_empty',
        value: { source: 'path', path: 'line.cifa_data.cifa_number' }
      }),
      f({ id: 'l7', key: 'project', value: { source: 'path', path: 'record.project_id' } }),
      f({
        id: 'l8',
        key: 'ref',
        value: { source: 'formula', liquid: '{{ n }}-{{ line.item_number }}' }
      }),
      f({
        id: 'l9',
        key: 'flags',
        type: 'object',
        children: [
          f({
            id: 'l9a',
            key: 'serialized',
            type: 'boolean',
            value: { source: 'path', path: 'line.serialized' }
          })
        ]
      })
    ]
  })
])

const transferScopes = [
  {
    record: {
      request_number: '106416',
      need_by: '2026-10-30',
      project_id: 77,
      site: { code: 'phl-01', zip: '19103' }
    },
    acting_user: { name: 'Pat Lee', email: 'pat@x.com' },
    context: {
      materials: [
        {
          item_number: '42',
          quantity: 2,
          description: '  Fiber spool, 2km  ',
          cifa_data: { cifa_number: 'C-1' },
          serialized: 1
        },
        { item_number: '43', quantity: 0, description: 'skipped' },
        { item_number: 44, quantity: '3', description: 'Patch', serialized: 'false' }
      ]
    }
  },
  {
    record: { request_number: 7, need_by: '2026-10-01', project_id: null, site: null },
    acting_user: { first_name: 'Ana', last_name: 'Ruiz', email: 'ana@x.com' },
    context: { materials: [] }
  },
  {
    record: { request_number: null, need_by: null, site: { code: 'nyc' } },
    acting_user: { email: 'bot@x.com' },
    context: {
      materials: [{ item_number: '1234567890', quantity: 1, description: null, serialized: true }]
    }
  }
]

/** mwf-workflow-status: secret token, switch on state, fallbacks, coercions, json formula. */
const workflowStatus = spec([
  f({ id: 'w1', key: 'token', value: { source: 'secret', name: 'token' } }),
  f({ id: 'w2', key: 'workflow_id', value: { source: 'path', path: 'record.workflow_id' } }),
  f({
    id: 'w3',
    key: 'status',
    value: {
      source: 'switch',
      cases: [
        {
          when: [{ field: 'record.state_key', op: 'eq', value: 'approved' }],
          value: { source: 'fixed', value: 'APPROVED' }
        },
        {
          when: [{ field: 'record.state_key', op: 'in', value: 'rejected, sent_back' }],
          value: { source: 'path', path: 'state.external_label', transforms: [{ op: 'lower' }] }
        }
      ],
      else: { source: 'fixed', value: 'PENDING' }
    }
  }),
  f({
    id: 'w4',
    key: 'notes',
    value: {
      source: 'path',
      path: 'record.notes',
      fallbacks: [
        { source: 'path', path: 'record.description' },
        { source: 'fixed', value: 'n/a' }
      ],
      transforms: [{ op: 'upper' }]
    }
  }),
  f({
    id: 'w5',
    key: 'approved',
    type: 'boolean',
    value: { source: 'path', path: 'record.is_approved' }
  }),
  f({ id: 'w6', key: 'amount', type: 'number', value: { source: 'path', path: 'record.amount' } }),
  f({
    id: 'w7',
    key: 'meta',
    type: 'json',
    value: { source: 'formula', liquid: '{"amount": {{ record.amount | jsonify }}, "v": 2}' }
  }),
  f({
    id: 'w8',
    key: 'big',
    type: 'boolean',
    include: { when: [{ field: 'record.amount', op: 'gte', value: 100 }] },
    value: { source: 'fixed', value: true }
  }),
  f({
    id: 'w9',
    key: 'priority',
    include: {
      when: [
        { field: 'record.title', op: 'contains', value: 'URGENT ' },
        { field: 'record.state_key', op: 'neq', value: 'rejected' },
        { field: 'record.owner', op: 'nnull', value: null }
      ]
    },
    value: { source: 'fixed', value: 'high' }
  }),
  f({
    id: 'w10',
    key: 'unassigned',
    type: 'boolean',
    include: { when: [{ field: 'record.owner', op: 'null', value: null }] },
    value: { source: 'fixed', value: 1 }
  }),
  f({ id: 'w11', key: 'label', value: { source: 'builtin', name: 'state.label' } }),
  f({
    id: 'w12',
    key: 'raw',
    type: 'json',
    value: { source: 'path', path: 'record.extra' }
  })
])

const workflowScopes = [
  {
    record: {
      workflow_id: 'WF-1',
      state_key: 'approved',
      notes: 'ok to ship',
      is_approved: '1',
      amount: '12.50',
      title: 'urgent fix',
      owner: 'u1',
      extra: { a: [1, 'two'] }
    },
    state: { label: 'Approved', external_label: 'APPROVED' }
  },
  {
    record: {
      workflow_id: 9,
      state_key: 'sent_back',
      notes: '',
      description: 'see thread',
      is_approved: false,
      amount: 250,
      title: 'Not urgent',
      owner: null
    },
    state: { label: 'Sent back', external_label: 'Sent Back' }
  },
  {
    record: {
      workflow_id: null,
      state_key: 'draft',
      is_approved: 'maybe',
      amount: 'abc',
      title: null,
      owner: '',
      extra: 'plain'
    },
    state: null
  }
]

/** linx-project-update: not_empty, scalar lists, join/replace/date/editor_text, day rules. */
const projectUpdate = spec([
  f({ id: 'p1', key: 'project', value: { source: 'path', path: 'record.project_code' } }),
  f({
    id: 'p2',
    key: 'poNumbers',
    type: 'list',
    include: 'not_empty',
    list: { source: 'record.po_numbers', item: 'po', scalar: true },
    children: [
      f({
        id: 'p2a',
        key: 'po',
        include: 'not_empty',
        value: { source: 'path', path: 'po', transforms: [{ op: 'prefix', text: 'PO-' }] }
      })
    ]
  }),
  f({
    id: 'p3',
    key: 'emails',
    type: 'list',
    list: { source: 'context.emails', item: 'email', scalar: true },
    children: [f({ id: 'p3a', key: 'email' })]
  }),
  f({
    id: 'p4',
    key: 'tags',
    include: 'not_empty',
    value: { source: 'path', path: 'record.tags', transforms: [{ op: 'join', sep: '; ' }] }
  }),
  f({
    id: 'p5',
    key: 'summary',
    include: 'not_empty',
    value: {
      source: 'path',
      path: 'record.notes',
      transforms: [{ op: 'editor_text' }, { op: 'replace', from: 'colour', to: 'color' }]
    }
  }),
  f({
    id: 'p6',
    key: 'start',
    value: {
      source: 'path',
      path: 'record.start_date',
      transforms: [{ op: 'date', format: '%m/%d/%Y' }]
    }
  }),
  f({
    id: 'p7',
    key: 'followUp',
    type: 'date',
    value: {
      source: 'path',
      path: 'record.start_date',
      transforms: [{ op: 'add_days', n: 5 }, { op: 'next_open_day' }]
    }
  }),
  f({
    id: 'p8',
    key: 'soon',
    type: 'boolean',
    include: { when: [{ field: 'record.start_date', op: 'within_days', value: 7 }] },
    value: { source: 'fixed', value: true }
  }),
  f({
    id: 'p9',
    key: 'late',
    type: 'boolean',
    include: { when: [{ field: 'record.start_date', op: 'beyond_days', value: 30 }] },
    value: { source: 'fixed', value: true }
  }),
  f({
    id: 'p10',
    key: 'comment',
    include: 'not_empty',
    value: { source: 'path', path: 'record.comment' }
  }),
  f({
    id: 'p11',
    key: 'sites',
    type: 'list',
    list: { source: 'record.sites', item: 'site' },
    children: [
      f({ id: 'p11a', key: 'code', value: { source: 'path', path: 'site.code' } }),
      f({
        id: 'p11b',
        key: 'racks',
        type: 'list',
        list: {
          source: 'site.racks',
          item: 'rack',
          number_as: 'r',
          // the map numbers items after the filter: r is 0 while it runs
          where: [{ field: 'r', op: 'lt', value: 1 }]
        },
        children: [
          f({ id: 'p11c', key: 'n', type: 'number', value: { source: 'path', path: 'r' } }),
          f({ id: 'p11d', key: 'site', value: { source: 'path', path: 'site.code' } }),
          f({
            id: 'p11e',
            key: 'label',
            value: { source: 'formula', liquid: '{{ site.code }}/{{ rack.name }}#{{ r }}' }
          })
        ]
      })
    ]
  })
])

const projectScopes = [
  {
    record: {
      project_code: 'P-100',
      po_numbers: ['4500', '', '4501'],
      tags: ['fiber', 'urgent'],
      notes: JSON.stringify({
        blocks: [{ data: { text: 'Blue <b>colour</b>' } }, { data: { text: 'second' } }]
      }),
      start_date: '2026-10-24',
      comment: '',
      sites: [
        { code: 'A', racks: [{ name: 'r1' }, { name: 'r2' }] },
        { code: 'B', racks: [] }
      ]
    },
    context: { emails: ['a@x.com', 'b@x.com'] }
  },
  {
    record: {
      project_code: 'P-200',
      po_numbers: [],
      tags: 'single',
      notes: 'plain colour text',
      start_date: '2026-12-31',
      comment: 'hello',
      sites: null
    },
    context: { emails: [] }
  },
  {
    record: { project_code: null, po_numbers: null, tags: null, notes: null, start_date: null },
    context: {}
  }
]

describe('specToLiquid / convertIfEqual', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Thursday 12:00 PM Eastern
    vi.setSystemTime(new Date('2026-10-22T16:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('converts a transfer-order shaped map (lists, where, number_as, nested objects)', async () => {
    const liquid = await expectConverts(transferOrder, transferScopes)
    // the check is not vacuous: the first scope really has lines
    const { body } = await evaluateMap(transferOrder, transferScopes[0])
    expect(body.orderLines).toEqual([
      {
        lineNumber: 1,
        itemNumber: '000000042',
        quantity: 2,
        uom: 'EA',
        description: 'Fiber spoo',
        cifa: 'C-1',
        project: '77',
        ref: '1-42',
        flags: { serialized: true }
      },
      {
        lineNumber: 2,
        itemNumber: '000000044',
        quantity: 3,
        uom: 'EA',
        description: 'Patch',
        project: '77',
        ref: '2-44',
        flags: { serialized: false }
      }
    ])
    expect(body.needByDate).toBe('2026-10-30')
    expect(liquid).toContain('{% for line in ')
  })

  it('converts a workflow-status shaped map (secret, switch, fallbacks, coercions)', async () => {
    const liquid = await expectConverts(workflowStatus, workflowScopes)
    const { body } = await evaluateMap(workflowStatus, workflowScopes[1])
    expect(body).toMatchObject({
      token: SECRET_PLACEHOLDER('token'),
      status: 'sent back',
      notes: 'SEE THREAD',
      approved: false,
      amount: 250,
      big: true,
      unassigned: true
    })
    expect(liquid).toContain('secrets[')
  })

  it('converts a project-update shaped map (not_empty, scalar lists, transforms, day rules)', async () => {
    await expectConverts(projectUpdate, projectScopes)
    const { body } = await evaluateMap(projectUpdate, projectScopes[0])
    expect(body.poNumbers).toEqual(['PO-4500', 'PO-', 'PO-4501'])
    expect(body.summary).toBe('Blue color second')
    expect(body.soon).toBe(true)
    expect(body).not.toHaveProperty('comment')
    expect(body.sites).toEqual([
      {
        code: 'A',
        racks: [
          { n: 1, site: 'A', label: 'A/r1#1' },
          { n: 2, site: 'A', label: 'A/r2#2' }
        ]
      },
      { code: 'B', racks: [] }
    ])
  })

  it('carries awkward literal text and keys exactly', async () => {
    const nasty = [
      "it's",
      'back\\slash',
      'tag %} end',
      'out }} put',
      '{{ not liquid }}',
      '{% raw %}',
      'line\nbreak\ttab',
      'quote " mark',
      'emoji 😀 é',
      '{'
    ]
    const s = spec([
      ...nasty.map((text, i) =>
        f({ id: `k${i}`, key: text, value: { source: 'fixed', value: text } })
      ),
      f({ id: 'n1', key: 'n', type: 'number', value: { source: 'fixed', value: -0.000125 } }),
      f({ id: 'n2', key: 'big', type: 'number', value: { source: 'fixed', value: 1e21 } }),
      f({ id: 'n3', key: 'none', value: { source: 'fixed', value: null } }),
      f({
        id: 'n4',
        key: 'wrapped',
        value: {
          source: 'path',
          path: 'record.v',
          transforms: [
            { op: 'prefix', text: "<'%}" },
            { op: 'suffix', text: '\\"' }
          ]
        }
      }),
      f({ id: 'n5', key: 'odd key', value: { source: 'path', path: 'record.odd key' } }),
      f({ id: 'n6', key: 'idx', value: { source: 'path', path: 'record.list[1]' } })
    ])
    await expectConverts(s, [
      { record: { v: 'x', list: ['a', 'b'], 'odd key': 'spaced' } },
      { record: { v: 42 } },
      { record: {} }
    ])
  })

  it('matches the map on edge values for every type, transform and rule op', async () => {
    const values: unknown[] = [
      null,
      undefined,
      '',
      ' ',
      '0',
      '1',
      'true',
      ' FALSE ',
      0,
      1,
      -0,
      12.5,
      true,
      false,
      [],
      [1, 'a', null],
      {},
      { a: 1 },
      new Date('2026-10-22T03:00:00Z'),
      '2026-10-22T03:00:00Z',
      '2026-10-25',
      'abc',
      '  12 ',
      'Infinity',
      '<p>html &amp; note</p>'
    ]
    const types = ['text', 'number', 'boolean', 'date', 'json'] as const
    const transformSets: Transform[][] = [
      [],
      [{ op: 'trim' }, { op: 'upper' }],
      [
        { op: 'truncate', n: 2 },
        { op: 'suffix', text: '!' }
      ],
      [{ op: 'pad_start', n: 4, char: '0' }],
      [{ op: 'replace', from: 'a', to: 'b' }, { op: 'lower' }],
      [{ op: 'join', sep: '|' }],
      [{ op: 'date', format: '%Y/%m/%d' }],
      [{ op: 'add_days', n: 1 }],
      [{ op: 'at_least_days_out', n: 2 }],
      [{ op: 'editor_text' }]
    ]
    const fields: Field[] = []
    types.forEach((type, ti) => {
      transformSets.forEach((transforms, si) => {
        fields.push(
          f({
            id: `v${ti}_${si}`,
            key: `${type}_${si}`,
            type,
            include: si % 2 ? 'not_empty' : 'always',
            value: { source: 'path', path: 'record.x', transforms }
          })
        )
      })
    })
    const ops: Array<[string, unknown]> = [
      ['null', null],
      ['nnull', null],
      ['contains', 'A'],
      ['eq', '1'],
      ['eq', 'abc'],
      ['neq', 0],
      ['in', '1, abc, true'],
      ['gt', 0],
      ['lte', '2026-10-22'],
      ['gte', 'b'],
      ['within_days', 3],
      ['beyond_days', -1],
      ['lt', null],
      ['bogus', 1]
    ]
    ops.forEach(([op, value], i) => {
      fields.push(
        f({
          id: `r${i}`,
          key: `rule_${i}_${op}`,
          type: 'boolean',
          include: { when: [{ field: 'record.x', op, value: value as string }] },
          value: { source: 'fixed', value: true }
        })
      )
    })
    const s = spec(fields)
    await expectConverts(
      s,
      values.map((x) => ({ record: { x } }))
    )
  })

  it('spells the evaluator rules: item fields before scope keys, transforms on each fallback', async () => {
    // Rendered directly (not via the map): these pin the rules the map follows.
    const s = spec([
      f({
        id: 'l',
        key: 'lines',
        type: 'list',
        list: { source: 'record.lines', item: 'line' },
        children: [
          f({ id: 'a', key: 'state', value: { source: 'path', path: 'state' } }),
          f({ id: 'b', key: 'other', value: { source: 'path', path: 'cost_type' } })
        ]
      }),
      f({
        id: 'c',
        key: 'note',
        value: {
          source: 'path',
          path: 'record.note',
          transforms: [{ op: 'trim' }],
          fallbacks: [{ source: 'fixed', value: '  fallback  ' }]
        }
      })
    ])
    const liquid = specToLiquid(s, { scopeKeys: ['record', 'state'] })
    const out = await renderLiquid(liquid, {
      record: { lines: [{ state: 'from item' }, { x: 1 }], cost_type: 'Capital', note: '   ' },
      state: { label: 'S' }
    })
    expect(out).toEqual({
      lines: [
        { state: 'from item', other: 'Capital' },
        // no item field: the scope key (an object, so text is null)
        { state: null, other: 'Capital' }
      ],
      note: 'fallback'
    })
  })

  it('refuses a list sort with the path (cannot be expressed exactly)', async () => {
    const s = spec([
      f({
        id: 'l',
        key: 'orderLines',
        type: 'list',
        list: { source: 'context.materials', item: 'line', sort: '-quantity' },
        children: [f({ id: 'q', key: 'q', value: { source: 'path', path: 'line.quantity' } })]
      })
    ])
    expect(() => specToLiquid(s)).toThrow(/sort/i)
    const res = await convertIfEqual(s, [{ context: { materials: [] } }])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.diffs).toHaveLength(1)
    expect(res.diffs[0]).toMatchObject({ index: -1, path: 'orderLines' })
    expect(res.diffs[0].message).toMatch(/sort/i)
  })

  it('refuses related-row rules and case-changing transforms on a secret', async () => {
    const related = spec([
      f({
        id: 'a',
        key: 'hasLines',
        include: { when: [{ field: 'lines:workflow', op: 'related_some', value: null }] },
        value: { source: 'fixed', value: 'y' }
      })
    ])
    const r1 = await convertIfEqual(related, [{ record: {} }])
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.diffs[0].path).toBe('hasLines')
    const secret = spec([
      f({
        id: 's',
        key: 'auth',
        type: 'object',
        children: [
          f({
            id: 's1',
            key: 'token',
            value: { source: 'secret', name: 'token', transforms: [{ op: 'upper' }] }
          })
        ]
      })
    ])
    const r2 = await convertIfEqual(secret, [{ record: {} }])
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.diffs[0].path).toBe('auth.token')
  })

  it('refuses with the differing paths when the outputs are not equal', async () => {
    // The map walks into JSON text (an MSSQL JSON column); Liquid cannot.
    const s = spec([
      f({ id: 'a', key: 'id', value: { source: 'path', path: 'record.id' } }),
      f({ id: 'b', key: 'cifa', value: { source: 'path', path: 'record.cifa_data.cifa_number' } })
    ])
    const res = await convertIfEqual(s, [
      { record: { id: 'x', cifa_data: { cifa_number: 'C-1' } } },
      { record: { id: 'y', cifa_data: '{"cifa_number":"C-2"}' } }
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.diffs).toEqual([{ index: 1, path: 'cifa', map: 'C-2', liquid: null }])
  })
})

describe('convertTemplate', () => {
  it('refuses an invalid spec and an empty record set', async () => {
    const bad = await convertTemplate({ v: 1, fields: [{ id: '', key: 'a' }] } as never, [{}])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.diffs[0].message).toMatch(/id/)
    const none = await convertTemplate(spec([f({ id: 'a', key: 'a' })]), [])
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.diffs[0].message).toMatch(/record/i)
  })

  it('returns the Liquid when every record renders the same', async () => {
    const s = spec([f({ id: 'a', key: 'a', value: { source: 'path', path: 'record.a' } })])
    const res = await convertTemplate(s, [{ record: { a: 1 } }, { record: { a: 'x' } }])
    expect(res.ok).toBe(true)
    if (res.ok) expect(typeof res.liquid).toBe('string')
  })
})
