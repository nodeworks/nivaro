import { describe, expect, it } from 'vitest'
import {
  extractSuffix,
  parseAutoIdPattern,
  renderAutoIdPattern,
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
