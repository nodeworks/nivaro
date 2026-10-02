// Traffic Map drill-down Task 8: investigation input cleaning, edit permission, explain prompt.
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_MAX,
  canEditInvestigation,
  cleanContext,
  cleanNotes,
  cleanStack,
  cleanTitle,
  explainActivityLabel,
  explainContextOf,
  explainUserMessage
} from './actions-logic.js'

const U1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const U2 = '11111111-2222-4333-8444-555555555555'

describe('cleanStack', () => {
  it('accepts the page URL form', () => {
    expect(cleanStack(`request:${U1}@1800000000000/caller:k12/entity:items%2Fworkflows`)).toBe(
      `request:${U1}@1800000000000/caller:k12/entity:items%2Fworkflows`
    )
  })
  it('refuses empty, malformed, too long and too deep stacks', () => {
    expect(cleanStack('')).toBeNull()
    expect(cleanStack(42)).toBeNull()
    expect(cleanStack('Request:x')).toBeNull()
    expect(cleanStack('request:')).toBeNull()
    expect(cleanStack('request:a b')).toBeNull()
    expect(cleanStack('request:x@soon')).toBeNull()
    expect(cleanStack(`entity:${'x'.repeat(4000)}`)).toBeNull()
    expect(cleanStack(Array.from({ length: 9 }, (_, i) => `entity:e${i}`).join('/'))).toBeNull()
  })
})

describe('titles, notes, context', () => {
  it('cleans a title to one capped line', () => {
    expect(cleanTitle('  slow \n  writes  ')).toBe('slow writes')
    expect(cleanTitle('x'.repeat(300))).toHaveLength(200)
    expect(cleanTitle(undefined)).toBe('')
  })
  it('keeps notes, empty is null', () => {
    expect(cleanNotes('  ')).toBeNull()
    expect(cleanNotes('a\nb')).toBe('a\nb')
    expect(cleanNotes(null)).toBeNull()
  })
  it('stores context as JSON text, refuses invalid and oversized', () => {
    expect(cleanContext(undefined)).toBeUndefined()
    expect(cleanContext(null)).toBeNull()
    expect(cleanContext({ levels: [] })).toBe('{"levels":[]}')
    expect(cleanContext('{"a":1}')).toBe('{"a":1}')
    expect(() => cleanContext('{not json')).toThrow('invalid')
    expect(() => cleanContext({ big: 'x'.repeat(CONTEXT_MAX) })).toThrow('too_big')
  })
})

describe('canEditInvestigation', () => {
  it('lets the saver and admins edit, nobody else', () => {
    const row = { id: U1, created_by: U1.toUpperCase() }
    expect(canEditInvestigation(row, U1, false)).toBe(true)
    expect(canEditInvestigation(row, U2, false)).toBe(false)
    expect(canEditInvestigation(row, U2, true)).toBe(true)
    expect(canEditInvestigation({ id: U1, created_by: null }, U1, false)).toBe(false)
    expect(canEditInvestigation(row, null, false)).toBe(false)
  })
})

describe('explain', () => {
  it('needs a levels array', () => {
    expect(explainContextOf(null)).toBeNull()
    expect(explainContextOf({ levels: [] })).toBeNull()
    expect(explainContextOf([1])).toBeNull()
    expect(explainContextOf({ levels: [{ kind: 'request' }] })).not.toBeNull()
  })
  it('cuts the context and labels the activity with kinds only', () => {
    const ctx = {
      levels: [{ kind: 'request', title: 'GET x' }, { kind: 'trace' }],
      pad: 'y'.repeat(100)
    }
    const msg = explainUserMessage(ctx, 40)
    expect(msg).toContain('2 levels')
    expect(msg).toContain('… (cut)')
    expect(explainActivityLabel(ctx)).toBe('Explain: request › trace')
  })
})
