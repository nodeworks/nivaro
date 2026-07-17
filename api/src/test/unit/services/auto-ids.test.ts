import { describe, expect, it } from 'vitest'
import {
  type AutoIdLookups,
  extractSuffix,
  parseAutoIdPattern,
  renderAutoIdPattern,
  resolveAutoIdTokens,
  validateAutoIdPattern
} from '../../../services/auto-ids.js'

const WF = '{project.project_type.short_code}{funding_years[0] % 100}-{seq}'

describe('parseAutoIdPattern', () => {
  it('parses relation, modulo, and seq tokens with literals', () => {
    const p = parseAutoIdPattern(WF)
    expect(p.tokens).toHaveLength(3)
    expect(p.tokens[0]).toEqual({
      raw: '{project.project_type.short_code}',
      kind: 'relation',
      path: ['project', 'project_type', 'short_code'],
      firstIsMany: false,
      mod: null
    })
    expect(p.tokens[1]).toEqual({
      raw: '{funding_years[0] % 100}',
      kind: 'relation',
      path: ['funding_years'],
      firstIsMany: true,
      mod: 100
    })
    expect(p.tokens[2]).toEqual({ raw: '{seq}', kind: 'seq', name: 'seq' })
    expect(p.literals).toEqual(['', '', '-', ''])
    expect(p.separator).toBe('-')
  })

  it('parses legacy date tokens', () => {
    const p = parseAutoIdPattern('INV-{YYYY}{MM}-{seq4}')
    expect(p.tokens.map((t) => t.kind)).toEqual(['date', 'date', 'seq'])
    expect(p.separator).toBe('-')
  })
})

describe('validateAutoIdPattern', () => {
  it('accepts the workflows pattern', () => {
    expect(validateAutoIdPattern(WF)).toBeNull()
  })
  it('rejects missing seq token', () => {
    expect(validateAutoIdPattern('{project.name}-X')).toMatch(/seq/)
  })
  it('rejects seq not final', () => {
    expect(validateAutoIdPattern('{seq}-{project.name}')).toMatch(/final/)
  })
  it('rejects two seq tokens', () => {
    expect(validateAutoIdPattern('{seq}-{seq4}')).toMatch(/one/)
  })
  it('rejects digit literal immediately before seq', () => {
    expect(validateAutoIdPattern('AB2{seq}')).toMatch(/non-digit/)
  })
  it('rejects missing separator before seq', () => {
    expect(validateAutoIdPattern('{project.name}{seq}')).toMatch(/non-digit/)
  })
  it('rejects malformed token', () => {
    expect(validateAutoIdPattern('{project..name}-{seq}')).toMatch(/token/i)
  })
})

describe('renderAutoIdPattern', () => {
  it('zips literals and token values', () => {
    const p = parseAutoIdPattern(WF)
    expect(renderAutoIdPattern(p, ['CR', '26', '76800'])).toBe('CR26-76800')
  })
  it('handles empty token values', () => {
    const p = parseAutoIdPattern(WF)
    expect(renderAutoIdPattern(p, ['CR', '', '76800'])).toBe('CR-76800')
  })
})

describe('extractSuffix', () => {
  const p = parseAutoIdPattern(WF)
  it('takes text after the last separator', () => {
    expect(extractSuffix(p, 'CM22-15305')).toBe('15305')
  })
  it('null when separator absent', () => {
    expect(extractSuffix(p, 'test')).toBeNull()
  })
})

const rels = [
  {
    many_collection: 'workflows',
    many_field: 'project',
    one_collection: 'projects',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'projects',
    many_field: 'project_type',
    one_collection: 'project_types',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'workflows_funding_years',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'funding_years',
    junction_field: 'funding_years_year'
  }
]

const rows: Record<string, Record<string, Record<string, unknown>>> = {
  projects: { '123': { id: 123, project_type: 7 } },
  project_types: { '7': { id: 7, short_code: 'CR' } }
}

const lookups: AutoIdLookups = {
  relationsFor: async () => rels,
  readRow: async (c, id, _f) => rows[c]?.[String(id)] ?? null,
  firstJunctionValue: async (junction, fk, parentId, valueField) =>
    junction === 'workflows_funding_years' &&
    String(parentId) === '55' &&
    fk === 'workflows_id' &&
    valueField === 'funding_years_year'
      ? 2026
      : null
}

describe('resolveAutoIdTokens', () => {
  const parsed = parseAutoIdPattern(
    '{project.project_type.short_code}{funding_years[0] % 100}-{seq}'
  )

  it('walks M2O hops and uses draft array for M2M', async () => {
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: { project: 123, funding_years: [2026] },
      lookups,
      seqValue: '####'
    })
    expect(out).toBe('CR26-####')
  })

  it('resolves M2M via junction when recordId present and no draft value', async () => {
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: { project: 123 },
      recordId: 55,
      lookups,
      seqValue: '76800'
    })
    expect(out).toBe('CR26-76800')
  })

  it('renders empty for unresolvable tokens', async () => {
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: {},
      lookups,
      seqValue: '####'
    })
    expect(out).toBe('-####')
  })

  it('applies modulo to numeric values', async () => {
    const p = parseAutoIdPattern('{funding_years[0] % 100}-{seq}')
    const out = await resolveAutoIdTokens(p, {
      collection: 'workflows',
      values: { funding_years: [2026] },
      lookups,
      seqValue: '1'
    })
    expect(out).toBe('26-1')
  })
})

describe('recompute gating (pure logic exercised through resolveAutoIdTokens)', () => {
  it('re-renders prefix with preserved suffix', async () => {
    const parsed = parseAutoIdPattern(
      '{project.project_type.short_code}{funding_years[0] % 100}-{seq}'
    )
    const suffix = extractSuffix(parsed, 'CM22-15305')
    expect(suffix).toBe('15305')
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: { project: 123, funding_years: [2027] },
      lookups,
      seqValue: suffix as string
    })
    expect(out).toBe('CR27-15305')
  })
})
