// Child / "intermediate" rows read as what they join, never "Unit Workflow 250768"
// (Rob 2026-11-19, Overview → People active today). Every hop is read AS THE VIEWER.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  recordLabelsAsViewer,
  type ViewerLabelDeps
} from '../../../services/record-labels-as-viewer.js'
import {
  cleanLabel,
  parentLinkLabels,
  type RelationalLabelDeps,
  templateHopLabels,
  templatePaths,
  templateSaysSomething
} from '../../../services/relational-labels.js'
import type { User } from '../../../types.js'

const VIEWER = { id: 'V' } as unknown as User

// A generic shape: allocations (unit + line) → lines (parent + number) → orders (number).
const ROWS: Record<string, Record<string, Record<string, unknown>>> = {
  allocations: {
    '250768': { id: 250768, unit: 7, line: 31, amount: 10 },
    '250769': { id: 250769, unit: 8, line: 32, amount: 5 }
  },
  units: { '7': { id: 7, name: 'MARXMB300' }, '8': { id: 8, name: 'HIDDEN-UNIT' } },
  lines: {
    '31': { id: 31, order: 900, line_number: 7 },
    '32': { id: 32, order: 901, line_number: 2 }
  },
  orders: { '900': { id: 900, order_no: 'CM27-81556' }, '901': { id: 901, order_no: 'SECRET' } },
  // No template: a pure child row named by its links.
  pairings: { '5': { id: 5, unit: 7, line: 31 }, '6': { id: 6, unit: 8, line: 32 } }
}
const LINKS: Record<string, Record<string, string>> = {
  allocations: { unit: 'units', line: 'lines', user_created: 'nivaro_users' },
  lines: { order: 'orders' },
  pairings: { user_created: 'nivaro_users', unit: 'units', line: 'lines' }
}
const TEMPLATES: Record<string, string | null> = {
  allocations: '{{unit.name}} -> {{line.order.order_no}}',
  lines: '{{order.order_no}} · Line {{line_number}}',
  orders: '{{order_no}}',
  units: '{{name}}',
  pairings: null
}
// The viewer may not see unit 8 nor order 901 (User Scope / row filter).
const HIDDEN = new Set(['units:8', 'orders:901'])

function deps(over: Partial<RelationalLabelDeps> = {}): RelationalLabelDeps {
  return {
    canRead: async () => true,
    allowedFields: async () => null,
    template: async (c) => TEMPLATES[c] ?? null,
    columns: async (c) => [
      'user_created',
      ...Object.keys(Object.values(ROWS[c] ?? {})[0] ?? { id: 1 })
    ],
    links: async (c) => new Map(Object.entries(LINKS[c] ?? {})),
    read: vi.fn(async (_u: User, c: string, ids: string[], fields: string[]) =>
      ids
        .filter((id) => ROWS[c]?.[id] && !HIDDEN.has(`${c}:${id}`))
        .map((id) => Object.fromEntries(fields.map((f) => [f, ROWS[c][id][f]])))
    ),
    labels: async (_u, refs) =>
      Object.fromEntries(
        refs.map((r) => [
          `${r.collection}:${r.id}`,
          HIDDEN.has(`${r.collection}:${r.id}`)
            ? r.collection === 'units'
              ? 'Units'
              : 'Lines'
            : r.collection === 'units'
              ? String(ROWS.units[r.id]?.name)
              : `CM27-81556 · Line ${ROWS.lines[r.id]?.line_number}`
        ])
      ),
    displayNames: async () =>
      new Map([
        ['units', 'Units'],
        ['lines', 'Lines']
      ]),
    ...over
  }
}

const by = (c: string, ids: string[]) => new Map([[c, new Set(ids)]])

describe('template paths', () => {
  it('reads hops and spots an id-only template', () => {
    expect(templatePaths('{{unit.name}} -> {{line.order.order_no}}')).toEqual([
      ['unit', 'name'],
      ['line', 'order', 'order_no']
    ])
    expect(templateSaysSomething(null)).toBe(false)
    expect(templateSaysSomething('#{{id}}')).toBe(false)
    expect(templateSaysSomething('{{name}}')).toBe(true)
  })

  it('trims what a missing value left at either end', () => {
    expect(cleanLabel('MARXMB300 -> ')).toBe('MARXMB300')
    expect(cleanLabel(' -> CM27-81556')).toBe('CM27-81556')
    expect(cleanLabel(' · Line 7')).toBe('Line 7')
  })
})

