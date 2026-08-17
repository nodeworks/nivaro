import { describe, expect, it } from 'vitest'
import {
  type AutoIdLookups,
  extractSuffix,
  parseAutoIdPattern,
  renderAutoIdPattern,
  resolveAutoIdTokens,
  resolveAutoIdTokensDetailed,
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
  it('accepts seq-less patterns (pure template fields)', () => {
    // Seq-less auto_id is a real feature (workflows.name) — no {seq} is valid.
    expect(validateAutoIdPattern('{project.name}-X')).toBeNull()
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
  },
  // regions alias + its junction companion leg. The leg carries junction_field
  // as the pairing marker (real nivaro_relations shape) — the target-collection
  // lookup must NOT filter it out.
  {
    many_collection: 'workflows_regions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'regions',
    junction_field: 'regions_id'
  },
  {
    many_collection: 'workflows_regions',
    many_field: 'regions_id',
    one_collection: 'regions',
    one_field: null,
    junction_field: 'workflows_id'
  }
]

const rows: Record<string, Record<string, Record<string, unknown>>> = {
  projects: { '123': { id: 123, project_type: 7 } },
  project_types: { '7': { id: 7, short_code: 'CR' } },
  workflows: { '55': { id: 55, project: 123 } },
  regions: { '11': { id: 11, short_code: 'BS' } }
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
      : junction === 'workflows_regions' &&
          String(parentId) === '55' &&
          fk === 'workflows_id' &&
          valueField === 'regions_id'
        ? 11
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

describe('junction-triggered recompute (M2O own-row DB fallback)', () => {
  const parsed = parseAutoIdPattern(
    '{project.project_type.short_code}{funding_years[0] % 100}-{seq}'
  )

  it('resolves the M2O token via own-row fallback when mergedValues is empty', async () => {
    // Mirrors recomputeJunctionAutoIds in items.ts: it recomputes with
    // mergedValues `{}` (no draft), relying on `recordId` for both the plain
    // M2O hop (`project`) and the firstIsMany M2M hop (`funding_years`).
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: {},
      recordId: 55,
      lookups,
      seqValue: '76800'
    })
    expect(out).toBe('CR26-76800')
  })

  it('leaves an explicit-null draft value unresolved (does not fall back to the DB)', async () => {
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: { project: null },
      recordId: 55,
      lookups,
      seqValue: '76800'
    })
    expect(out).toBe('26-76800')
  })
})

describe('multi-segment M2M tokens ({regions[0].short_code})', () => {
  // Regression: the path AFTER a resolved M2M id resolves against the
  // junction's TARGET collection. The old hop loop looked for an M2O column
  // named after the alias on the PARENT collection, so every multi-segment
  // M2M token rendered empty on recompute — editing a workflow's description
  // silently stripped the region prefix off its name.
  const parsed = parseAutoIdPattern('{regions[0].short_code}{funding_years[0] % 100}-{seq}')

  it('resolves via junction + target row on recompute (no draft values)', async () => {
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: {},
      recordId: 55,
      lookups,
      seqValue: '76800'
    })
    expect(out).toBe('BS26-76800')
  })

  it('resolves via target row when the draft supplies the id array', async () => {
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: { regions: [11], funding_years: [2026] },
      lookups,
      seqValue: '####'
    })
    expect(out).toBe('BS26-####')
  })

  it('renders empty when the record has no junction rows', async () => {
    const out = await resolveAutoIdTokens(parsed, {
      collection: 'workflows',
      values: {},
      recordId: 999,
      lookups,
      seqValue: '1'
    })
    // Record 999 has no junction rows for EITHER alias, so both tokens
    // render empty rather than throwing.
    expect(out).toBe('-1')
  })
})

describe('resolveAutoIdTokensDetailed completeness', () => {
  const parsed = parseAutoIdPattern(
    '{project.project_type.short_code}{funding_years[0] % 100}-{seq}'
  )

  it('complete when every relation token resolves', async () => {
    const { rendered, complete } = await resolveAutoIdTokensDetailed(parsed, {
      collection: 'workflows',
      values: { project: 123, funding_years: [2026] },
      lookups,
      seqValue: '####'
    })
    expect(rendered).toBe('CR26-####')
    expect(complete).toBe(true)
  })

  it('incomplete when any relation token renders empty', async () => {
    const { rendered, complete } = await resolveAutoIdTokensDetailed(parsed, {
      collection: 'workflows',
      values: { funding_years: [2026] },
      lookups,
      seqValue: '####'
    })
    expect(rendered).toBe('26-####')
    expect(complete).toBe(false)
  })
})
