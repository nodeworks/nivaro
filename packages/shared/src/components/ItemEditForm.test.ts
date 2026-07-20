import { describe, expect, it } from 'vitest'
import { applyLayoutDefaults } from './ItemEditForm'

describe('applyLayoutDefaults', () => {
  it('fills keys absent from the draft', () => {
    const draft = { name: 'Acme' }
    const result = applyLayoutDefaults(draft, { status: 'draft', priority: 'low' })
    expect(result).toEqual({ name: 'Acme', status: 'draft', priority: 'low' })
  })

  it('fills keys that are null or undefined in the draft', () => {
    const draft = { status: null, priority: undefined }
    const result = applyLayoutDefaults(draft, { status: 'draft', priority: 'low' })
    expect(result).toEqual({ status: 'draft', priority: 'low' })
  })

  it('leaves keys already set, including falsy-but-defined values', () => {
    const draft = { count: 0, active: false, note: '', status: 'open' }
    const result = applyLayoutDefaults(draft, {
      count: 5,
      active: true,
      note: 'ignored',
      status: 'draft'
    })
    expect(result).toEqual({ count: 0, active: false, note: '', status: 'open' })
  })

  it('tolerates a null defaults object', () => {
    const draft = { name: 'Acme' }
    expect(applyLayoutDefaults(draft, null)).toEqual({ name: 'Acme' })
  })

  it('tolerates an undefined defaults object', () => {
    const draft = { name: 'Acme' }
    expect(applyLayoutDefaults(draft, undefined)).toEqual({ name: 'Acme' })
  })

  it('does not mutate the original draft', () => {
    const draft = { name: 'Acme' }
    applyLayoutDefaults(draft, { status: 'draft' })
    expect(draft).toEqual({ name: 'Acme' })
  })
})