describe('templateHopLabels', () => {
  it('resolves every hop as the viewer, one read per collection per level', async () => {
    const d = deps()
    const out = await templateHopLabels(VIEWER, by('allocations', ['250768']), d)
    expect(out).toEqual({ 'allocations:250768': 'MARXMB300 -> CM27-81556' })
    const reads = (d.read as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(reads.sort()).toEqual(['allocations', 'lines', 'orders', 'units'])
  })

  it('a hop the viewer cannot see says nothing — never its value', async () => {
    const out = await templateHopLabels(VIEWER, by('allocations', ['250769']), deps())
    // Unit 8 and order 901 are hidden: nothing of them, no dangling arrow.
    expect(out).toEqual({})
    const lines = await templateHopLabels(VIEWER, by('lines', ['31', '32']), deps())
    expect(lines).toEqual({ 'lines:31': 'CM27-81556 · Line 7', 'lines:32': 'Line 2' })
    expect(JSON.stringify(lines)).not.toContain('SECRET')
  })

  it('a field the viewer may not read is not read at all', async () => {
    const d = deps({
      allowedFields: async (_u, c) => (c === 'units' ? ['id'] : null)
    })
    const out = await templateHopLabels(VIEWER, by('allocations', ['250768']), d)
    expect(out).toEqual({ 'allocations:250768': 'CM27-81556' })
    for (const call of (d.read as ReturnType<typeof vi.fn>).mock.calls)
      if (call[1] === 'units') expect(call[3]).not.toContain('name')
  })

  it('no read permission on the record: nothing', async () => {
    const d = deps({ canRead: async (_u, c) => c !== 'allocations' })
    expect(await templateHopLabels(VIEWER, by('allocations', ['250768']), d)).toEqual({})
  })

  it('plain templates and template-less collections do no work here', async () => {
    const d = deps()
    expect(await templateHopLabels(VIEWER, by('orders', ['900']), d)).toEqual({})
    expect(await templateHopLabels(VIEWER, by('pairings', ['5']), d)).toEqual({})
    expect(d.read).not.toHaveBeenCalled()
  })
})

describe('parentLinkLabels', () => {
  it('names a template-less row by its first two business links', async () => {
    const d = deps()
    const out = await parentLinkLabels(VIEWER, by('pairings', ['5']), d)
    // user_created (a system link) is skipped; unit + line in field order.
    expect(out).toEqual({ 'pairings:5': 'MARXMB300 · CM27-81556 · Line 7' })
  })

  it('a link the viewer cannot see is left out; one left reads "on …"', async () => {
    const out = await parentLinkLabels(VIEWER, by('pairings', ['6']), deps())
    expect(out).toEqual({ 'pairings:6': 'on CM27-81556 · Line 2' })
    expect(out['pairings:6']).not.toContain('HIDDEN')
  })

  it('a template that says something wins', async () => {
    const d = deps()
    expect(await parentLinkLabels(VIEWER, by('allocations', ['250768']), d)).toEqual({})
    expect(d.read).not.toHaveBeenCalled()
  })
})

describe('recordLabelsAsViewer({relational})', () => {
  const base = (over: Partial<ViewerLabelDeps> = {}): ViewerLabelDeps => ({
    linkLabels: async () => ({ 'lines:31': 'Line 7' }),
    displayNames: async () => new Map([['pairings', 'Pairings']]),
    businessColumns: async () => [],
    read: async () => [],
    hopLabels: async () => ({ 'lines:31': 'CM27-81556 · Line 7' }),
    parentLabels: vi.fn(async () => ({ 'pairings:5': 'MARXMB300 · CM27-81556 · Line 7' })),
    ...over
  })

  it('off by default: the plain label, no hop or parent work', async () => {
    const d = base()
    const out = await recordLabelsAsViewer(
      VIEWER,
      [
        { collection: 'lines', id: '31' },
        { collection: 'pairings', id: '5' }
      ],
      d
    )
    expect(out).toEqual({ 'lines:31': 'Line 7', 'pairings:5': 'Pairings' })
    expect(d.parentLabels).not.toHaveBeenCalled()
  })

  it('on: a hop template beats its plain half; parents only for the unlabelled', async () => {
    const d = base()
    const out = await recordLabelsAsViewer(
      VIEWER,
      [
        { collection: 'lines', id: '31' },
        { collection: 'pairings', id: '5' }
      ],
      d,
      { relational: true }
    )
    expect(out).toEqual({
      'lines:31': 'CM27-81556 · Line 7',
      'pairings:5': 'MARXMB300 · CM27-81556 · Line 7'
    })
    // Only the row nothing else named was asked about.
    expect(d.parentLabels).toHaveBeenCalledWith(VIEWER, new Map([['pairings', new Set(['5'])]]))
  })
})
