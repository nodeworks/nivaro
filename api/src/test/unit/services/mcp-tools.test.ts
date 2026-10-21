import { describe, expect, it } from 'vitest'
import {
  declaredInputs,
  MAX_NAMED_TOOLS,
  namedToolVisible,
  normalizeNamedTool,
  paramsToSchema,
  validateNamedTools
} from '../../../services/mcp-tools.js'

const query = {
  name: 'open_spend',
  description: 'Open spend by zone.',
  kind: 'custom_query',
  ref: 'open-spend',
  access: 'authenticated',
  read_only: true
}

describe('normalizeNamedTool (#2464)', () => {
  it('keeps a query tool and defaults access to admin, enabled to true', () => {
    const out = normalizeNamedTool({ ...query, access: 'everyone', params: [{ name: 'x' }] })
    expect('tool' in out && out.tool).toEqual({
      name: 'open_spend',
      description: 'Open spend by zone.',
      kind: 'custom_query',
      ref: 'open-spend',
      access: 'admin',
      read_only: true,
      enabled: true
    })
  })

  it('keeps a flow tool’s declared params, typed', () => {
    const out = normalizeNamedTool({
      name: 'raise_po',
      description: 'Raise a PO.',
      kind: 'flow',
      ref: 'F-1',
      params: [
        { name: 'amount', type: 'number', required: true },
        { name: 'note', type: 'weird' }
      ]
    })
    expect('tool' in out && out.tool.params).toEqual([
      { name: 'amount', type: 'number', required: true },
      { name: 'note', type: 'string' }
    ])
  })

  it('refuses bad names, kinds, refs, empty descriptions and duplicate params', () => {
    expect(normalizeNamedTool({ ...query, name: 'Open Spend' })).toHaveProperty('error')
    expect(normalizeNamedTool({ ...query, kind: 'sql' })).toHaveProperty('error')
    expect(normalizeNamedTool({ ...query, ref: '' })).toHaveProperty('error')
    expect(normalizeNamedTool({ ...query, description: ' ' })).toHaveProperty('error')
    expect(
      normalizeNamedTool({
        name: 'f_tool',
        description: 'd',
        kind: 'flow',
        ref: 'x',
        params: [{ name: 'a' }, { name: 'a' }]
      })
    ).toHaveProperty('error')
  })
})

describe('validateNamedTools', () => {
  it('refuses reserved names and duplicates; caps the list', () => {
    expect(validateNamedTools([query], new Set(['open_spend']))).toHaveProperty('error')
    expect(validateNamedTools([query, query], new Set())).toHaveProperty('error')
    expect(validateNamedTools('x', new Set())).toHaveProperty('error')
    const many = Array.from({ length: MAX_NAMED_TOOLS + 1 }, (_, i) => ({
      ...query,
      name: `t_${i}x`
    }))
    expect(validateNamedTools(many, new Set())).toHaveProperty('error')
    const ok = validateNamedTools([query], new Set(['whoami']))
    expect('tools' in ok && ok.tools).toHaveLength(1)
  })
})

describe('paramsToSchema', () => {
  it('maps query param types; a default makes a required param optional', () => {
    expect(
      paramsToSchema([
        { name: 'year', type: 'integer', required: true },
        { name: 'zone', type: 'string', required: true, default: 'North' },
        { name: 'from', type: 'date' },
        { name: 'open', type: 'boolean', description: 'Open only' },
        { name: 'bad name', type: 'string' }
      ])
    ).toEqual({
      type: 'object',
      properties: {
        year: { type: 'integer' },
        zone: { type: 'string', description: 'Default "North".' },
        from: { type: 'string', format: 'date' },
        open: { type: 'boolean', description: 'Open only' }
      },
      required: ['year']
    })
  })
})

describe('namedToolVisible — who sees a named tool', () => {
  it('admins see every enabled tool; others only authenticated tools over a non-admin query', () => {
    const t = { access: 'authenticated' as const, enabled: true }
    expect(namedToolVisible(t, true, 'admin')).toBe(true)
    expect(namedToolVisible(t, false, 'authenticated')).toBe(true)
    expect(namedToolVisible(t, false, 'admin')).toBe(false)
    expect(namedToolVisible({ ...t, access: 'admin' }, false, 'authenticated')).toBe(false)
    expect(namedToolVisible({ ...t, enabled: false }, true)).toBe(false)
    // Flow tools carry no query access level.
    expect(namedToolVisible(t, false)).toBe(true)
  })
})

describe('declaredInputs', () => {
  it('keeps only the inputs the schema declares', () => {
    expect(
      declaredInputs(
        { properties: { year: {}, zone: {} } },
        { year: 2026, sql: 'DROP', zone: undefined }
      )
    ).toEqual({ year: 2026 })
  })
})
